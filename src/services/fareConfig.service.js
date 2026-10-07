'use strict';

/**
 * src/services/fareConfig.service.js
 *
 * Admin CRUD for fare_configs — the rate cards the quote engine prices against.
 *
 * quote.service.getFareConfig caches the resolved card for six hours and its
 * comment already promised that "the admin fare endpoints" invalidate it on
 * write. Every write here calls invalidateFareConfig, so an edited price is
 * live on the next quote instead of up to six hours later.
 *
 * ---------------------------------------------------------------------------
 * SCOPE: A CARD PRICES A CITY, OR A WHOLE STATE
 * ---------------------------------------------------------------------------
 *   scope: 'CITY'   + cityId  -> that city only
 *   scope: 'STATE'  + state   -> every city in that state
 *
 * A city card beats a state card for the same (class, trip type) — see
 * fareLookup.service, which owns that rule and is the only place it exists. So
 * "Rs 16/km everywhere in Karnataka, Rs 19/km in Bengaluru" is two cards, and
 * a city opened next month is priced the moment it is created.
 *
 * ---------------------------------------------------------------------------
 * RETIRE vs DELETE
 * ---------------------------------------------------------------------------
 * deactivate() retires a card and keeps the row: booking.fareBasis holds a
 * price snapshot, but the row it came from is what makes that snapshot
 * checkable six months later in a dispute.
 *
 * destroy() removes it outright, because "retire" was the only option and the
 * rate-card screen had filled up with mistyped cards that nobody could clear.
 * It is a separate endpoint, it refuses anything that would leave a city
 * unpriced, and it writes the full row into the audit log first — so what is
 * lost is the ability to edit it back, not the record that it existed.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const quote = require('./quote.service');
const lookup = require('./fareLookup.service');
const audit = require('./audit.service');

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

/**
 * Prisma returns Decimal objects. JSON.stringify turns them into strings, which
 * means the admin UI receives "450.00" where it expects 450 and every arithmetic
 * comparison in the form silently becomes string concatenation.
 *
 * Converting to Number here is safe for these columns specifically: Decimal(10,2)
 * rupee amounts are far inside the range where a double is exact to the paisa.
 */
const DECIMALS = [
  'baseFare', 'perKm', 'perMinute', 'minimumFare', 'minimumKm', 'cancellationFee',
  'returnEmptyPct', 'waitingPerHour', 'driverAllowance',
  'nightAllowance', 'nightChargePct', 'airportSurcharge',
  'hourlyRate', 'maxSurge', 'minSurge',
];

