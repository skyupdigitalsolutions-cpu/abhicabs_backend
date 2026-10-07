'use strict';

/**
 * src/services/city.service.js
 *
 * Admin CRUD for cities — the rows the rate-card editor, the quote engine and
 * dispatch all key off.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE DID NOT EXIST UNTIL NOW
 * ---------------------------------------------------------------------------
 * Bengaluru was inserted by day1-constraints.sql and nothing ever needed a
 * second city, so there was no write path at all — `prisma.city` appeared in
 * src/ only as findMany, findUnique and findFirst. Opening a new city meant
 * hand-writing SQL against production. quote.service already anticipated this
 * file by name: `invalidatePriceable` is documented as "exported so a city
 * admin service — when one exists — can make a new city quotable immediately".
 * This is that service, and it calls it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CACHES
 * ---------------------------------------------------------------------------
 * A city is read through three separate caches, and a write that clears only
 * some of them produces the worst kind of bug: the city appears in the admin
 * list, and quotes still refuse it for up to six hours.
 *
 *   quote.PRICEABLE_KEY   the quotable-cities gate. 50s TTL, so it would heal
 *                         on its own — but 50 seconds of "I just added it and
 *                         it says CITY_NOT_SERVICED" is how an admin concludes
 *                         the feature is broken.
 *   cache.keys.citiesActive()  the list resolveOperatingCity scans to pick the
 *                         nearest city. TTL.STATIC — six hours.
 *   cache.keys.city(id)   the single-city read behind getCity. Also six hours,
 *                         and it caches the row itself, so a radius edit that
 *                         misses this one keeps pricing against the old radius.
 *
 * All three go through `invalidate()` below. Nothing here writes to the
 * database without calling it.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS EVER DELETED
 * ---------------------------------------------------------------------------
 * Same rule as rate cards and service states. A city is a foreign key on
 * bookings, vehicles, fare_configs and rental_packages; deleting one would
 * either fail on the constraint or orphan the evidence for what a customer was
 * charged. DELETE deactivates.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const cache = require('./cache.service');
const quote = require('./quote.service');
const audit = require('./audit.service');
const serviceArea = require('../lib/serviceArea');
const areaRadius = require('./areaRadius.service');

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

/**
 * Prisma hands back Decimal objects, which JSON.stringify renders as strings.
 * The admin form would receive "12.9716" where it expects 12.9716, and every
 * comparison in it would quietly become string comparison.
 *
 * Safe for these three columns specifically: Decimal(10,7) coordinates and a
 * Decimal(4,2) percentage are all far inside the range a double represents
 * exactly.
 */
const DECIMALS = ['centreLat', 'centreLng', 'welfareFeePct'];

