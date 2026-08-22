'use strict';

/**
 * src/config/prisma.js
 *
 * ONE PrismaClient for the whole process. Each client opens its own connection
 * pool, so creating one per request would exhaust Postgres almost immediately.
 */

const { PrismaClient } = require('@prisma/client');
const env = require('../config/env');

const prisma = new PrismaClient({
  log: env.isProd ? ['warn', 'error'] : ['warn', 'error'],
  errorFormat: env.isProd ? 'minimal' : 'pretty',
});

/**
 * Day 14 — statement_timeout and pool tuning.
 *
 * These are set on the connection string, which you control in .env:
 *
 *   DATABASE_URL="postgresql://…?connection_limit=20&pool_timeout=10&statement_timeout=15000"
 *
 * connection_limit  caps the pool so a burst cannot open more Postgres
 *                   connections than the database allows (exhausting it starves
 *                   every other client). Size it to about
 *                   (db max_connections / number of app instances) with headroom.
 * pool_timeout      seconds a request waits for a free connection before failing
 *                   fast instead of hanging — backpressure at the pool.
 * statement_timeout milliseconds; Postgres kills any single query that runs
 *                   longer, so one pathological query cannot pin a connection
 *                   indefinitely. This is the single most important line of
 *                   defence against a slow query taking the app down.
 *
 * For a specific query you expect to be heavy (a report, a wide scan) and want a
 * TIGHTER bound than the global, wrap it with withStatementTimeout() below — it
 * sets the timeout for that transaction only, via SET LOCAL.
 */

/**
 * Runs `fn(tx)` inside a transaction whose statements time out after `ms`.
 * SET LOCAL scopes the timeout to this transaction, so it never leaks to the
 * next query that reuses the pooled connection.
 */
async function withStatementTimeout(ms, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Number(ms)}`);
    return fn(tx);
  });
}

/**
 * Prisma error codes worth handling by name.
 *
 * P2002 (unique violation) is the one that matters most: for duplicate
 * prevention, always try the write and CATCH this, rather than doing a
 * findFirst-then-create. Insert-and-catch is atomic; check-then-act is a race
 * two concurrent requests can both win.
 */
const CODES = {
  UNIQUE_VIOLATION: 'P2002',
  FOREIGN_KEY_VIOLATION: 'P2003',
  RECORD_NOT_FOUND: 'P2025',
  // Postgres SQLSTATE for an EXCLUDE-constraint violation. Prisma has no P-code
  // for it, so it arrives as a PrismaClientUnknownRequestError whose message
  // carries the SQLSTATE and the constraint name. This is what the allocation
  // overlap guards (excl_allocation_vehicle_overlap / _driver_overlap) raise
  // when two ACTIVE holds on one vehicle/driver would intersect in time.
  EXCLUSION_VIOLATION: '23P01',
};

const isUniqueViolation = (err) => err && err.code === CODES.UNIQUE_VIOLATION;
const isNotFound = (err) => err && err.code === CODES.RECORD_NOT_FOUND;
const violatedFields = (err) => (err && err.meta && err.meta.target) || [];

/**
 * True when the error is a Postgres EXCLUDE-constraint violation, optionally for
 * a specific constraint. Because Prisma does not code it, we match on the
 * SQLSTATE (23P01) that appears in the raw message, and optionally the
 * constraint name. Used by the allocation service to turn the database's
 * "these two holds overlap" into a clean 409 rather than a 500.
 */
const isExclusionViolation = (err, constraintName = null) => {
  if (!err) return false;
  const text = `${err.message || ''} ${err.meta?.message || ''} ${err.meta?.code || ''}`;
  const isExcl =
    err.meta?.code === CODES.EXCLUSION_VIOLATION ||
    text.includes(CODES.EXCLUSION_VIOLATION) ||
    text.includes('exclusion constraint') ||
    text.includes('conflicting key value violates');
  if (!isExcl) return false;
  return constraintName ? text.includes(constraintName) : true;
};

async function health() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'up', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

async function disconnect() {
  await prisma.$disconnect();
}

module.exports = {
  prisma,
  CODES,
  isUniqueViolation,
  isExclusionViolation,
  isNotFound,
  violatedFields,
  health,
  disconnect,
  withStatementTimeout,
};