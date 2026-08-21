'use strict';

/**
 * src/services/location.service.js   — Day 11
 *
 * The GPS hot path. Driver pings arrive every few seconds; this service writes
 * them to REDIS GEO and nowhere else.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE: A PING NEVER TOUCHES POSTGRES
 * ---------------------------------------------------------------------------
 * 100 drivers pinging every 4s is 25 writes/second, ~2.16 million a day, just
 * for position — a firehose that would bloat the WAL, thrash indexes, and turn
 * the bookings table into a location log. So live position lives in Redis:
 *
 *   - GEOADD to a per-fleet GEO set  (drivers:geo)  — O(log N), overwrites in
 *     place, so a driver has exactly one current position, not a growing trail.
 *   - a small HASH of last-ping metadata per driver (speed, heading, ts) with a
 *     TTL, so a driver who stops pinging simply expires.
 *
 * The ONLY Postgres writes in the whole GPS pipeline are:
 *   - a driver going online/offline (a state CHANGE, not every ping)
 *   - trip start / end / periodic checkpoint (trip.service, time-throttled)
 * Under the 100-driver ping storm, none of those fire, so the Postgres write
 * count stays flat. That is the Day 11 done-line, and it is a property of
 * routing pings to Redis — not something the caller has to be careful about.
 */

const { prisma } = require('../config/prisma');
const redis = require('../config/redis');
const env = require('../config/env');
const { ApiError } = require('../utils/helpers');
const geo = require('../lib/geo');

/* ------------------------------------------------------------------ *
 * Redis key layout
 *
 * NOTE: the cache client already applies the 'abhi:' keyPrefix, so these are
 * suffixes. GEO commands must all use the SAME key, hence one constant.
 * ------------------------------------------------------------------ */

const GEO_KEY = 'drivers:geo';                    // GEOADD / GEOSEARCH set
const meta = (driverId) => `driver:loc:${driverId}`; // HASH: last ping metadata

/* ------------------------------------------------------------------ *
 * Ingest one ping  — the hot path
 * ------------------------------------------------------------------ */

/**
 * Validates and records a driver GPS ping.
 *
 * Plausibility: compared against the driver's PREVIOUS ping, a new one is
 * rejected if it implies an impossible speed or a teleport-sized jump. This
 * keeps GPS jitter and spoofed coordinates out of the live map without a single
 * database read — the previous ping is in Redis.
 *
 * @returns {Promise<{ accepted, reason?, speedKmph?, jumpKm? }>}
 */
async function ingestPing(driverId, { lat, lng, speed = null, heading = null, at = null }) {
  if (!geo.isValidCoordinate({ lat, lng })) {
    throw ApiError.badRequest('Invalid coordinates', 'BAD_COORDINATES');
  }

  if (!redis.isCacheUp()) {
    // Live location is a Redis-only feature; without Redis we cannot store or
    // validate a ping. Fail soft — a dropped ping is not a booking failure.
    return { accepted: false, reason: 'LOCATION_UNAVAILABLE' };
  }

  const now = at ? new Date(at).getTime() : Date.now();

  // Previous ping (Redis HASH). One round-trip; no Postgres.
  const prev = await redis.cache.hgetall(meta(driverId));
  let speedKmph = null;
  let jumpKm = null;

  if (prev && prev.lat && prev.ts) {
    const prevLat = Number(prev.lat);
    const prevLng = Number(prev.lng);
    const prevTs = Number(prev.ts);
    const dtSec = Math.max((now - prevTs) / 1000, 0.001); // guard div-by-zero

    jumpKm = geo.haversineKm(prevLat, prevLng, Number(lat), Number(lng));

    // Teleport: a single jump too large to be real between two pings.
    if (jumpKm > env.gps.maxJumpKm) {
      return { accepted: false, reason: 'TELEPORT', jumpKm: round(jumpKm) };
    }

    // Impossible speed since the last ping.
    speedKmph = (jumpKm / dtSec) * 3600;
    if (speedKmph > env.gps.maxSpeedKmph) {
      return { accepted: false, reason: 'IMPLAUSIBLE_SPEED', speedKmph: round(speedKmph) };
    }
  }

  // Record. GEOADD overwrites the driver's point in place; the HASH keeps the
  // metadata the GEO set cannot hold. Both in one pipeline — two commands, no DB.
  const pipe = redis.cache.pipeline();
  pipe.geoadd(GEO_KEY, Number(lng), Number(lat), driverId); // NB: lng, lat order
  pipe.hset(meta(driverId), {
    lat: String(lat),
    lng: String(lng),
    ts: String(now),
    speed: speed == null ? '' : String(speed),
    heading: heading == null ? '' : String(heading),
  });
  pipe.expire(meta(driverId), env.gps.positionTtlSeconds);
  await pipe.exec();

  return {
    accepted: true,
    speedKmph: speedKmph == null ? null : round(speedKmph),
    jumpKm: jumpKm == null ? null : round(jumpKm),
  };
}

/* ------------------------------------------------------------------ *
 * Nearby search — GEOSEARCH
 * ------------------------------------------------------------------ */

