'use strict';

/**
 * src/config/reportingPrisma.js   — Day 13
 *
 * A SECOND PrismaClient, dedicated to reporting/analytics reads.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE CLIENT AT ALL
 * ---------------------------------------------------------------------------
 * Report queries are the opposite of the transactional workload: they scan
 * wide ranges, aggregate, and can take seconds. If they ran on the same
 * connection pool as booking/payment traffic, one analyst pulling a monthly
 * export could starve the pool and make live bookings queue behind it.
 *
 * Each PrismaClient opens its OWN pool, so a second client gives reporting an
 * isolated set of connections. A slow report now backs up only other reports —
 * never a customer trying to book a cab.
 *
 * ---------------------------------------------------------------------------
 * READ REPLICA — ONE ENV VAR TO GO LIVE
 * ---------------------------------------------------------------------------
 * In production the right home for these reads is a PHYSICAL READ REPLICA, so
 * the scans never touch the primary's disk/CPU at all. This client points at
 * REPORTING_DATABASE_URL when it is set (the replica's connection string), and
 * falls back to the primary DATABASE_URL when it is not — so the whole feature
 * works today against a single database, and turning on a replica later is one
 * env var, not a code change. (Same philosophy as the mock/real payment and
 * notify providers.)
 *
 * A replica is eventually-consistent: a booking completed a second ago may not
 * be on the replica yet. That is FINE for reports — a dashboard that is a few
 * seconds stale is not wrong. Anything that must be read-your-write consistent
 * (never a report) uses the primary client in config/prisma.js instead.
 *
 * This client is READ-ONLY BY CONVENTION. Do not write through it: on a real
 * replica writes would fail outright, and keeping it read-only here means the
 * code behaves identically whether or not a replica is configured.
 */

const { PrismaClient } = require('@prisma/client');
const env = require('./env');

// datasourceUrl overrides the schema's datasource URL for THIS client only.
// When no replica is configured we deliberately reuse the primary URL — the
// isolation of a separate POOL still applies even against one database.
const reportingUrl = env.reporting.databaseUrl || env.databaseUrl;

const reportingPrisma = new PrismaClient({
  datasourceUrl: reportingUrl,
  log: ['warn', 'error'],
  errorFormat: env.isProd ? 'minimal' : 'pretty',
});

/** True when a distinct replica URL is actually in use (for /health surfacing). */
const usingReplica = Boolean(
  env.reporting.databaseUrl && env.reporting.databaseUrl !== env.databaseUrl
);

async function health() {
  const started = Date.now();
  try {
    await reportingPrisma.$queryRaw`SELECT 1`;
    return { status: 'up', usingReplica, latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'down', usingReplica, error: err.message };
  }
}

async function disconnect() {
  await reportingPrisma.$disconnect();
}

module.exports = { reportingPrisma, usingReplica, health, disconnect };