'use strict';

/**
 * src/services/cache.service.js
 *
 * The cache layer. Every function here degrades gracefully: if Redis is down,
 * reads fall through to the origin and writes are skipped. A cache failure
 * must never become a 500.
 *
 * Four defences against the classic cache failure modes:
 *
 *   1. TTL JITTER          — 10,000 keys written in the same second must not
 *                            all expire in the same second.
 *   2. SINGLE-FLIGHT LOCK  — when a hot key does expire, ONE process rebuilds
 *                            it while the others wait, instead of all of them
 *                            hitting the database at once.
 *   3. NEGATIVE CACHING    — a request for an id that does not exist misses the
 *                            cache every time and reaches the database every
 *                            time. Caching the "not found" answer closes that
 *                            as an attack vector.
 *   4. STALE-ON-ERROR      — if the origin fails while we still hold an expired
 *                            value, serve the stale value rather than an error.
 */

const crypto = require('crypto');
const { cache: redis, isCacheUp } = require('../config/redis');
const env = require('../config/env');

/* ------------------------------------------------------------------ *
 * TTL tiers — seconds. Cache aggressively, invalidate on write.
 * ------------------------------------------------------------------ */

const TTL = {
  STATIC: 21_600, // 6h  — cities, fare configs, permissions
  LONG: 3_600,    // 1h  — vehicle/driver profiles
  MEDIUM: 600,    // 10m — aggregates, counts
  SHORT: 60,      // 1m  — volatile lookups
  NEGATIVE: 30,   // 30s — "does not exist" answers
};

/* ------------------------------------------------------------------ *
 * Metrics — expose via /health/ready or an APM
 * ------------------------------------------------------------------ */

const metrics = {
  hits: 0,
  misses: 0,
  negativeHits: 0,
  staleServed: 0,
  originCalls: 0,
  lockWins: 0,
  lockWaits: 0,
  errors: 0,
  skippedDown: 0,
};

/** Sentinel stored for a cached "not found". */
const MISS_MARKER = '\u0000__miss__';

/* ------------------------------------------------------------------ *
 * TTL jitter
 * ------------------------------------------------------------------ */

/**
 * jitter(600) -> roughly 480..720
 *
 * Without this, a deploy that warms 10,000 keys at 09:00:00 with a 10-minute
 * TTL produces a synchronised stampede at 09:10:00. Randomising each TTL turns
 * a one-second spike into a four-minute smear.
 */
function jitter(seconds, ratio = 0.2) {
  const spread = seconds * ratio;
  return Math.max(1, Math.floor(seconds - spread + Math.random() * spread * 2));
}

/* ------------------------------------------------------------------ *
 * Safe primitives — never throw
 * ------------------------------------------------------------------ */

async function safeGet(key) {
  if (!isCacheUp()) {
    metrics.skippedDown += 1;
    return null;
  }
  try {
    return await redis.get(key);
  } catch (err) {
    metrics.errors += 1;
    return null;
  }
}

async function safeSet(key, value, ttlSeconds) {
  if (!isCacheUp()) return false;
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
    return true;
  } catch (err) {
    metrics.errors += 1;
    return false;
  }
}

