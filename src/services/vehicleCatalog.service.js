'use strict';

/**
 * src/services/vehicleCatalog.service.js
 */

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const cache = require('./cache.service');
const storage = require('./storage.service');
const audit = require('./audit.service');

const vehicleModels = require('../data/vehicleModels.json');


const MODELS_FINGERPRINT = crypto
  .createHash('sha1')
  .update(JSON.stringify(vehicleModels.classes || {}))
  .digest('hex')
  .slice(0, 8);

// v5: `tripTypes` joined the serialised shape. A cached v4 entry has no such
// key, and a consumer reading `tripTypes` off it would see undefined and treat
// the class as unrestricted — the exact rule this release adds, silently
// disabled for six hours.
const LIST_KEY = `catalog:vehicles:v5:${MODELS_FINGERPRINT}`;
const TTL = 6 * 60 * 60; // 6h; writes invalidate, so this is only a backstop

const FOLDER = 'vehicle-catalog';


function carsFor(key) {
  const cars = vehicleModels.classes?.[key];
  return Array.isArray(cars) ? cars : [];
}

/** Keeps only entries the app can actually render. */
function usableImages(list) {
  return (Array.isArray(list) ? list : []).filter(
    (i) => i && typeof i.url === 'string' && /^https?:\/\//i.test(i.url),
  );
}

function classImagery(row) {
  const own = usableImages(row.images);
  if (own.length || row.heroUrl) {
    return { images: own, heroUrl: row.heroUrl || own[0]?.url || null };
  }

  const fromCars = carsFor(row.key).flatMap((c) => usableImages(c.images));
  return { images: fromCars, heroUrl: fromCars[0]?.url || null };
}