function serialise(row) {
  if (!row) return null;
  const out = { ...row };
  for (const k of DECIMALS) {
    if (out[k] != null) out[k] = Number(out[k]);
  }
  if (out.city) {
    out.city = {
      id: out.city.id,
      name: out.city.name,
      state: out.city.state,
      isActive: out.city.isActive,
    };
  }
  // What the table column shows. Computed rather than stored: a state renamed
  // in `cities` would otherwise leave stale labels on every card.
  out.scopeLabel = lookup.scopeLabel(row);
  return out;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * Filtering by cityId includes the STATE cards that cover it, by default.
 *
 * Without that, an admin who filters to Mysuru on a state-priced network sees
 * an empty table and concludes the city is unpriced — which is exactly the
 * confusion statewide cards were meant to remove. `includeStatewide=false`
 * narrows it to the city's own cards for the rare "what is overridden here?"
 * question.
 */
async function list(q = {}) {
  const {
    cityId, state, scope, vehicleClass, tripType, search,
    includeInactive = false,
    includeStatewide = true,
    page = 1, limit = 50,
    sortBy = 'effectiveFrom', order = 'desc',
  } = q;

  const where = {};
  if (vehicleClass) where.vehicleClass = vehicleClass;
  if (tripType) where.tripType = tripType;
  if (scope) where.scope = scope;
  if (!includeInactive) where.isActive = true;
  // An exact class filter wins over free-text search — otherwise a stale search
  // box silently overrides the dropdown the admin just used.
  if (search && !vehicleClass) where.vehicleClass = { contains: search, mode: 'insensitive' };

  if (cityId) {
    const city = await prisma.city.findUnique({ where: { id: Number(cityId) } });
    if (!city) throw ApiError.badRequest('City not found', 'CITY_NOT_FOUND');

    const keys = [lookup.cityScopeKey(city.id)];
    if (includeStatewide && city.state) keys.push(lookup.stateScopeKey(city.state));
    where.scopeKey = { in: keys };
  } else if (state) {
    // Everything that prices this state: its statewide cards AND the city
    // cards of its cities, since both are what an admin means by "Karnataka".
    const cities = await lookup.citiesInState(state, { includeInactive: true });
    where.scopeKey = {
      in: [lookup.stateScopeKey(state), ...cities.map((c) => lookup.cityScopeKey(c.id))],
    };
  }

  const [rows, total] = await Promise.all([
    prisma.fareConfig.findMany({
      where,
      include: { city: true },
      // Secondary sorts keep the table readable: cards group by class and trip
      // type, newest rate first within each group.
      orderBy: [{ [sortBy]: order }, { vehicleClass: 'asc' }, { tripType: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.fareConfig.count({ where }),
  ]);

  const items = rows.map(serialise);

  return {
    // Both keys carry the same array. `items` matches the paginated() envelope
    // used elsewhere; `configs` is the name the rate-card screen reads.
    items,
    configs: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}

async function getById(id) {
  const row = await prisma.fareConfig.findUnique({
    where: { id: Number(id) },
    include: { city: true },
  });
  if (!row) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');
  return serialise(row);
}

/**
 * The city list the rate-card screen uses to populate its filter. Lives on this
 * router rather than its own because it exists to serve this screen, and a
 * separate /admin/cities endpoint would need its own permission story.
 */
async function listCities({ includeInactive = false } = {}) {
  const cities = await prisma.city.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: {
      id: true, name: true, state: true, country: true,
      timezone: true, radiusKm: true, isActive: true,
    },
  });
  return { cities, total: cities.length };
}

/**
 * The states the "All cities in…" dropdown offers, each with the cities it
 * would cover.
 *
 * Derived from `cities`, not from a states table, because a state with no
 * cities has nothing to price — offering it would let an admin save a card
 * that silently applies to nobody.
 */
async function listStates(opts = {}) {
  return lookup.listStates(opts);
}

/**
 * Every vehicle class that exists anywhere — on a rate card or on a vehicle.
 *
 * Drawn from the data rather than a hard-coded list because vehicleClass is a
 * free-text column, not an enum. A class added to the fleet must be priceable
 * without a code change.
 */
async function listVehicleClasses() {
  const [fromConfigs, fromVehicles] = await Promise.all([
    prisma.fareConfig.findMany({ distinct: ['vehicleClass'], select: { vehicleClass: true } }),
    prisma.vehicle.findMany({
      where: { isActive: true },
      distinct: ['vehicleClass'],
      select: { vehicleClass: true },
    }),
  ]);

  const classes = [...new Set([
    ...fromConfigs.map((r) => r.vehicleClass),
    ...fromVehicles.map((r) => r.vehicleClass),
  ])].sort();

  return { vehicleClasses: classes, tripTypes: ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'] };
}

/**
 * Which (class x trip type) combinations this city cannot quote.
 *
 * A missing card is invisible until a customer hits FARE_CONFIG_MISSING at the
 * quote step, which looks like a broken app rather than a configuration gap.
 *
 * It now runs through the real resolver instead of its own query, so a city
 * covered only by its state's card reads as covered — which it is. `pricedBy`
 * says which level answered, because "priced by Karnataka" and "priced by its
 * own card" are the two facts an admin opens this screen to tell apart.
 */
async function coverage(cityId) {
  const id = Number(cityId);
  const city = await prisma.city.findUnique({ where: { id } });
  if (!city) throw ApiError.badRequest('City not found', 'CITY_NOT_FOUND');

  const { vehicleClasses, tripTypes } = await listVehicleClasses();

  const checks = [];
  for (const cls of vehicleClasses) {
    for (const tt of tripTypes) {
      checks.push(
        lookup
          .resolveCard({ city, vehicleClass: cls, tripType: tt })
          .then((r) => ({ vehicleClass: cls, tripType: tt, source: r.source, cardId: r.card?.id ?? null })),
      );
    }
  }
  const results = await Promise.all(checks);

  const missing = results.filter((r) => r.source === 'NONE')
    .map(({ vehicleClass, tripType }) => ({ vehicleClass, tripType }));

  return {
    cityId: id,
    city: { id: city.id, name: city.name, state: city.state },
    missing,
    missingCount: missing.length,
    // The full grid, so the screen can mark each cell "own card" / "statewide".
    pricedBy: results.filter((r) => r.source !== 'NONE'),
    statewideCount: results.filter((r) => r.source === 'STATE').length,
  };
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function assertCity(cityId) {
  const city = await prisma.city.findUnique({ where: { id: Number(cityId) } });
  if (!city) throw ApiError.badRequest('City not found', 'CITY_NOT_FOUND');
  return city;
}

/**
 * A state is valid if it has at least one city. Anything else is a typo —
 * "Karnatka" would save cleanly and price nobody, and the admin would only
 * find out when a rider could not book.
 */
async function assertState(state) {
  const cities = await lookup.citiesInState(state, { includeInactive: true });
  if (cities.length === 0) {
    throw ApiError.badRequest(
      `No cities are configured in "${state}" — check the spelling, or add the city first`,
      'STATE_HAS_NO_CITIES',
    );
  }
  return cities;
}

/** Cache invalidation that follows the card's reach, not just its own row. */
async function invalidateFor(card) {
  if (card.scope === 'STATE') {
    // A statewide edit changes the price in every city it covers, and each of
    // those cities has its own cache key. Clearing only the card's own scope
    // would leave every one of them serving the old price for six hours.
    await quote.invalidateFareConfig(null, card.vehicleClass, card.state);
  } else {
    await quote.invalidateFareConfig(card.cityId, card.vehicleClass);
  }
}

async function create(input, actor, meta = {}) {
  const scope = input.scope === 'STATE' ? 'STATE' : 'CITY';

  let city = null;
  let scopeFields;

  if (scope === 'STATE') {
    await assertState(input.state);
    scopeFields = lookup.buildScopeFields({ scope, state: input.state });
  } else {
    city = await assertCity(input.cityId);
    scopeFields = lookup.buildScopeFields({ scope, cityId: city.id, city });
  }

  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();

  // The unique key is (scopeKey, vehicleClass, tripType, effectiveFrom).
  // Checking first turns a P2002 into a sentence an admin can act on — the same
  // second twice is almost always a double-submit, not an intended second card.
  const clash = await prisma.fareConfig.findFirst({
    where: {
      scopeKey: scopeFields.scopeKey,
      vehicleClass: input.vehicleClass,
      tripType: input.tripType,
      effectiveFrom,
    },
  });
  if (clash) {
    throw ApiError.conflict(
      'A rate card for that scope, class and trip type already starts at exactly this time — change the effective-from date or edit the existing card',
      'FARE_CONFIG_EXISTS',
    );
  }

  /*
   * NO returnEmptyPct DEFAULT ANY MORE.
   *
   * This used to force a new ONE_WAY card to 100 — the full return leg — on
   * the grounds that a blank field should not silently halve the fare. That
   * reasoning held while the return leg was how a one-way paid for the
   * driver's empty drive home. It no longer is: the cost is priced into the
   * ONE_WAY per_km rate itself, the engine ignores the column, and the
   * migration zeroed every row.
   *
   * Leaving the default in would be actively harmful. The field is no longer
   * on the admin form, so every card created from here would arrive with
   * returnEmptyPct missing, get silently set to 100, and look — to anyone
   * reading the table later — exactly like a deliberate decision to double
   * one-way fares. The validator strips the key, so the column takes its
   * default of 0 and the card says what it means.
   */
  const { scope: _s, cityId: _c, state: _st, ...rest } = input;
  const data = { ...rest, ...scopeFields, effectiveFrom };

  const row = await prisma.fareConfig.create({ data, include: { city: true } });

  await invalidateFor(row);

  audit.recordAsync({
    actor,
    action: 'FARE_CONFIG_CREATED',
    entityType: 'fare_config',
    entityId: row.id,
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

/**
 * Edits the card in place.
 *
 * Worth knowing: this changes the price of every FUTURE quote off this card,
 * but not one already taken — booking.fareBasis froze a snapshot at quote time,
 * so an in-flight trip settles at the price the customer was shown.
 *
 * If the intent is a price change from a date rather than a correction of a
 * typo, use clone() with a future effectiveFrom instead. The old card keeps
 * explaining the bookings it priced.
 *
 * SCOPE IS NOT EDITABLE. Turning a Bengaluru card into a Karnataka card in
 * place would reprice twenty cities from a form that said "Bengaluru" at the
 * top, and leave Bengaluru's own pricing gone with no record of the swap.
 * Clone it to the new scope and retire the old one.
 */
async function update(id, input, actor, meta = {}) {
  const before = await prisma.fareConfig.findUnique({ where: { id: Number(id) } });
  if (!before) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');

  const data = { ...input };
  if (data.effectiveFrom) data.effectiveFrom = new Date(data.effectiveFrom);

  // Both halves of the surge band have to be checked against the STORED value,
  // not just against each other — an update that only sends minSurge can still
  // invert the band.
  const minSurge = data.minSurge ?? Number(before.minSurge);
  const maxSurge = data.maxSurge ?? Number(before.maxSurge);
  if (minSurge > maxSurge) {
    throw ApiError.badRequest(
      'Minimum surge cannot be above maximum surge',
      'INVALID_SURGE_BAND',
    );
  }

  const row = await prisma.fareConfig.update({
    where: { id: Number(id) },
    data,
    include: { city: true },
  });

  await invalidateFor(row);

  audit.recordAsync({
    actor,
    action: 'FARE_CONFIG_UPDATED',
    entityType: 'fare_config',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

/* ------------------------------------------------------------------ *
 * Removal — what it would break
 * ------------------------------------------------------------------ */

/**
 * Which cities would lose the ability to quote this class + trip type if this
 * card went away.
 *
 * This replaced a count of sibling cards, which asked the wrong question once
 * state cards existed. Retiring Bengaluru's own card is now usually HARMLESS —
 * the Karnataka card catches it — and the old check would have refused it.
 * Retiring the Karnataka card, meanwhile, can break fifteen cities at once and
 * the old check would have waved it through if any single city had its own.
 *
 * So it asks the real question: run the resolver for every affected city with
 * this row excluded, and report who is left with nothing.
 */
async function unpricedIfRemoved(card) {
  const cities = card.scope === 'STATE'
    ? await lookup.citiesInState(card.state)
    : [await prisma.city.findUnique({ where: { id: card.cityId } })].filter(Boolean);

  // An inactive city cannot be quoted anyway, so losing its price is not an
  // outage — it is housekeeping.
  const live = cities.filter((c) => c.isActive);
  if (live.length === 0) return [];

  const keys = new Set();
  for (const c of live) {
    keys.add(lookup.cityScopeKey(c.id));
    if (c.state) keys.add(lookup.stateScopeKey(c.state));
  }

  // One query for every card that could cover any of them, rather than two per
  // city. A state with thirty cities would otherwise be sixty round trips to
  // answer a yes/no question on a DELETE button.
  const candidates = await prisma.fareConfig.findMany({
    where: {
      scopeKey: { in: [...keys] },
      vehicleClass: card.vehicleClass,
      tripType: card.tripType,
      isActive: true,
      effectiveFrom: { lte: new Date() },
      id: { not: card.id },
    },
    select: { scopeKey: true },
  });

  const covered = new Set(candidates.map((c) => c.scopeKey));

  return live
    .filter((c) => !covered.has(lookup.cityScopeKey(c.id))
      && !(c.state && covered.has(lookup.stateScopeKey(c.state))))
    .map((c) => c.name);
}

function removalBlockedError(card, cities, verb) {
  const list = cities.slice(0, 5).join(', ');
  const more = cities.length > 5 ? ` and ${cities.length - 5} more` : '';
  return ApiError.badRequest(
    `${verb} this card would leave ${cities.length} ${cities.length === 1 ? 'city' : 'cities'} `
    + `unable to quote ${card.vehicleClass} ${card.tripType}: ${list}${more}. `
    + 'Create a replacement card first.',
    'LAST_ACTIVE_FARE_CONFIG',
  );
}

/**
 * Retires a card. Keeps the row.
 *
 * Refuses if it would leave a live city unable to quote: that does not produce
 * a cheaper fare, it produces FARE_CONFIG_MISSING and a rider who cannot book
 * at all. That is an outage dressed as a settings change, and it should take a
 * deliberate second step.
 */
async function deactivate(id, actor, meta = {}) {
  const before = await prisma.fareConfig.findUnique({
    where: { id: Number(id) },
    include: { city: true },
  });
  if (!before) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');

  if (before.isActive) {
    const orphans = await unpricedIfRemoved(before);
    if (orphans.length) throw removalBlockedError(before, orphans, 'Retiring');
  }

  const row = await prisma.fareConfig.update({
    where: { id: Number(id) },
    data: { isActive: false },
    include: { city: true },
  });

  await invalidateFor(row);

  audit.recordAsync({
    actor,
    action: 'FARE_CONFIG_DEACTIVATED',
    entityType: 'fare_config',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

async function activate(id, actor, meta = {}) {
  const before = await prisma.fareConfig.findUnique({ where: { id: Number(id) } });
  if (!before) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');

  const row = await prisma.fareConfig.update({
    where: { id: Number(id) },
    data: { isActive: true },
    include: { city: true },
  });

  await invalidateFor(row);

  audit.recordAsync({
    actor,
    action: 'FARE_CONFIG_ACTIVATED',
    entityType: 'fare_config',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

/**
 * Deletes the row for good.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS WHEN deactivate() DID NOT WANT IT TO
 * ---------------------------------------------------------------------------
 * The original rule was "nothing is ever hard-deleted", and the reasoning was
 * sound: a rate card is the evidence for what a customer was charged. It also
 * meant a card created by a typo — wrong class, wrong city, duplicated by a
 * double-click — could only ever be hidden, and the editor filled up with rows
 * an admin had to mentally filter past on every visit. Clutter in the one
 * screen where a wrong number costs real money is its own risk.
 *
 * WHAT MAKES IT SAFE:
 *   • No booking has a foreign key to fare_configs. The price a rider paid is
 *     frozen in booking.fareBasis, which is a JSON snapshot and survives this
 *     untouched — a past invoice still reconciles.
 *   • The whole row is written into the audit log as `before` BEFORE it goes,
 *     so what is destroyed is the ability to EDIT it back, not the record of
 *     what it said or who removed it.
 *   • It refuses anything that would leave a live city unquotable, exactly as
 *     retiring does. `force` overrides that, and is recorded in the audit meta
 *     — the admin screen should make the consequence plain before offering it.
 *
 * Still: retiring is the right default and stays on DELETE /:id. This is a
 * second, explicit endpoint, not a flag on the first.
 */
async function destroy(id, { force = false } = {}, actor, meta = {}) {
  const before = await prisma.fareConfig.findUnique({
    where: { id: Number(id) },
    include: { city: true },
  });
  if (!before) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');

  let orphans = [];
  if (before.isActive) {
    orphans = await unpricedIfRemoved(before);
    if (orphans.length && !force) throw removalBlockedError(before, orphans, 'Deleting');
  }

  const snapshot = serialise(before);

  /*
   * Audit BEFORE the delete, and await it rather than firing it off.
   *
   * recordAsync is right everywhere else — a slow audit write should not hold
   * up a price change. Here it is the only surviving copy of the row, so a
   * process that exits between the delete and the write would destroy the
   * evidence and the record of destroying it in one go.
   */
  await audit.record(prisma, {
    actor,
    action: 'FARE_CONFIG_DELETED',
    entityType: 'fare_config',
    entityId: before.id,
    before: snapshot,
    // record() keeps only ip/userAgent out of `meta`, so the two facts worth
    // keeping about the decision itself go in `after` — where the trail viewer
    // already shows them.
    after: { deleted: true, forced: Boolean(force), wouldOrphanCities: orphans },
    meta,
  });

  await prisma.fareConfig.delete({ where: { id: Number(id) } });

  await invalidateFor(before);

  return {
    deleted: true,
    config: snapshot,
    // Named so the UI can warn rather than just say "done". An empty array is
    // the normal case.
    unpricedCities: orphans,
  };
}

/**
 * Copies a card onto another class, city, state, or a future date.
 *
 * This is how a price rise should be done: clone the live card with next
 * month's effectiveFrom, edit the numbers, leave the current one alone. The
 * quote engine picks the most recent card whose effectiveFrom has passed, so
 * the new price switches itself on at midnight without anyone deploying.
 *
 * It is also how a statewide card becomes a city exception: clone the
 * Karnataka card to Bengaluru, change the per-km, done — the city copy
 * outranks the state one from that moment.
 */
async function clone(id, overrides, actor, meta = {}) {
  const source = await prisma.fareConfig.findUnique({ where: { id: Number(id) } });
  if (!source) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');

  const {
    id: _drop, createdAt: _drop2,
    scope: _s, cityId: _c, state: _st, scopeKey: _k,
    ...copy
  } = source;

  // Scope comes from the overrides if given, otherwise the source's own.
  let scopeInput;
  if (overrides.scope === 'STATE' || (overrides.state && !overrides.cityId)) {
    scopeInput = { scope: 'STATE', state: overrides.state || source.state };
  } else if (overrides.cityId != null) {
    scopeInput = { scope: 'CITY', cityId: Number(overrides.cityId) };
  } else if (source.scope === 'STATE') {
    scopeInput = { scope: 'STATE', state: source.state };
  } else {
    scopeInput = { scope: 'CITY', cityId: source.cityId };
  }

  const payload = {
    ...copy,
    ...scopeInput,
    vehicleClass: overrides.vehicleClass || source.vehicleClass,
    tripType: overrides.tripType || source.tripType,
    effectiveFrom: overrides.effectiveFrom ? new Date(overrides.effectiveFrom) : new Date(),
    isActive: true,
  };

  return create(payload, actor, meta);
}

module.exports = {
  list,
  getById,
  listCities,
  listStates,
  listVehicleClasses,
  coverage,
  create,
  update,
  deactivate,
  activate,
  destroy,
  clone,
};