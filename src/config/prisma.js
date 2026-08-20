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
};