/** Every trip type a class can be restricted to. */
const TRIP_TYPES = Object.freeze(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']);

/**
 * The stored restriction, cleaned up for the wire.
 *
 * Total and forgiving: the column is JSON, so it can hold anything a bad write
 * or a hand-run UPDATE put there. Garbage reads as "[]" — unrestricted — which
 * is the same answer as an empty list and keeps a malformed row bookable
 * rather than making a vehicle disappear from every screen with no error.
 */
function tripTypesOf(row) {
  const raw = Array.isArray(row?.tripTypes) ? row.tripTypes : [];
  return raw
    .map((t) => String(t || '').trim().toUpperCase())
    .filter((t) => TRIP_TYPES.includes(t));
}

/**
 * May this class be booked for this trip type?
 *
 * EMPTY LIST MEANS ALL. Said once, here, so the rule cannot be half-remembered
 * at the three call sites that need it (the fare list, the single quote, and
 * the public catalogue filter).
 */
function allowsTripType(row, tripType) {
  const allowed = tripTypesOf(row);
  if (!allowed.length) return true;
  return allowed.includes(String(tripType || '').toUpperCase());
}

/**
 * The set of class keys bookable for a trip type.
 *
 * Reads through the same cached list the fare screen uses, so this costs
 * nothing on the hot path. Returns a Set because every caller is doing
 * membership tests inside a loop.
 */
async function allowedClassesFor(tripType) {
  const rows = await list();
  return new Set(
    rows.filter((r) => allowsTripType(r, tripType)).map((r) => r.key),
  );
}

function serialise(row) {
  if (!row) return null;
  const imagery = classImagery(row);
  return {
    key: row.key,
    name: row.name,
    seats: row.seats,
    blurb: row.blurb,
    detail: row.detail,
    luggage: row.luggage,
    glyph: row.glyph,
    transmission: row.transmission,
    fuel: row.fuel,
    /*
     * VARIANT GROUPING — two rows the app should draw as ONE card with a fuel
     * toggle (Swift Dzire Petrol / Swift Dzire CNG).
     *
     * `groupKey` falls back to the row's own key rather than staying null, so
     * the client can group unconditionally: every class belongs to exactly one
     * group, and a class with no variants is a group of one. The alternative —
     * null meaning "ungrouped" — makes every consumer write the same
     * `groupKey ?? key` branch, and the first one to forget it renders a card
     * with no title.
     *
     * `variantLabel` stays null when there is nothing to choose between. Null
     * is the signal to draw no toggle at all, which is not the same as drawing
     * a toggle with one button on it.
     */
    groupKey: row.groupKey || row.key,
    variantLabel: row.variantLabel || null,
    rating: row.rating == null ? null : Number(row.rating),
    trips: row.trips,
    /*
     * Which trip types this class may be booked for. ALWAYS AN ARRAY for the
     * client, whatever the column holds, and an empty one means no
     * restriction — the app must not read `[]` as "bookable for nothing".
     */
    tripTypes: tripTypesOf(row),
    heroUrl: imagery.heroUrl,
    // Always an array for the client, whatever the column holds.
    images: imagery.images,
    cars: carsFor(row.key),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

async function invalidate() {
  await cache.del(LIST_KEY);
}


async function list({ includeInactive = false, tripType = null } = {}) {
  const rows = await listAll({ includeInactive });
  if (!tripType) return rows;
  return rows.filter((r) => allowsTripType(r, tripType));
}

async function listAll({ includeInactive = false } = {}) {
  if (includeInactive) {
    const rows = await prisma.vehicleCatalog.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(serialise);
  }

  return cache.getOrSet(
    LIST_KEY,
    async () => {
      const rows = await prisma.vehicleCatalog.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows.map(serialise);
    },
    { ttl: TTL, cacheNull: false },
  );
}

async function getByKey(key) {
  const row = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!row) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');
  return serialise(row);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function create(input, actor, meta = {}) {
  const existing = await prisma.vehicleCatalog.findUnique({ where: { key: input.key } });
  if (existing) {
    throw ApiError.conflict(
      `A vehicle class with the key "${input.key}" already exists`,
      'VEHICLE_CLASS_EXISTS',
    );
  }

  const row = await prisma.vehicleCatalog.create({ data: input });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_CREATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

async function update(key, input, actor, meta = {}) {
  const before = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!before) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const row = await prisma.vehicleCatalog.update({ where: { key }, data: input });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_UPDATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}


async function deactivate(key, actor, meta = {}) {
  const before = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!before) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const liveFares = await prisma.fareConfig.count({
    where: { vehicleClass: key, isActive: true },
  });
  if (liveFares > 0) {
    throw ApiError.badRequest(
      `${before.name} still has ${liveFares} active rate card(s). Retire those first, or riders can be quoted for a class they cannot see.`,
      'VEHICLE_CLASS_IN_USE',
    );
  }

  const row = await prisma.vehicleCatalog.update({
    where: { key },
    data: { isActive: false },
  });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_DEACTIVATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

/**
 * PERMANENT delete of a vehicle class. No undo.
 *
 * ---------------------------------------------------------------------------
 * WHY RETIRING IS STILL THE NORMAL ANSWER
 * ---------------------------------------------------------------------------
 * `vehicleClass` is a free-text string, not a foreign key — it is written onto
 * bookings, vehicles, rate cards and rental packages as text. So nothing in the
 * database stops this delete, and that is exactly why the checks below have to
 * be explicit: deleting a class that bookings reference does not fail, it
 * silently leaves those bookings naming a class that no longer exists, and
 * every screen that joins the catalogue for a name and a photo renders a blank.
 *
 * Retiring (deactivate) keeps the row and takes the class off the fare screen,
 * which is the right move for a vehicle the business genuinely stopped
 * offering. This is for the other case: a class created by mistake, or a
 * placeholder like the old generic 'sedan' that was never sold and clutters
 * the admin list permanently.
 *
 * REFUSES IF ANYTHING AT ALL REFERENCES IT. Not just active things — a
 * cancelled booking from last year still names the class on its invoice.
 */
async function destroy(key, actor, meta = {}) {
  const before = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!before) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  /*
   * Counted in one round trip rather than four awaited in sequence, and
   * counting EVERY row rather than only active ones.
   *
   * The deactivate path above only checks active rate cards, which is correct
   * for retiring — an inactive card is already out of the way. It is wrong
   * here: an inactive card is still the evidence for what an old booking was
   * charged, and deleting the class it prices leaves that unreadable.
   */
  const [bookings, vehicles, fares, packages] = await Promise.all([
    prisma.booking.count({ where: { vehicleClass: key } }),
    prisma.vehicle.count({ where: { vehicleClass: key } }),
    prisma.fareConfig.count({ where: { vehicleClass: key } }),
    prisma.rentalPackage.count({ where: { vehicleClass: key } }),
  ]);

  const blockers = [
    bookings && `${bookings} booking(s)`,
    vehicles && `${vehicles} vehicle(s) in the fleet`,
    fares && `${fares} rate card(s)`,
    packages && `${packages} rental package(s)`,
  ].filter(Boolean);

  if (blockers.length) {
    throw ApiError.conflict(
      `${before.name} is still referenced by ${blockers.join(', ')}, so deleting it would leave those records naming a class that no longer exists. ` +
        'Retire it instead — it disappears from the app but keeps explaining the trips it priced.',
      'VEHICLE_CLASS_IN_USE',
    );
  }

  /*
   * Images are stored on Cloudinary, not in the row, so deleting the row alone
   * would orphan every file — paid-for storage nobody can reach or audit.
   *
   * Failures here are swallowed deliberately. A file that cannot be removed
   * (already gone, provider down) must not block the delete the admin asked
   * for, and leaving the row behind to keep the images tidy would be the wrong
   * trade. Worth logging so an orphan is at least visible.
   */
  for (const image of usableImages(before.images)) {
    if (!image.publicId) continue;
    try {
      await storage.destroy(image.publicId);
    } catch (err) {
      console.warn(`[vehicleCatalog] Could not delete image ${image.publicId}:`, err.message);
    }
  }

  await prisma.vehicleCatalog.delete({ where: { key } });
  await invalidate();

  /*
   * Audited with the FULL `before` and no `after`, which is what makes this
   * recoverable in practice: the row is gone from the table, but the audit
   * entry holds everything needed to recreate it if the delete was a mistake.
   */
  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_DELETED',
    entityType: 'vehicle_catalog',
    entityId: before.id,
    before: serialise(before),
    after: null,
    meta,
  });

  return serialise(before);
}

