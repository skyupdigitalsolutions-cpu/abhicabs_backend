'use strict';

/**
 * src/services/fareConfig.service.js
 *
 * Admin CRUD for fare_configs — the rate cards the quote engine prices against.
 *
 * quote.service.getFareConfig caches the active card for six hours and its
 * comment already promised that "the admin fare endpoints" invalidate it on
 * write. Those endpoints did not exist until now; this file is the other half
 * of that contract. Every write here calls invalidateFareConfig, so an edited
 * price is live on the next quote instead of up to six hours later.
 *
 * Nothing is ever hard-deleted. A fare card is the evidence for what a customer
 * was charged six months ago — booking.fareBasis holds a snapshot, but the row
 * it came from is what makes the snapshot checkable.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const quote = require('./quote.service');
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
  'baseFare', 'perKm', 'perMinute', 'minimumFare', 'cancellationFee',
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
  return out;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

async function list(q = {}) {
  const {
    cityId, vehicleClass, tripType, search,
    includeInactive = false,
    page = 1, limit = 50,
    sortBy = 'effectiveFrom', order = 'desc',
  } = q;

  const where = {};
  if (cityId) where.cityId = Number(cityId);
  if (vehicleClass) where.vehicleClass = vehicleClass;
  if (tripType) where.tripType = tripType;
  if (!includeInactive) where.isActive = true;
  // An exact class filter wins over free-text search — otherwise a stale search
  // box silently overrides the dropdown the admin just used.
  if (search && !vehicleClass) where.vehicleClass = { contains: search, mode: 'insensitive' };

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
 * Which (class x trip type) combinations have no active card.
 *
 * A missing card is invisible until a customer hits FARE_CONFIG_MISSING at the
 * quote step, which looks like a broken app rather than a configuration gap.
 * This turns it into something the ops team can see before a rider does.
 */
async function coverage(cityId) {
  const id = Number(cityId);
  const [classes, cards] = await Promise.all([
    listVehicleClasses(),
    prisma.fareConfig.findMany({
      where: { cityId: id, isActive: true, effectiveFrom: { lte: new Date() } },
      select: { vehicleClass: true, tripType: true },
    }),
  ]);

  const have = new Set(cards.map((c) => `${c.vehicleClass}|${c.tripType}`));
  const missing = [];
  for (const cls of classes.vehicleClasses) {
    for (const tt of classes.tripTypes) {
      if (!have.has(`${cls}|${tt}`)) missing.push({ vehicleClass: cls, tripType: tt });
    }
  }
  return { cityId: id, missing, missingCount: missing.length };
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function assertCity(cityId) {
  const city = await prisma.city.findUnique({ where: { id: Number(cityId) } });
  if (!city) throw ApiError.badRequest('City not found', 'CITY_NOT_FOUND');
  return city;
}

async function create(input, actor, meta = {}) {
  await assertCity(input.cityId);

  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();

  // The unique key is (cityId, vehicleClass, tripType, effectiveFrom). Checking
  // first turns a P2002 into a sentence an admin can act on — the same second
  // twice is almost always a double-submit, not an intended second card.
  const clash = await prisma.fareConfig.findFirst({
    where: {
      cityId: Number(input.cityId),
      vehicleClass: input.vehicleClass,
      tripType: input.tripType,
      effectiveFrom,
    },
  });
  if (clash) {
    throw ApiError.conflict(
      'A rate card for that city, class and trip type already starts at exactly this time — change the effective-from date or edit the existing card',
      'FARE_CONFIG_EXISTS',
    );
  }

  /*
   * A ONE_WAY card with no return percentage gets the business rule — the
   * full return leg — rather than the column default of 0.
   *
   * 0 means "the return is free", which is a pricing decision, not a blank.
   * Left to the default, every one-way card created from the admin form
   * without that field filled in quietly quoted half the intended fare, and
   * nothing on the quote said so. An explicit value, 0 included, is kept.
   */
  const data = { ...input, effectiveFrom };
  if (data.tripType === 'ONE_WAY' && data.returnEmptyPct == null) {
    data.returnEmptyPct = 100;
  }

  const row = await prisma.fareConfig.create({
    data,
    include: { city: true },
  });

  await quote.invalidateFareConfig(row.cityId, row.vehicleClass);

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

  await quote.invalidateFareConfig(row.cityId, row.vehicleClass);

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

/**
 * Retires a card. Never deletes it.
 *
 * Refuses if it is the last active card for that city + class + trip type:
 * removing it does not produce a cheaper fare, it produces FARE_CONFIG_MISSING
 * and a rider who cannot book at all. That is an outage dressed as a settings
 * change, and it should take a deliberate second step.
 */
async function deactivate(id, actor, meta = {}) {
  const before = await prisma.fareConfig.findUnique({ where: { id: Number(id) } });
  if (!before) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');

  if (before.isActive) {
    const siblings = await prisma.fareConfig.count({
      where: {
        cityId: before.cityId,
        vehicleClass: before.vehicleClass,
        tripType: before.tripType,
        isActive: true,
        effectiveFrom: { lte: new Date() },
        id: { not: before.id },
      },
    });
    if (siblings === 0) {
      throw ApiError.badRequest(
        `This is the only live ${before.tripType} card for ${before.vehicleClass} — retiring it would stop those bookings entirely. Create a replacement first.`,
        'LAST_ACTIVE_FARE_CONFIG',
      );
    }
  }

  const row = await prisma.fareConfig.update({
    where: { id: Number(id) },
    data: { isActive: false },
    include: { city: true },
  });

  await quote.invalidateFareConfig(row.cityId, row.vehicleClass);

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

  await quote.invalidateFareConfig(row.cityId, row.vehicleClass);

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
 * Copies a card onto another class, city, or a future date.
 *
 * This is how a price rise should be done: clone the live card with next
 * month's effectiveFrom, edit the numbers, leave the current one alone. The
 * quote engine picks the most recent card whose effectiveFrom has passed, so
 * the new price switches itself on at midnight without anyone deploying.
 *
 * It is also how a new vehicle class gets priced in one click instead of
 * twenty-four form fields.
 */
async function clone(id, overrides, actor, meta = {}) {
  const source = await prisma.fareConfig.findUnique({ where: { id: Number(id) } });
  if (!source) throw ApiError.notFound('Rate card not found', 'FARE_CONFIG_NOT_FOUND');

  const { id: _drop, createdAt: _drop2, ...copy } = source;

  const payload = {
    ...copy,
    cityId: overrides.cityId != null ? Number(overrides.cityId) : source.cityId,
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
  listVehicleClasses,
  coverage,
  create,
  update,
  deactivate,
  activate,
  clone,
};