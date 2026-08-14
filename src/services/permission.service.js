'use strict';

/**
 * src/services/permission.service.js
 *
 * Resolves a role to its permission set, reading the role_permissions table
 * seeded on Day 1 (37 rows).
 *
 * Two cache layers, because this runs on EVERY authorised request:
 *
 *   L1  in-process Map, 60s   — no network hop at all
 *   L2  Redis, 6h              — shared across instances
 *   L3  Postgres                — source of truth
 *
 * The L1 layer matters most: if Redis goes down, permission checks keep working
 * from local memory instead of hammering the database on every request. A
 * permission lookup is not something that should be able to fail.
 */

const { prisma } = require('../config/prisma');
const cacheService = require('./cache.service');

/* ------------------------------------------------------------------ *
 * Permission catalogue
 * ------------------------------------------------------------------ */

/**
 * Canonical list. Used to validate that a route's required permission actually
 * exists — a typo like 'BOOKING_CANCELL' would otherwise silently deny
 * everyone, and the bug would look like a data problem.
 */
const PERMISSIONS = Object.freeze({
  USER_MANAGE: 'USER_MANAGE',
  CUSTOMER_MANAGE: 'CUSTOMER_MANAGE',
  CORPORATE_MANAGE: 'CORPORATE_MANAGE',
  BOOKING_CREATE: 'BOOKING_CREATE',
  BOOKING_MANAGE: 'BOOKING_MANAGE',
  BOOKING_CANCEL: 'BOOKING_CANCEL',
  FARE_EDIT: 'FARE_EDIT',
  DISPATCH_MANAGE: 'DISPATCH_MANAGE',
  VEHICLE_MANAGE: 'VEHICLE_MANAGE',
  DRIVER_APPROVE: 'DRIVER_APPROVE',
  PAYMENT_VIEW: 'PAYMENT_VIEW',
  PAYMENT_REFUND: 'PAYMENT_REFUND',
  INVOICE_MANAGE: 'INVOICE_MANAGE',
  REPORT_VIEW: 'REPORT_VIEW',
  SETTINGS_MANAGE: 'SETTINGS_MANAGE',
  AUDIT_VIEW: 'AUDIT_VIEW',
  TRIP_MANAGE: 'TRIP_MANAGE',
});

const PERMISSION_VALUES = new Set(Object.values(PERMISSIONS));

/* ------------------------------------------------------------------ *
 * L1 cache
 * ------------------------------------------------------------------ */

const L1_TTL_MS = 60_000;
const l1 = new Map(); // role -> { perms: Set, expiresAt }

function l1Get(role) {
  const entry = l1.get(role);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    l1.delete(role);
    return undefined;
  }
  return entry.perms;
}

function l1Set(role, perms) {
  l1.set(role, { perms, expiresAt: Date.now() + L1_TTL_MS });
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * @returns {Promise<Set<string>>} the permissions granted to a role
 */
async function getPermissionsForRole(role) {
  const local = l1Get(role);
  if (local) return local;

  const list = await cacheService.getOrSet(
    cacheService.keys.permissions(role),
    async () => {
      const rows = await prisma.rolePermission.findMany({
        where: { role },
        select: { permission: true },
      });
      return rows.map((r) => r.permission);
    },
    { ttl: cacheService.TTL.STATIC, cacheNull: false }
  );

  const perms = new Set(list || []);
  l1Set(role, perms);
  return perms;
}

async function roleHasPermission(role, permission) {
  const perms = await getPermissionsForRole(role);
  return perms.has(permission);
}

/** Does the role hold ANY of these? Used by requirePermission. */
async function roleHasAny(role, permissions) {
  const perms = await getPermissionsForRole(role);
  return permissions.some((p) => perms.has(p));
}

/** Does the role hold ALL of these? For genuinely compound operations. */
async function roleHasAll(role, permissions) {
  const perms = await getPermissionsForRole(role);
  return permissions.every((p) => perms.has(p));
}

/**
 * Full map, for an admin settings screen.
 */
async function getAllRolePermissions() {
  const rows = await prisma.rolePermission.findMany({
    orderBy: [{ role: 'asc' }, { permission: 'asc' }],
    select: { role: true, permission: true },
  });

  return rows.reduce((acc, { role, permission }) => {
    (acc[role] = acc[role] || []).push(permission);
    return acc;
  }, {});
}

/* ------------------------------------------------------------------ *
 * Mutation — invalidate BOTH cache layers
 * ------------------------------------------------------------------ */

async function grant(role, permission) {
  if (!PERMISSION_VALUES.has(permission)) {
    throw new Error(`[permissions] Unknown permission: ${permission}`);
  }
  // create-and-catch rather than checking first: the composite unique index is
  // atomic, so concurrent grants cannot both insert.
  try {
    await prisma.rolePermission.create({ data: { role, permission } });
  } catch (err) {
    if (err.code !== 'P2002') throw err;   // already granted — idempotent
  }
  await invalidate(role);
}

async function revoke(role, permission) {
  await prisma.rolePermission.deleteMany({ where: { role, permission } });
  await invalidate(role);
}

/**
 * Clears L2 immediately and expires L1 locally.
 *
 * Note the honest limitation: other instances keep their L1 copy for up to 60
 * seconds. That is an accepted trade — permission changes are rare, and a
 * one-minute propagation delay is much cheaper than a database read on every
 * single request. If you ever need instant propagation, publish an
 * invalidation message over Redis pub/sub (Day 10 adds that transport).
 */
async function invalidate(role) {
  l1.delete(role);
  await cacheService.del(cacheService.keys.permissions(role));
}

async function invalidateAll() {
  l1.clear();
  await cacheService.delByPrefix(cacheService.keys.permissionsAll());
}

/** Called at boot so the first authorised request is not a cold read. */
async function warm() {
  const roles = ['ADMIN', 'OPS', 'FINANCE', 'FLEET', 'SUPPORT', 'USER', 'DRIVER'];
  const results = await Promise.allSettled(roles.map((r) => getPermissionsForRole(r)));
  const loaded = results.filter((r) => r.status === 'fulfilled').length;
  const total = results.reduce(
    (n, r) => n + (r.status === 'fulfilled' ? r.value.size : 0),
    0
  );
  console.log(`[permissions] warmed ${loaded}/${roles.length} roles, ${total} grants`);
  return total;
}

module.exports = {
  PERMISSIONS,
  PERMISSION_VALUES,
  getPermissionsForRole,
  roleHasPermission,
  roleHasAny,
  roleHasAll,
  getAllRolePermissions,
  grant,
  revoke,
  invalidate,
  invalidateAll,
  warm,
};