function serialise(row) {
  if (!row) return null;
  const out = { ...row };
  for (const k of DECIMALS) {
    if (out[k] != null) out[k] = Number(out[k]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Cache invalidation
 * ------------------------------------------------------------------ */

/**
 * Clear every cache that can hold a stale view of this city.
 *
 * Called after EVERY write. Takes the id so the single-city key can go too;
 * pass nothing on a create, where no such key can exist yet.
 */
async function invalidate(cityId) {
  await cache.del(cache.keys.citiesActive());
  if (cityId != null) await cache.del(cache.keys.city(cityId));
  // The quotable gate. Reaching for quote.service's key name from here would
  // work and would rot the first time it changed, which is why it is exported.
  await quote.invalidatePriceable();
}

/* ------------------------------------------------------------------ *
 * Validation that needs the database or the allowlist
 * ------------------------------------------------------------------ */

/**
 * Catch a swapped latitude and longitude.
 *
 * This is the single most common coordinate mistake and it is almost invisible
 * once stored: the city simply never matches a pickup, and the quote engine
 * reports CITY_NOT_SERVICED as though the configuration were missing rather
 * than wrong.
 *
 * India spans roughly 6-38°N and 68-98°E, so the two ranges barely overlap —
 * a swap puts the latitude at 72, which no Indian city has. Only applied when
 * country is IN; anywhere else this would be nonsense.
 */
function assertPlausibleCoordinates({ centreLat, centreLng, country }) {
  if ((country || 'IN') !== 'IN') return;

  const lat = Number(centreLat);
  const lng = Number(centreLng);

  if (lat < 6 || lat > 38 || lng < 68 || lng > 98) {
    throw ApiError.badRequest(
      `(${lat}, ${lng}) is not in India — check the order, it is (latitude, longitude). ` +
        'Ahmedabad, for example, is 23.0225, 72.5714.',
      'IMPLAUSIBLE_COORDINATES',
    );
  }
}

/**
 * localRadiusKm must not exceed radiusKm.
 *
 * Reach has to be at least as large as the city, or a drop can be "inside the
 * city" and simultaneously outside the area we will send a car to — which the
 * downgrade-to-local logic has no way to express.
 */
function assertRadii(radiusKm, localRadiusKm) {
  if (radiusKm != null && localRadiusKm != null && Number(localRadiusKm) > Number(radiusKm)) {
    throw ApiError.badRequest(
      `localRadiusKm (${localRadiusKm}) cannot be larger than radiusKm (${radiusKm}) — ` +
        'the city would extend beyond the area cars are sent to',
      'RADII_INVERTED',
    );
  }
}

/** The unique key is (name, state). Check first so P2002 becomes a sentence. */
async function assertNameFree(name, state, exceptId = null) {
  const clash = await prisma.city.findFirst({
    where: {
      name,
      state,
      ...(exceptId ? { id: { not: Number(exceptId) } } : {}),
    },
  });
  if (clash) {
    throw ApiError.conflict(
      `${name}, ${state} already exists` +
        (clash.isActive ? '' : ' but is deactivated — reactivate it instead of creating a second row'),
      'CITY_EXISTS',
    );
  }
}

/**
 * Is this city's state one the fleet may source a car from?
 *
 * A WARNING, not an error. Creating the city row before the permit clears is a
 * legitimate thing to do — you want the rate cards ready for the day it does.
 * But a city in an unlisted state silently rejects every pickup with
 * OUTSIDE_SERVICE_STATES, so saying nothing would let someone configure a city
 * fully and then spend an afternoon wondering why nothing quotes.
 */
async function stateWarning(state) {
  const canonical = await serviceArea.canonicalState(state);
  if (canonical) return null;

  const allowed = await serviceArea.allowedStateNames();
  return (
    `${state} is not on the service-state allowlist, so pickups there will be refused ` +
    `(OUTSIDE_SERVICE_STATES) and turned into booking requests. Currently allowed: ` +
    `${allowed.join(', ')}. Add it with POST /api/v1/admin/service-states.`
  );
}

/* ------------------------------------------------------------------ *
 * Locating a city from its name
 * ------------------------------------------------------------------ */

/**
 * Turn "Surat, Gujarat" into a centre and a radius.
 *
 * areaRadius.suggest already does the hard part: it geocodes the place, takes
 * the radius from the map's administrative footprint, then WIDENS it to cover
 * any airport or existing service area the business has already committed to.
 * That last step is what stops a derived radius from quietly excluding the
 * airport — the single most common pickup a tight radius breaks, and a failure
 * that reports geography (OUTSIDE_SERVICE_AREA) rather than configuration.
 *
 * It was written for the surge-area form and never reached city creation,
 * which is why cities had to be inserted by hand with coordinates someone
 * looked up themselves.
 */
async function resolveCentre({ name, state, centreLat, centreLng, radiusKm, localRadiusKm }) {
  let resolved = null;

  if (centreLat == null || centreLng == null) {
    const s = await areaRadius.suggest({ name, state });
    centreLat = s.centre.lat;
    centreLng = s.centre.lng;
    if (radiusKm == null) radiusKm = s.radiusKm;
    resolved = {
      formattedAddress: s.formattedAddress,
      radiusKm: s.radiusKm,
      derived: s.derived,
      widenedFor: s.widenedFor,
      explanation: s.explanation,
    };
  }

  /*
   * Keep the city limit inside the service radius.
   *
   * localRadiusKm defaults to 25 in the database, and a derived radius can
   * legitimately come back smaller than that for a small town. Letting the
   * column default apply would then produce a city whose limits extend beyond
   * the area cars are sent to — the exact inversion assertRadii refuses when
   * an admin types it by hand, arriving silently through a default instead.
   */
  if (localRadiusKm == null && radiusKm != null) {
    localRadiusKm = Math.min(25, radiusKm);
  }

  return { centreLat, centreLng, radiusKm, localRadiusKm, resolved };
}

/** The same lookup, without writing anything — for a form preview. */
async function suggest({ name, state }) {
  return areaRadius.suggest({ name, state });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

async function list({ includeInactive = false, search, state } = {}) {
  const where = {};
  if (!includeInactive) where.isActive = true;
  if (state) where.state = { equals: state, mode: 'insensitive' };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { district: { contains: search, mode: 'insensitive' } },
    ];
  }

  const cities = await prisma.city.findMany({
    where,
    orderBy: [{ isActive: 'desc' }, { state: 'asc' }, { name: 'asc' }],
    // Counts, because "city exists but cannot quote" is the state an admin
    // most needs to see, and it is invisible from the city row alone.
    include: {
      _count: { select: { fareConfigs: true, rentalPackages: true, vehicles: true } },
    },
  });

  return { cities: cities.map(serialise), total: cities.length };
}

async function getById(id) {
  const city = await prisma.city.findUnique({
    where: { id: Number(id) },
    include: {
      _count: { select: { fareConfigs: true, rentalPackages: true, vehicles: true, bookings: true } },
    },
  });
  if (!city) throw ApiError.notFound('City not found', 'CITY_NOT_FOUND');
  return serialise(city);
}

/* ------------------------------------------------------------------ *
 * Seeding a new city's pricing
 * ------------------------------------------------------------------ */

/**
 * Copy every ACTIVE rate card and rental package from one city to another.
 *
 * Why this is part of create rather than a separate endpoint: a city with no
 * rate cards is not a half-configured city, it is a broken one. getFareConfig
 * throws FARE_CONFIG_MISSING, which surfaces to the rider as a quote failure.
 * Opening a city and pricing it are one operational act, so they are one call.
 *
 * ONE TRANSACTION, not a loop of fareConfig.service.create. Two reasons:
 * twenty-odd cards would otherwise produce twenty audit rows and twenty cache
 * invalidations for a single admin action, and a failure halfway through would
 * leave a city priced for three vehicle classes out of five — which looks
 * exactly like a deliberate decision.
 *
 * effectiveFrom is reset to now. Copying the source's dates would import a
 * price rise that was staged for next month into a city that has no current
 * price at all, leaving it unquotable until that date arrives.
 */
async function copyPricing(fromCityId, toCityId) {
  const [source, target] = await Promise.all([
    prisma.city.findUnique({ where: { id: Number(fromCityId) } }),
    prisma.city.findUnique({ where: { id: Number(toCityId) } }),
  ]);
  if (!source) {
    throw ApiError.badRequest(
      `Cannot copy pricing: city ${fromCityId} does not exist`,
      'SOURCE_CITY_NOT_FOUND',
    );
  }

  const [cards, packages] = await Promise.all([
    prisma.fareConfig.findMany({ where: { cityId: source.id, isActive: true } }),
    prisma.rentalPackage.findMany({ where: { cityId: source.id, isActive: true } }),
  ]);

  const now = new Date();

  /*
   * scopeKey and state are RE-DERIVED for the destination, never copied.
   *
   * They identify the card's scope, so carrying the source's values over would
   * produce rows whose city_id says Mysuru and whose scope_key says
   * 'city:1' — which the fare_configs_scope_shape check constraint rejects
   * outright, failing the whole transaction and leaving the new city unpriced
   * with no obvious reason why.
   *
   * Only CITY cards are copied: the query above filters on cityId, so a
   * statewide card is never duplicated here. It does not need to be — the new
   * city is already covered by its state's card the moment it exists, which is
   * the point of statewide pricing.
   */
  const cardRows = cards.map(({ id, createdAt, cityId, effectiveFrom, scopeKey, state, ...rest }) => ({
    ...rest,
    cityId: toCityId,
    scope: 'CITY',
    scopeKey: `city:${toCityId}`,
    state: target ? target.state : null,
    effectiveFrom: now,
    isActive: true,
  }));

  const packageRows = packages.map(({ id, createdAt, cityId, ...rest }) => ({
    ...rest,
    cityId: toCityId,
    isActive: true,
  }));

  await prisma.$transaction([
    ...(cardRows.length ? [prisma.fareConfig.createMany({ data: cardRows })] : []),
    ...(packageRows.length ? [prisma.rentalPackage.createMany({ data: packageRows })] : []),
  ]);

  return {
    from: { id: source.id, name: source.name, state: source.state },
    rateCards: cardRows.length,
    rentalPackages: packageRows.length,
  };
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function create(input, actor, meta = {}) {
  const { copyFromCityId, ...fields } = input;

  const name = String(fields.name).trim();
  const state = String(fields.state).trim();

  // Name uniqueness FIRST. Geocoding costs a provider call, and there is no
  // point spending one to locate a city that already exists.
  await assertNameFree(name, state);

  const { centreLat, centreLng, radiusKm, localRadiusKm, resolved } = await resolveCentre({
    name,
    state,
    centreLat: fields.centreLat,
    centreLng: fields.centreLng,
    radiusKm: fields.radiusKm,
    localRadiusKm: fields.localRadiusKm,
  });

  // Checked against the RESOLVED values, so a bad geocode is caught by the
  // same guard that catches a typed-in swap.
  assertPlausibleCoordinates({ centreLat, centreLng, country: fields.country });
  assertRadii(radiusKm, localRadiusKm);

  const row = await prisma.city.create({
    data: {
      name,
      state,
      district: fields.district || null,
      ...(fields.country !== undefined ? { country: fields.country } : {}),
      centreLat,
      centreLng,
      ...(radiusKm !== undefined && radiusKm !== null ? { radiusKm } : {}),
      ...(localRadiusKm !== undefined && localRadiusKm !== null ? { localRadiusKm } : {}),
      ...(fields.timezone !== undefined ? { timezone: fields.timezone } : {}),
      ...(fields.languages !== undefined ? { languages: fields.languages } : {}),
      ...(fields.welfareFeePct !== undefined ? { welfareFeePct: fields.welfareFeePct } : {}),
      ...(fields.isActive !== undefined ? { isActive: fields.isActive } : {}),
    },
  });

  let copied = null;
  if (copyFromCityId) copied = await copyPricing(copyFromCityId, row.id);

  // After the pricing copy, not before — the quotable gate caches classes AND
  // cities together, so clearing it first would let it be rebuilt from a city
  // that still had no rate cards.
  await invalidate(row.id);

  audit.recordAsync({
    actor,
    action: audit.ACTIONS.CITY_CREATED,
    entityType: audit.ENTITIES.CITY,
    entityId: row.id,
    after: { ...serialise(row), copiedFrom: copied?.from?.id ?? null },
    meta,
  });

  return {
    city: serialise(row),
    copied,
    // Non-null only when the centre was derived rather than supplied. Carries
    // the explanation verbatim so the form can show WHY the radius is what it
    // is — a number an admin can argue with beats one they trust blindly.
    resolved,
    warning: await stateWarning(state),
  };
}

async function update(id, input, actor, meta = {}) {
  const before = await prisma.city.findUnique({ where: { id: Number(id) } });
  if (!before) throw ApiError.notFound('City not found', 'CITY_NOT_FOUND');

  // Both radii and both coordinates are checked against the MERGED row, not
  // the patch. Raising localRadiusKm alone is only valid against the radiusKm
  // already stored, and validating the patch in isolation would miss it.
  const merged = { ...before, ...input };
  assertPlausibleCoordinates(merged);
  assertRadii(merged.radiusKm, merged.localRadiusKm);

  if (input.name !== undefined || input.state !== undefined) {
    await assertNameFree(
      String(input.name ?? before.name).trim(),
      String(input.state ?? before.state).trim(),
      before.id,
    );
  }

  const row = await prisma.city.update({
    where: { id: Number(id) },
    data: {
      ...(input.name !== undefined ? { name: String(input.name).trim() } : {}),
      ...(input.state !== undefined ? { state: String(input.state).trim() } : {}),
      ...(input.district !== undefined ? { district: input.district || null } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.centreLat !== undefined ? { centreLat: input.centreLat } : {}),
      ...(input.centreLng !== undefined ? { centreLng: input.centreLng } : {}),
      ...(input.radiusKm !== undefined ? { radiusKm: input.radiusKm } : {}),
      ...(input.localRadiusKm !== undefined ? { localRadiusKm: input.localRadiusKm } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.languages !== undefined ? { languages: input.languages } : {}),
      ...(input.welfareFeePct !== undefined ? { welfareFeePct: input.welfareFeePct } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  await invalidate(row.id);

  audit.recordAsync({
    actor,
    action: audit.ACTIONS.CITY_UPDATED,
    entityType: audit.ENTITIES.CITY,
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return {
    city: serialise(row),
    warning: await stateWarning(row.state),
  };
}

/**
 * Deactivates. Never deletes.
 *
 * Refuses to take out the LAST active city: quote.resolveOperatingCity throws
 * NO_SERVICE_CITY when the list is empty, so this would stop every quote in
 * the country. An outage wearing the clothes of a settings change should take
 * a deliberate second step.
 */
async function deactivate(id, actor, meta = {}) {
  const before = await prisma.city.findUnique({ where: { id: Number(id) } });
  if (!before) throw ApiError.notFound('City not found', 'CITY_NOT_FOUND');

  if (before.isActive) {
    const activeCount = await prisma.city.count({ where: { isActive: true } });
    if (activeCount <= 1) {
      throw ApiError.badRequest(
        'Cannot deactivate the last active city — every quote would be refused',
        'LAST_ACTIVE_CITY',
      );
    }
  }

  const row = await prisma.city.update({
    where: { id: Number(id) },
    data: { isActive: false },
  });

  await invalidate(row.id);

  audit.recordAsync({
    actor,
    action: audit.ACTIONS.CITY_DEACTIVATED,
    entityType: audit.ENTITIES.CITY,
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

async function activate(id, actor, meta = {}) {
  const before = await prisma.city.findUnique({ where: { id: Number(id) } });
  if (!before) throw ApiError.notFound('City not found', 'CITY_NOT_FOUND');

  const row = await prisma.city.update({
    where: { id: Number(id) },
    data: { isActive: true },
  });

  await invalidate(row.id);

  audit.recordAsync({
    actor,
    action: audit.ACTIONS.CITY_ACTIVATED,
    entityType: audit.ENTITIES.CITY,
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return {
    city: serialise(row),
    warning: await stateWarning(row.state),
  };
}

module.exports = { list, getById, create, update, deactivate, activate, suggest };