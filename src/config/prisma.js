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
};

const isUniqueViolation = (err) => err && err.code === CODES.UNIQUE_VIOLATION;
const isNotFound = (err) => err && err.code === CODES.RECORD_NOT_FOUND;
const violatedFields = (err) => (err && err.meta && err.meta.target) || [];

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
  isNotFound,
  violatedFields,
  health,
  disconnect,
};