'use strict';

/**
 * src/services/maps.service.js
 *
 * Everything between the application and the maps provider: caching, a
 * straight-line pre-filter, a circuit breaker, and a fallback to arithmetic.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LAYER EXISTS
 * ---------------------------------------------------------------------------
 * Maps is billed per call and will likely be the second-largest bill after
 * servers. Three things keep that under control, in order of impact:
 *
 *   1. CACHE GEOCODING HARD. The same fifty pickup points repeat thousands of
 *      times a day — every office, mall, and airport terminal in the city. The
 *      answer for a fixed address never changes, so paying twice for it is pure
 *      waste. Geocodes are cached for 30 days.
 *
 *   2. PRE-FILTER WITH ARITHMETIC. A pickup outside the service area, or a
 *      100-metre "trip", can be rejected by haversine before any call is made.
 *      Free locally; billable if you learn it from the provider — including on
 *      every malicious request.
 *
 *   3. CIRCUIT BREAK ON FAILURE. When the provider is down, stop calling it and
 *      fall back to an estimate. Retrying a dead API on every request adds
 *      latency to a failure you already know about.
 */

const crypto = require('crypto');
const geo = require('../lib/geo');
const cache = require('./cache.service');
const { getProvider } = require('./providers/maps.provider');
const { ApiError } = require('../utils/helpers');
const env = require('../config/env');

/* ------------------------------------------------------------------ *
 * Cache policy
 * ------------------------------------------------------------------ */

const TTL = {
  // A fixed address does not move. This is the single highest-value cache in
  // the system — the same office lobby is geocoded thousands of times.
  GEOCODE: 30 * 24 * 3600,   // 30 days

  // Road distance between two fixed points is near-constant; only the DURATION
  // shifts with traffic. Cached for a day; callers needing a live ETA pass
  // fresh:true.
  DISTANCE: 24 * 3600,

  // Suggestions change as places open and close, and the result set is large.
  AUTOCOMPLETE: 3600,
};

const keys = {
  geocode: (address) =>
    `maps:geo:${crypto.createHash('sha1').update(String(address).toLowerCase().trim()).digest('hex').slice(0, 16)}`,
  reverse: (lat, lng) => `maps:rev:${geo.coordKey({ lat, lng })}`,
  distance: (o, d) => `maps:dm:${geo.coordKey(o)}:${geo.coordKey(d)}`,
  autocomplete: (q) => `maps:ac:${String(q).toLowerCase().trim().slice(0, 40)}`,
};

/* ------------------------------------------------------------------ *
 * Circuit breaker
 * ------------------------------------------------------------------ */

const breaker = {
  state: 'closed',        // closed | open | half-open
  failures: 0,
  openedAt: 0,
  threshold: Number(env.maps.breakerThreshold || 5),
  cooldownMs: Number(env.maps.breakerCooldownMs || 30_000),
};

const metrics = {
  geocodeHits: 0, geocodeMisses: 0,
  distanceHits: 0, distanceMisses: 0,
  providerCalls: 0, providerErrors: 0,
  prefilterRejects: 0, fallbackEstimates: 0,
  breakerTrips: 0,
};

function breakerAllows() {
  if (breaker.state !== 'open') return true;
  if (Date.now() - breaker.openedAt >= breaker.cooldownMs) {
    breaker.state = 'half-open';   // let one probe through
    return true;
  }
  return false;
}

function onSuccess() {
  if (breaker.state !== 'closed') {
    console.log('[maps] provider recovered — breaker closed');
  }
  breaker.state = 'closed';
  breaker.failures = 0;
}

function onFailure(err) {
  metrics.providerErrors += 1;
  breaker.failures += 1;

  if (breaker.state === 'half-open' || breaker.failures >= breaker.threshold) {
    if (breaker.state !== 'open') {
      metrics.breakerTrips += 1;
      console.warn(
        `[maps] breaker OPEN after ${breaker.failures} failures (${err.message}) — ` +
        `falling back to estimates for ${breaker.cooldownMs / 1000}s`
      );
    }
    breaker.state = 'open';
    breaker.openedAt = Date.now();
  }
}

