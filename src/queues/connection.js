'use strict';

/**
 * src/queues/connection.js   — Day 12
 *
 * The Redis connection BullMQ uses. It is DELIBERATELY separate from the cache
 * and the app's queue client, for two hard requirements:
 *
 *  1. maxRetriesPerRequest MUST be null. BullMQ holds a blocking connection
 *     (BRPOPLPUSH) open indefinitely; ioredis's default retry cap would tear
 *     that connection down and BullMQ would stall. The app's baseOptions cap it
 *     at 2, so we cannot reuse that client — we build our own.
 *
 *  2. NO eviction. A queue lives in Redis; if Redis is allowed to evict keys
 *     under memory pressure (allkeys-lru, as a CACHE is configured), it will
 *     silently drop pending JOBS — a payment capture or a booking notification
 *     just vanishes. So the queue must point at a database with eviction
 *     DISABLED. In production we refuse to start if it is pointed at the cache.
 *
 * The connection is created lazily so importing this module in the API process
 * (only to reference queue names) does not open a worker connection.
 */

const IORedis = require('ioredis');
const env = require('../config/env');

let connection = null;

/**
 * Returns the shared BullMQ connection, creating it on first use.
 *
 * Uses REDIS_QUEUE_URL when set (the dedicated, eviction-disabled database),
 * otherwise falls back to the cache URL — which is fine for local dev but is
 * refused in production, since running a queue on an evicting cache loses jobs.
 */
function getConnection() {
  if (connection) return connection;

  const url = env.redis.queueUrl || env.redis.cacheUrl;
  const onCache = !env.redis.queueUrl || env.redis.queueUrl === env.redis.cacheUrl;

  if (onCache && env.isProd) {
    throw new Error(
      '[queues] REDIS_QUEUE_URL is not set (or equals the cache URL). BullMQ must ' +
      'not run on the cache database — its allkeys-lru eviction silently drops ' +
      'jobs. Create a second Redis/Upstash database with eviction DISABLED and ' +
      'set REDIS_QUEUE_URL.'
    );
  }
  if (onCache) {
    console.warn(
      '[queues] Using the CACHE database for queues (no REDIS_QUEUE_URL). Fine for ' +
      'local dev, but jobs can be evicted — set REDIS_QUEUE_URL with eviction ' +
      'disabled before this is anything but a toy.'
    );
  }

  connection = new IORedis(url, {
    // The two non-negotiables for BullMQ:
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connection.on('error', (e) => {
    console.error('[queues] redis connection error:', e.message);
  });

  return connection;
}

async function closeConnection() {
  if (connection) {
    await connection.quit().catch(() => {});
    connection = null;
  }
}

module.exports = { getConnection, closeConnection };