'use strict';

/**
 * src/lib/geo.js
 *
 * Pure geometry. No network, no database, no state — so it is trivially
 * testable and safe to call thousands of times per second.
 *
 * The important function here is haversine(): it lets us reject an
 * out-of-service-area booking, or estimate whether a trip is plausible, WITHOUT
 * spending a paid maps API call. At scale that pre-filter is the difference
 * between a manageable maps bill and an alarming one.
 */

const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in kilometres — "as the crow flies".
 *
 * Always SHORTER than the real driving distance, which is what makes it safe as
 * a pre-filter: if the straight line already exceeds the service radius, the
 * road distance certainly does, so we can reject without asking the provider.
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  // Accepts EITHER (lat1, lng1, lat2, lng2) or two { lat, lng } objects.
  // Every caller in maps.service passes objects, and the four-argument form
  // alone produced NaN -> null distances with no error raised anywhere.
  if (lat1 !== null && typeof lat1 === 'object') {
    const a = lat1;
    const b = lng1;
    lat1 = a.lat; lng1 = a.lng;
    lat2 = b?.lat; lng2 = b?.lng;
  }

  lat1 = Number(lat1); lng1 = Number(lng1);
  lat2 = Number(lat2); lng2 = Number(lng2);

  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
    throw new TypeError('[geo] haversineKm received a non-numeric coordinate');
  }

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Road distance is longer than straight-line because roads bend, rivers exist,
 * and one-way systems force detours. The ratio is called the detour index.
 *
 * ~1.35 is a reasonable Indian urban average. This is ONLY used for a fallback
 * estimate when the maps provider is unavailable — never for a confirmed fare.
 * A fare quoted from an estimate must be marked as such so the customer is not
 * held to a number the system guessed.
 */
const DETOUR_FACTOR = Number(process.env.GEO_DETOUR_FACTOR || 1.35);

function estimateRoadKm(straightLineKm) {
  return straightLineKm * DETOUR_FACTOR;
}

/**
 * Rough duration estimate from distance, for the same fallback path.
 * Indian city traffic averages far below highway speed; the default assumes
 * mixed urban driving.
 */
const AVG_SPEED_KMPH = Number(process.env.GEO_AVG_SPEED_KMPH || 24);

function estimateDurationMin(roadKm) {
  return (roadKm / AVG_SPEED_KMPH) * 60;
}

function isWithinRadius(lat, lng, centreLat, centreLng, radiusKm) {
  return haversineKm(lat, lng, Number(centreLat), Number(centreLng)) <= radiusKm;
}

/** Compass bearing, 0-360. Useful for "driver heading" on the live map. */
function bearingDeg(lat1, lng1, lat2, lng2) {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI < 0
    ? (Math.atan2(y, x) * 180) / Math.PI + 360
    : (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Rounds a coordinate for use in a cache key.
 *
 * 4 decimal places is about 11 metres. Two pickups from the same building
 * should hit the same cached distance rather than each costing an API call —
 * full precision would make every request a cache miss.
 */
function coordKey(lat, lng, precision = 4) {
  // Accepts EITHER (lat, lng) or a { lat, lng } object.
  //
  // maps.service builds every distance cache key with coordKey(pointObject).
  // With the two-argument form alone that produced "NaN,NaN" for EVERY
  // coordinate, so all trips collapsed to a single cache key and the first
  // cached quote was served to every later customer regardless of destination.
  if (lat !== null && typeof lat === 'object') {
    ({ lat, lng } = lat);
  }

  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('[geo] coordKey received a non-numeric coordinate');
  }

  return `${a.toFixed(precision)},${b.toFixed(precision)}`;
}

/**
 * Accepts EITHER (lat, lng) or a { lat, lng } object.
 *
 * Every caller in maps.service and quote.service passes an object, so the
 * two-argument form alone silently made `lng` undefined -> NaN -> every valid
 * coordinate rejected. Supporting both shapes removes the trap rather than
 * relying on each call site remembering which one is correct.
 */
function isValidCoordinate(lat, lng) {
  if (lat !== null && typeof lat === 'object') {
    ({ lat, lng } = lat);
  }
  const a = Number(lat);
  const b = Number(lng);
  return (
    Number.isFinite(a) && Number.isFinite(b) &&
    a >= -90 && a <= 90 && b >= -180 && b <= 180 &&
    // 0,0 is in the Atlantic — almost always an unset value, not a real place.
    !(a === 0 && b === 0)
  );
}

module.exports = {
  EARTH_RADIUS_KM,
  DETOUR_FACTOR,
  AVG_SPEED_KMPH,
  haversineKm,
  estimateRoadKm,
  estimateDurationMin,
  isWithinRadius,
  bearingDeg,
  coordKey,
  isValidCoordinate,
};