/** Wraps a provider call with the breaker and a hard timeout. */
async function callProvider(fn, label) {
  if (!breakerAllows()) {
    const err = new Error(`maps provider unavailable (breaker open)`);
    err.breakerOpen = true;
    throw err;
  }

  metrics.providerCalls += 1;
  const timeoutMs = Number(env.maps.timeoutMs || 5000);

  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    onSuccess();
    return result;
  } catch (err) {
    onFailure(err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Distance
 * ------------------------------------------------------------------ */

/**
 * Road distance and duration between two points.
 *
 * @param {object} opts
 *   maxKm  reject beyond this straight-line distance, before any API call
 *   fresh  bypass the cache (live ETA)
 */
async function getDistance(origin, destination, opts = {}) {
  if (!geo.isValidCoordinate(origin) || !geo.isValidCoordinate(destination)) {
    throw ApiError.badRequest('Invalid pickup or drop coordinates', 'INVALID_COORDINATES');
  }

  /* -- pre-filter: answer cheap questions locally -- */

  const straightKm = geo.haversineKm(origin, destination);

  // Straight line is always SHORTER than the road route, so if even that
  // exceeds the limit the real trip certainly does. Safe to reject.
  if (opts.maxKm && straightKm > opts.maxKm) {
    metrics.prefilterRejects += 1;
    throw ApiError.badRequest(
      `Trip distance exceeds the ${opts.maxKm} km limit`,
      'DISTANCE_EXCEEDED'
    );
  }

  // Same point twice — almost always a UI bug rather than a real booking.
  if (straightKm < 0.05) {
    metrics.prefilterRejects += 1;
    throw ApiError.badRequest(
      'Pickup and drop are the same location',
      'SAME_LOCATION'
    );
  }

  const key = keys.distance(origin, destination);

  if (!opts.fresh) {
    const hit = await cache.get(key);
    if (hit) {
      metrics.distanceHits += 1;
      return { ...hit, cached: true };
    }
  }
  metrics.distanceMisses += 1;

  try {
    const result = await callProvider(
      () => getProvider().getDistanceMatrix(origin, destination),
      'distanceMatrix'
    );

    // Sanity check: a road route shorter than the straight line is impossible.
    // A provider returning that is misconfigured or returning a different pair.
    if (result.distanceKm < straightKm * 0.9) {
      console.warn(
        `[maps] provider returned ${result.distanceKm}km for a ${straightKm.toFixed(2)}km ` +
        `straight line — using the estimate instead`
      );
      return estimateDistance(origin, destination, 'implausible provider result');
    }

    await cache.set(key, result, TTL.DISTANCE);
    return { ...result, cached: false };
  } catch (err) {
    // A maps outage must not stop a customer booking a cab. Arithmetic is less
    // accurate than a real route, but a slightly wrong fare beats no service.
    return estimateDistance(origin, destination, err.message);
  }
}

function estimateDistance(origin, destination, reason) {
  metrics.fallbackEstimates += 1;
  const straightKm = geo.haversineKm(origin, destination);
  const distanceKm = Number((straightKm * geo.DETOUR_FACTOR).toFixed(2));
  const speed = distanceKm < 20 ? 25 : distanceKm < 60 ? 40 : 55;

  return {
    distanceKm,
    durationMin: Math.max(1, Math.round((distanceKm / speed) * 60)),
    provider: 'fallback-estimate',
    estimated: true,
    cached: false,
    fallbackReason: reason,
  };
}

/* ------------------------------------------------------------------ *
 * Geocoding — the highest-value cache
 * ------------------------------------------------------------------ */

async function geocode(address) {
  const trimmed = String(address || '').trim();
  if (trimmed.length < 3) {
    throw ApiError.badRequest('Address is too short to geocode', 'ADDRESS_TOO_SHORT');
  }

  const key = keys.geocode(trimmed);

  // getOrSet gives single-flight for free: fifty simultaneous requests for the
  // same airport terminal produce ONE provider call, not fifty.
  const result = await cache.getOrSet(
    key,
    async () => {
      metrics.geocodeMisses += 1;
      try {
        return await callProvider(() => getProvider().geocode(trimmed), 'geocode');
      } catch (err) {
        // Do NOT cache a failure as a permanent negative — a transient provider
        // error would otherwise poison this address for 30 days.
        throw ApiError.badRequest(`Could not locate "${trimmed}"`, 'GEOCODE_FAILED');
      }
    },
    { ttl: TTL.GEOCODE, cacheNull: false }
  );

  if (result) metrics.geocodeHits += 1;
  return result;
}

async function reverseGeocode(lat, lng) {
  if (!geo.isValidCoordinate({ lat, lng })) {
    throw ApiError.badRequest('Invalid coordinates', 'INVALID_COORDINATES');
  }

  return cache.getOrSet(
    keys.reverse(lat, lng),
    async () => {
      try {
        return await callProvider(() => getProvider().reverseGeocode(lat, lng), 'reverseGeocode');
      } catch (err) {
        // Reverse geocoding is cosmetic — a raw coordinate is an acceptable
        // label. Never fail a request over it.
        return {
          lat: Number(lat),
          lng: Number(lng),
          formattedAddress: `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`,
          placeId: null,
          provider: 'fallback',
          estimated: true,
        };
      }
    },
    { ttl: TTL.GEOCODE, cacheNull: false }
  );
}

/**
 * Address suggestions.
 *
 * Returns an empty array on failure rather than throwing — a search box that
 * shows no suggestions still lets the user type an address, whereas one that
 * errors blocks the booking entirely.
 */
async function autocomplete(query, opts = {}) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];

  return cache.getOrSet(
    keys.autocomplete(q),
    async () => {
      try {
        return await callProvider(() => getProvider().autocomplete(q, opts), 'autocomplete');
      } catch (err) {
        return [];
      }
    },
    { ttl: TTL.AUTOCOMPLETE, cacheNull: false }
  );
}

