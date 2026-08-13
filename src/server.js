'use strict';

/**
 * src/server.js
 *
 * Process entry point. Verifies the database before binding a port, and drains
 * cleanly on shutdown so a deploy never cuts off in-flight requests.
 */

const http = require('http');
const app = require('./app');
const env = require('./config/env');
const db = require('./config/prisma');

const server = http.createServer(app);

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

async function start() {
  const health = await db.health();
  if (health.status !== 'up') {
    throw new Error(`Database unreachable: ${health.error}`);
  }
  console.log(`[boot] database connected (${health.latencyMs}ms)`);

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
    // Stop accepting new connections; requests already in flight finish.
    await new Promise((resolve) => server.close(resolve));
    await db.disconnect();
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