/**
 * Drivers within radiusKm of a point, nearest first. Used by dispatch to find a
 * car for a booking. Pure Redis — no Postgres.
 *
 * Returns [{ driverId, distanceKm, lat, lng }]. The caller cross-references
 * these ids against availability/allocation in Postgres if needed; the GEO set
 * answers "who is physically near", cheaply and instantly.
 */
async function nearbyVehicles({ lat, lng, radiusKm = 5, limit = 20 }) {
  if (!geo.isValidCoordinate({ lat, lng })) {
    throw ApiError.badRequest('Invalid coordinates', 'BAD_COORDINATES');
  }
  if (!redis.isCacheUp()) return [];

  // GEOSEARCH ... BYRADIUS ... ASC WITHCOORD WITHDIST COUNT n
  const raw = await redis.cache.geosearch(
    GEO_KEY,
    'FROMLONLAT', Number(lng), Number(lat),
    'BYRADIUS', Number(radiusKm), 'km',
    'ASC',
    'COUNT', Number(limit),
    'WITHCOORD', 'WITHDIST'
  );

  // raw: [ [member, dist, [lng, lat]], ... ]
  return (raw || []).map(([driverId, dist, coord]) => ({
    driverId,
    distanceKm: Number(dist),
    lng: coord ? Number(coord[0]) : null,
    lat: coord ? Number(coord[1]) : null,
  }));
}

/**
 * One driver's current position + metadata for the live map. Redis only.
 */
async function driverLocation(driverId) {
  if (!redis.isCacheUp()) return null;

  const [pos] = await redis.cache.geopos(GEO_KEY, driverId);
  if (!pos) return null;

  const m = await redis.cache.hgetall(meta(driverId));
  return {
    driverId,
    lng: Number(pos[0]),
    lat: Number(pos[1]),
    speed: m.speed ? Number(m.speed) : null,
    heading: m.heading ? Number(m.heading) : null,
    lastPingAt: m.ts ? new Date(Number(m.ts)).toISOString() : null,
  };
}

/* ------------------------------------------------------------------ *
 * Online / offline  — the rare Postgres touches (state change only)
 * ------------------------------------------------------------------ */

/**
 * Marks a driver online. Writes Postgres ONCE (the state change), not per ping.
 * Called when a driver goes on shift, not on every location update.
 */
async function markOnline(driverId) {
  await prisma.driver.update({
    where: { userId: driverId },
    data: { isOnline: true, lastPingAt: new Date() },
  });
  return { driverId, online: true };
}

/**
 * Marks a driver offline and removes them from the live map (ZREM from the GEO
 * set, which is a sorted set under the hood) so dispatch stops offering them.
 */
async function markOffline(driverId) {
  await prisma.driver.update({
    where: { userId: driverId },
    data: { isOnline: false },
  });
  if (redis.isCacheUp()) {
    await redis.cache.zrem(GEO_KEY, driverId).catch(() => {});
    await redis.cache.del(meta(driverId)).catch(() => {});
  }
  return { driverId, online: false };
}

/* ------------------------------------------------------------------ *
 * Stale-driver cleanup  — periodic, batched, NOT per-ping
 * ------------------------------------------------------------------ */

/**
 * Marks drivers offline who have not pinged within the heartbeat window.
 *
 * A driver's live metadata carries a TTL, so a stale one has already vanished
 * from Redis; this reconciles the DURABLE flag so the drivers table does not
 * keep claiming they are online. Intended for the Day 12 scheduler; exposed now
 * for manual testing.
 *
 * This is the ONE place that writes Postgres in bulk, and it runs on a timer
 * (every heartbeat window), NOT on the ping path — so it does not count against
 * the flat-write done-line.
 */
async function sweepStaleDrivers(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.gps.heartbeatSeconds * 1000);

  // Candidates: flagged online in Postgres but no recent ping. We check Redis
  // for a live position; if none (expired) or its ts is older than the cutoff,
  // they are stale.
  const online = await prisma.driver.findMany({
    where: { isOnline: true },
    select: { userId: true, lastPingAt: true },
  });

  const staleIds = [];
  for (const d of online) {
    let lastTs = d.lastPingAt ? d.lastPingAt.getTime() : 0;
    if (redis.isCacheUp()) {
      // eslint-disable-next-line no-await-in-loop
      const ts = await redis.cache.hget(meta(d.userId), 'ts');
      if (ts) lastTs = Math.max(lastTs, Number(ts));
    }
    if (lastTs < cutoff.getTime()) staleIds.push(d.userId);
  }

  if (staleIds.length === 0) return { swept: 0, scanned: online.length };

  // ONE batched update, not one per driver.
  await prisma.driver.updateMany({
    where: { userId: { in: staleIds } },
    data: { isOnline: false },
  });

  if (redis.isCacheUp()) {
    const pipe = redis.cache.pipeline();
    for (const id of staleIds) {
      pipe.zrem(GEO_KEY, id);
      pipe.del(meta(id));
    }
    await pipe.exec().catch(() => {});
  }

  return { swept: staleIds.length, scanned: online.length };
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = {
  ingestPing,
  nearbyVehicles,
  driverLocation,
  markOnline,
  markOffline,
  sweepStaleDrivers,
  // exported for tests
  GEO_KEY,
};