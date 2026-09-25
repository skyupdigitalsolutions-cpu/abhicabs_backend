'use strict';

/**
 * src/services/vehicleCatalog.service.js
 *
 * The rider-facing catalogue of vehicle CLASSES, and its photography.
 *
 * Reads are public and cached hard: this is the first thing the app asks for
 * on the Vehicles screen, it changes when marketing changes it — which is to
 * say rarely — and it is the same answer for every rider in the city. Every
 * write invalidates the cache, so an image uploaded at 11:00 is live on the
 * next request rather than up to a TTL later.
 */

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const cache = require('./cache.service');
const storage = require('./storage.service');
const audit = require('./audit.service');

/*
 * The cars shown under each class — photography, specs, copy. Presentation
 * only; not one price lives in it (see the file's own _readme).
 *
 * require() rather than fs.readFile: Node caches the parse, so this costs one
 * read at boot instead of one per request, and a malformed edit fails the
 * deploy loudly rather than 500-ing the vehicles screen at 2am.
 *
 * The consequence is that editing the file needs a redeploy to take effect.
 * That is the right trade here — it is committed content, reviewed like code,
 * and changes when marketing changes it.
 */
const vehicleModels = require('../data/vehicleModels.json');

/*
 * The cached payload has the JSON file BAKED INTO IT — serialise() merges
 * `cars` before the value is stored. So editing vehicleModels.json and
 * redeploying used to change nothing for up to six hours: the new code kept
 * reading the old Redis value written by the old file.
 *
 * Hashing the file into the key makes an edit a different key. Deploy the
 * edit, the very next request misses, and the old value ages out on its own.
 */
const MODELS_FINGERPRINT = crypto
  .createHash('sha1')
  .update(JSON.stringify(vehicleModels.classes || {}))
  .digest('hex')
  .slice(0, 8);

/** One cache key for the whole active list — it is small and always read whole. */
const LIST_KEY = `catalog:vehicles:v2:${MODELS_FINGERPRINT}`;
const TTL = 6 * 60 * 60; // 6h; writes invalidate, so this is only a backstop

/** Cloudinary subfolder. Kept separate from driver-docs and odometer shots. */
const FOLDER = 'vehicle-catalog';

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

/**
 * Prisma hands back `rating` as a Decimal object, which JSON.stringify turns
 * into a string. The app renders `rating.toFixed(1)`, so a string arrives as
 * "4.80".toFixed — a TypeError. Convert here, once.
 */
/**
 * The cars listed for a class, or [] when the file has no entry for it.
 *
 * Never throws and never invents: a class absent from the JSON renders from
 * its catalogue row alone, exactly as every class did before the file existed.
 */
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

/**
 * The class gallery, and the one shot that represents the class.
 *
 * `vehicle_catalog.images` / `hero_url` are filled by the admin upload route.
 * Photography pasted into vehicleModels.json lands on the CARS instead, and
 * no screen in the rider app reads car images — it reads `images` and
 * `heroUrl`. A class with pictures in the file and an empty column therefore
 * rendered as the glyph, which is what "the images are not showing" was.
 *
 * So the file is a FALLBACK: when the column is empty, the cars' photographs
 * stand in for the class. An admin upload still wins, because that is the
 * shot chosen deliberately to read small.
 */
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
    /*
     * The individual cars of this class, merged from the JSON file.
     *
     * Deliberately NOT a database table. These are photographs and marketing
     * copy that one person edits in bulk; a table would mean an admin screen,
     * a migration per field, and CRUD for content that is reviewed like code.
     * Prices are the opposite and stay in the database, because they are what
     * a customer is charged.
     */
    cars: carsFor(row.key),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

async function invalidate() {
  await cache.del(LIST_KEY);
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * The classes a rider can browse.
 *
 * `includeInactive` exists for the admin screen only. The public route never
 * passes it, so a retired class disappears from the app without being deleted
 * — its bookings still need it to explain themselves.
 */
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

/**
 * Retire a class. Never deletes.
 *
 * Refuses if any ACTIVE fare card still prices it: a class that vanishes from
 * the catalogue while remaining quotable produces a booking for something the
 * rider was never shown. Retire the rate cards first, deliberately.
 */
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

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

/**
 * Upload one photo to Cloudinary and attach it to a class.
 *
 * `asHero: true` replaces the compact-card thumbnail; otherwise the image is
 * appended to the gallery the detail screen swipes through.
 *
 * The old hero is destroyed on replacement. Cloudinary bills by stored bytes,
 * and an orphaned image nothing references is a cost with no reader — but the
 * destroy is deliberately NOT awaited into the failure path: losing the new
 * upload because the cleanup of the old one failed would be the wrong trade.
 */
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
        // Orphaned file, not a failed request. Worth a sweep job, never worth
        // failing an upload the admin has already waited for.
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

/**
 * Remove one gallery image, from the row and from Cloudinary.
 *
 * The row is updated FIRST. If the remote delete then fails the app is already
 * correct and we have leaked a file; doing it the other way round can leave the
 * row pointing at an image that no longer exists, which the app renders as a
 * broken box.
 */
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
  activate,
  addImage,
  removeImage,
};