async function activate(key, actor, meta = {}) {
  const row = await prisma.vehicleCatalog.update({
    where: { key },
    data: { isActive: true },
  });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_ACTIVATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

async function addImage(key, { buffer, mimetype, label, asHero = false }, actor, meta = {}) {
  const row = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!row) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const uploaded = await storage.uploadImage(buffer, {
    folder: `${FOLDER}/${key}`,
    mimetype,
  });

  let data;
  if (asHero) {
    const previous = row.heroPublicId;
    data = { heroUrl: uploaded.url, heroPublicId: uploaded.publicId };
    if (previous) {
      storage.destroy(previous).catch(() => {
      });
    }
  } else {
    const images = Array.isArray(row.images) ? row.images : [];
    data = {
      images: [
        ...images,
        {
          label: label || `View ${images.length + 1}`,
          url: uploaded.url,
          publicId: uploaded.publicId,
        },
      ],
    };
  }

  const updated = await prisma.vehicleCatalog.update({ where: { key }, data });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_IMAGE_ADDED',
    entityType: 'vehicle_catalog',
    entityId: updated.id,
    after: { key, publicId: uploaded.publicId, asHero },
    meta,
  });

  return serialise(updated);
}


async function removeImage(key, publicId, actor, meta = {}) {
  const row = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!row) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const images = Array.isArray(row.images) ? row.images : [];
  const next = images.filter((i) => i.publicId !== publicId);

  if (next.length === images.length && row.heroPublicId !== publicId) {
    throw ApiError.notFound('That image is not on this vehicle', 'IMAGE_NOT_FOUND');
  }

  const data = { images: next };
  if (row.heroPublicId === publicId) {
    data.heroUrl = null;
    data.heroPublicId = null;
  }

  const updated = await prisma.vehicleCatalog.update({ where: { key }, data });
  await invalidate();
  storage.destroy(publicId).catch(() => {});

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_IMAGE_REMOVED',
    entityType: 'vehicle_catalog',
    entityId: updated.id,
    after: { key, publicId },
    meta,
  });

  return serialise(updated);
}

module.exports = {
  TRIP_TYPES,
  list,
  allowsTripType,
  allowedClassesFor,
  getByKey,
  create,
  update,
  deactivate,
  destroy,
  activate,
  addImage,
  removeImage,
};