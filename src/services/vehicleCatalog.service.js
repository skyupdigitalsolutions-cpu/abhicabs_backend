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

const LIST_KEY = `catalog:vehicles:v3:${MODELS_FINGERPRINT}`;
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
    rating: row.rating == null ? null : Number(row.rating),
    trips: row.trips,
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


async function list({ includeInactive = false } = {}) {
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
  list,
  getByKey,
  create,
  update,
  deactivate,
  destroy,
  activate,
  addImage,
  removeImage,
};