async function safeDel(...keys) {
  if (!isCacheUp() || keys.length === 0) return 0;
  try {
    return await redis.del(...keys);
  } catch (err) {
    metrics.errors += 1;
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Public: plain get / set / delete
 * ------------------------------------------------------------------ */

async function get(key) {
  const raw = await safeGet(key);
  if (raw === null) return undefined;          // not cached
  if (raw === MISS_MARKER) {
    metrics.negativeHits += 1;
    return null;                                // cached "does not exist"
  }
  try {
    metrics.hits += 1;
    return JSON.parse(raw);
  } catch (err) {
    // Poisoned entry (schema change, truncation). Treat as a miss and drop it.
    await safeDel(key);
    return undefined;
  }
}

async function set(key, value, ttlSeconds = TTL.MEDIUM) {
  if (value === undefined) return false;
  if (value === null) return safeSet(key, MISS_MARKER, TTL.NEGATIVE);
  return safeSet(key, JSON.stringify(value), jitter(ttlSeconds));
}

const del = (...keys) => safeDel(...keys);

/**
 * Prefix invalidation using SCAN.
 *
 * Never KEYS — Redis is single-threaded and KEYS walks the entire keyspace,
 * blocking every other client for the duration. On Upstash it also burns quota
 * proportional to total key count.
 */
async function delByPrefix(prefix) {
  if (!isCacheUp()) return 0;
  const match = `${env.redis.prefix}${prefix}*`;
  let removed = 0;
  try {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (found.length) {
        // scan returns fully-prefixed keys; strip so keyPrefix is not applied twice.
        const stripped = found.map((k) =>
          k.startsWith(env.redis.prefix) ? k.slice(env.redis.prefix.length) : k
        );
        removed += await safeDel(...stripped);
      }
    } while (cursor !== '0');
  } catch (err) {
    metrics.errors += 1;
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * Single-flight lock
 * ------------------------------------------------------------------ */

const LOCK_TTL_MS = 8_000;
const LOCK_WAIT_MS = 3_000;
const LOCK_POLL_MS = 50;

/**
 * Release only if we still own the lock.
 *
 * A plain DEL is a real bug: if our work outran the lock TTL, the lock expired,
 * another worker acquired it, and our DEL would delete THEIR lock — letting a
 * third worker in. Comparing the token in Lua makes check-and-delete atomic.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

async function acquireLock(lockKey, token) {
  // If Redis is unavailable there is no coordination possible. Let the caller
  // proceed — a brief stampede is better than a hung request.
  if (!isCacheUp()) return true;
  try {
    const res = await redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
    return res === 'OK';
  } catch (err) {
    metrics.errors += 1;
    return true;
  }
}

async function releaseLock(lockKey, token) {
  if (!isCacheUp()) return;
  try {
    await redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
  } catch (err) {
    metrics.errors += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * getOrSet — the main entry point
 * ------------------------------------------------------------------ */

/**
 * @param {string}   key
 * @param {Function} loader      async () => value   (the database query)
 * @param {object}   opts
 *   ttl          {number}  seconds, default MEDIUM
 *   cacheNull    {boolean} cache a null result briefly (default true)
 *   singleFlight {boolean} lock on miss (default true)
 */
async function getOrSet(key, loader, opts = {}) {
  const { ttl = TTL.MEDIUM, cacheNull = true, singleFlight = true } = opts;

  const cached = await get(key);
  if (cached !== undefined) return cached;      // includes cached null

  metrics.misses += 1;

  if (!singleFlight || !isCacheUp()) {
    return loadAndStore(key, loader, ttl, cacheNull);
  }

  const lockKey = `lock:${key}`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const won = await acquireLock(lockKey, token);

  if (won) {
    metrics.lockWins += 1;
    try {
      return await loadAndStore(key, loader, ttl, cacheNull);
    } finally {
      await releaseLock(lockKey, token);
    }
  }

  // Lost the race — wait briefly for the winner to publish.
  metrics.lockWaits += 1;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(LOCK_POLL_MS);
    const retry = await get(key);
    if (retry !== undefined) return retry;
  }

  // Winner is slow or died. Load it ourselves rather than failing.
  return loadAndStore(key, loader, ttl, cacheNull);
}

async function loadAndStore(key, loader, ttl, cacheNull) {
  metrics.originCalls += 1;
  const value = await loader();

  if (value === null || value === undefined) {
    if (cacheNull) await safeSet(key, MISS_MARKER, TTL.NEGATIVE);
    return value === undefined ? null : value;
  }

  await set(key, value, ttl);
  return value;
}

/* ------------------------------------------------------------------ *
 * Key builders — one place, so invalidation never misses a variant
 * ------------------------------------------------------------------ */

const keys = {
  permissions: (role) => `perm:${role}`,
  permissionsAll: () => 'perm:',
  city: (id) => `city:${id}`,
  citiesActive: () => 'city:active',
  fareConfig: (cityId, cls, tripType) => `fare:${cityId}:${cls}:${tripType}`,
  fareConfigPrefix: (cityId) => `fare:${cityId}:`,
  user: (id) => `user:${id}`,
  vehicle: (id) => `vehicle:${id}`,
  driver: (id) => `driver:${id}`,
};

function health() {
  const total = metrics.hits + metrics.negativeHits + metrics.misses;
  return {
    up: isCacheUp(),
    hitRate: total ? Number(((metrics.hits + metrics.negativeHits) / total).toFixed(4)) : null,
    metrics: { ...metrics },
  };
}

module.exports = {
  TTL,
  keys,
  jitter,
  get,
  set,
  del,
  delByPrefix,
  getOrSet,
  health,
};