/* ------------------------------------------------------------------ *
 * Service area
 * ------------------------------------------------------------------ */

/**
 * Is a point inside a city's service area?
 *
 * Pure arithmetic against the city's centre and radius — no API call. This runs
 * before anything else in the booking flow, so an out-of-area request costs
 * nothing at all.
 */
function isServiceable(point, city) {
  if (!geo.isValidCoordinate(point)) return { ok: false, reason: 'INVALID_COORDINATES' };

  const centre = { lat: Number(city.centreLat), lng: Number(city.centreLng) };
  const distanceKm = geo.haversineKm(point, centre);

  if (distanceKm > Number(city.radiusKm)) {
    return {
      ok: false,
      reason: 'OUTSIDE_SERVICE_AREA',
      distanceKm: Number(distanceKm.toFixed(2)),
      radiusKm: Number(city.radiusKm),
    };
  }
  return { ok: true, distanceKm: Number(distanceKm.toFixed(2)) };
}

function health() {
  const geoTotal = metrics.geocodeHits + metrics.geocodeMisses;
  const dmTotal = metrics.distanceHits + metrics.distanceMisses;

  return {
    provider: getProvider().name,
    breaker: breaker.state,
    geocodeHitRate: geoTotal ? Number((metrics.geocodeHits / geoTotal).toFixed(3)) : null,
    distanceHitRate: dmTotal ? Number((metrics.distanceHits / dmTotal).toFixed(3)) : null,
    metrics: { ...metrics },
  };
}

/** Test hook. */
function resetBreaker() {
  breaker.state = 'closed';
  breaker.failures = 0;
}

module.exports = {
  TTL,
  keys,
  getDistance,
  estimateDistance,
  geocode,
  reverseGeocode,
  autocomplete,
  isServiceable,
  health,
  resetBreaker,
};