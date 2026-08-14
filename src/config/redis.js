'use strict';

/**
 * src/config/redis.js
 *
 * TWO Redis clients, deliberately separate:
 *
 *   cache  — volatile data. Eviction policy allkeys-lru: under memory pressure
 *            Redis discards the least-recently-used key, which is exactly right
 *            for a cache.
 *   queue  — jobs, and anything that must NOT be silently discarded. Eviction
 *            policy noeviction.
 *
 * Mixing them is a known production failure: with allkeys-lru, Redis will
 * happily evict pending booking or payment jobs to make room for cached fare
 * configs. The work vanishes with no error anywhere.
 *
 * ---------------------------------------------------------------------------
 * UPSTASH NOTES
 * ---------------------------------------------------------------------------
 *  - Connection strings use rediss:// (TLS). ioredis enables TLS automatically
 *    from that scheme; no extra tls option is needed.
 *  - CONFIG SET is not permitted, so the eviction policy CANNOT be set from
 *    code. Choose it per database in the Upstash console: enable eviction on
 *    the cache database, leave it off for the queue database.
 *  - Every command counts against the free-tier quota, so batching (MGET,
 *    pipelines) matters more here than on a local Redis.
 *  - Round-trip latency is ~30-80ms from India. Pick the closest region.
 */

const Redis = require('ioredis');
const env = require('./env');

/* ------------------------------------------------------------------ *
 * Shared options
 * ------------------------------------------------------------------ */

const baseOptions = {
  // Fail fast rather than buffering commands while disconnected. A queued
  // command that resolves 30 seconds later is worse than an immediate miss,
  // because the request that wanted it has already timed out.
  enableOfflineQueue: false,

  // Do not stall a request behind Redis retries.
  maxRetriesPerRequest: 2,

  connectTimeout: 10_000,

  // A slow Redis must not become a slow API. Upstash adds real network
  // latency, so this is more generous than a localhost value would be.
  commandTimeout: 5_000,

  retryStrategy: (times) => Math.min(times * 200, 5_000),
  reconnectOnError: (err) => /READONLY|ETIMEDOUT|ECONNRESET/.test(err.message),

  // Serverless Redis benefits from keep-alive; reconnecting per command would
  // dominate latency.
  keepAlive: 30_000,
  lazyConnect: false,
};

/* ------------------------------------------------------------------ *
 * Clients
 * ------------------------------------------------------------------ */

function makeClient(url, label, keyPrefix) {
  const client = new Redis(url, { ...baseOptions, keyPrefix });

  client.on('ready', () => {
    state[label] = true;
    console.log(`[redis:${label}] ready`);
  });

  client.on('end', () => {
    state[label] = false;
    console.warn(`[redis:${label}] connection closed`);
  });

  client.on('error', (err) => {
    state[label] = false;
    errorCounts[label] += 1;
    // ioredis emits this on every reconnect attempt; throttle the noise.
    if (errorCounts[label] % 20 === 1) {
      console.error(`[redis:${label}] ${err.message}`);
    }
  });

  return client;
}

const state = { cache: false, queue: false };
const errorCounts = { cache: 0, queue: 0 };

const cache = makeClient(env.redis.cacheUrl, 'cache', env.redis.prefix);

/**
 * If no separate queue URL is configured, reuse the cache connection. It works,
 * but the eviction warning above applies — set REDIS_QUEUE_URL before you put
 * real jobs through BullMQ on Day 12.
 */
let queue;
if (env.redis.queueUrl && env.redis.queueUrl !== env.redis.cacheUrl) {
  // No keyPrefix: BullMQ manages its own namespacing and breaks if a prefix
  // is applied underneath it.
  queue = makeClient(env.redis.queueUrl, 'queue', undefined);
} else {
  queue = cache;
  state.queue = state.cache;
  console.warn(
    '[redis] REDIS_QUEUE_URL not set — reusing the cache connection. ' +
    'Create a second Upstash database with eviction DISABLED before Day 12.'
  );
}

/* ------------------------------------------------------------------ *
 * Health & availability
 * ------------------------------------------------------------------ */

/**
 * Callers check this before attempting a Redis operation so a cache lookup
 * during an outage costs nothing rather than waiting for a timeout.
 */
const isCacheUp = () => state.cache;
const isQueueUp = () => state.queue;

async function health() {
  const ping = async (client, label) => {
    const started = Date.now();
    try {
      await client.ping();
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (err) {
      return { status: 'down', error: err.message };
    }
  };

  const [cacheHealth, queueHealth] = await Promise.all([
    ping(cache, 'cache'),
    queue === cache ? Promise.resolve({ status: 'shared' }) : ping(queue, 'queue'),
  ]);

  return { cache: cacheHealth, queue: queueHealth };
}

async function disconnect() {
  const clients = queue === cache ? [cache] : [cache, queue];
  await Promise.all(
    clients.map(async (c) => {
      try {
        await c.quit();
      } catch (err) {
        c.disconnect();
      }
    })
  );
}

module.exports = {
  cache,
  queue,
  isCacheUp,
  isQueueUp,
  health,
  disconnect,
};