'use strict';

/**
 * src/server.js   — UPDATED for Day 2
 *
 * Adds Redis to the boot check and warms the permission cache before the port
 * binds, so the first authorised request is not a cold read.
 */

const http = require('http');
const app = require('./app');
const env = require('./config/env');
const db = require('./config/prisma');
const redis = require('./config/redis');
const permissionService = require('./services/permission.service');
const realtime = require('./realtime');
const realtimeBridge = require('./realtime/bridge');

const server = http.createServer(app);

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

/**
 * Gives Redis a moment to finish its handshake before we report on it.
 *
 * Without this the boot check races the connection: ioredis is still in
 * 'connecting' when health() runs, so the log claims Redis is UNAVAILABLE and
 * then '[redis:cache] ready' appears a line later — alarming, and wrong.
 *
 * Resolves as soon as the connection is ready, so a healthy Redis costs
 * milliseconds. Only a genuinely unreachable Redis waits out the full timeout,
 * and boot continues either way — Redis is degradable, not required.
 */
function waitForRedis(timeoutMs = 5_000) {
  const client = redis.cache;
  if (client.status === 'ready') return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(ok);
    };

    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);

    client.once('ready', onReady);
  });
}

async function start() {
  /* ---- 1. Database is REQUIRED ---- */
  const dbHealth = await db.health();
  if (dbHealth.status !== 'up') {
    throw new Error(`Database unreachable: ${dbHealth.error}`);
  }
  console.log(`[boot] database connected (${dbHealth.latencyMs}ms)`);

  /* ---- 2. Redis is DEGRADABLE, not required ----
   *
   * A Redis outage should cost latency, not availability: cache reads fall
   * through to Postgres and rate limiting falls back to per-process memory
   * (see FailoverStore). Refusing to boot without Redis would turn a cache
   * problem into an outage.
   *
   * OTP login is the one exception — it needs Redis for the attempt counter and
   * cooldown, so otp.service returns 503 rather than issuing a code that could
   * be brute-forced at unlimited rate.
   */
  const redisReady = await waitForRedis();

  if (redisReady) {
    const redisHealth = await redis.health();
    console.log(`[boot] redis cache connected (${redisHealth.cache.latencyMs}ms)`);
  } else {
    console.warn('[boot] redis cache UNAVAILABLE — degraded mode:');
    console.warn('       - cache reads fall through to Postgres');
    console.warn('       - rate limits become per-instance');
    console.warn('       - OTP login returns 503 until Redis returns');
  }

  /* ---- 3. Warm the permission cache ----
   *
   * Works either way: with Redis it populates L1 + L2, without it populates L1
   * from Postgres. Either beats a cold read on the first authorised request.
   */
  try {
    await permissionService.warm();
  } catch (err) {
    console.warn(`[boot] permission warm failed: ${err.message}`);
  }

  /* ---- 4. Real-time (Day 10) ----
   *
   * Attached to the SAME HTTP server, so WebSocket and REST share one port.
   * Done after Redis so the multi-instance adapter can use it when present;
   * the subsystem degrades to single-instance if Redis is down, matching the
   * rest of the app. The bridge then starts forwarding domain events to rooms.
   */
  const io = await realtime.init(server);
  realtimeBridge.wire(io);

  /* ---- 5. Queue producers (Day 12) ---- */
  try {
    require('./queues/producers').wire();
  } catch (err) {
    console.warn(`[boot] queue producers not wired: ${err.message}`);
  }

  await new Promise((resolve) => server.listen(env.port, resolve));
  console.log(`[boot] listening on http://localhost:${env.port}  (${env.nodeEnv})`);
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);

  const force = setTimeout(() => {
    console.error('[shutdown] timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    // Stop accepting new connections; in-flight requests finish.
    // Close Socket.IO first so live sockets get a clean disconnect.
    try {
      realtime.getIO().close();
    } catch (_) {
      /* io may not have initialised if boot failed early */
    }
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([
      db.disconnect(),
      require('./config/reportingPrisma').disconnect(),
      redis.disconnect(),
    ]);
    clearTimeout(force);
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] error:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  shutdown('uncaughtException');
});

start().catch((err) => {
  console.error('[boot] failed to start:', err.message);
  process.exit(1);
});