'use strict';

/**
 * src/services/audit.service.js
 *
 * Writes to the audit_logs table created on Day 1. Nothing wrote to it until now.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO CALL THIS, AND THE DIFFERENCE MATTERS
 * ---------------------------------------------------------------------------
 *
 *   record(tx, {...})   — inside a transaction. The audit entry and the change
 *                         it describes commit together or not at all. Use this
 *                         for anything with legal or financial consequence.
 *
 *   recordAsync({...})  — fire and forget. Never throws, never blocks. Use for
 *                         observability-only events where losing one row is
 *                         acceptable.
 *
 * The distinction is not stylistic. If an accountType change committed but its
 * audit entry silently failed, you would have a customer billed as CORPORATE
 * with no record of who authorised it — which is exactly the question a tax
 * audit asks. Transactional writes make that state unreachable.
 */

const { prisma } = require('../config/prisma');

/** Stable action names. Typos here produce an audit trail nobody can query. */
const ACTIONS = Object.freeze({
  ACCOUNT_TYPE_CHANGED: 'ACCOUNT_TYPE_CHANGED',
  CORPORATE_CREATED: 'CORPORATE_CREATED',
  CORPORATE_UPDATED: 'CORPORATE_UPDATED',
  CORPORATE_DEACTIVATED: 'CORPORATE_DEACTIVATED',
  EMPLOYEE_ATTACHED: 'EMPLOYEE_ATTACHED',
  EMPLOYEE_DETACHED: 'EMPLOYEE_DETACHED',
  CREDIT_LIMIT_CHANGED: 'CREDIT_LIMIT_CHANGED',
  CUSTOMER_UPDATED: 'CUSTOMER_UPDATED',
  PERMISSION_GRANTED: 'PERMISSION_GRANTED',
  PERMISSION_REVOKED: 'PERMISSION_REVOKED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  USER_DEACTIVATED: 'USER_DEACTIVATED',
});

const ENTITIES = Object.freeze({
  CUSTOMER: 'customer',
  CORPORATE_ACCOUNT: 'corporate_account',
  ADDRESS: 'address',
  USER: 'user',
  ROLE_PERMISSION: 'role_permission',
});

/**
 * Fields never written to the audit trail, even if present in a before/after
 * snapshot. An audit log is widely readable inside the company — it must not
 * become the one place a password hash is casually exposed.
 */
const REDACT = new Set(['password', 'tokenHash', 'token_hash', 'refreshToken', 'otp', 'code']);

function sanitise(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT.has(k)) continue;
    // Prisma Decimal and Date do not survive JSON round-trips intact.
    if (v && typeof v === 'object' && typeof v.toFixed === 'function') out[k] = v.toString();
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

/**
 * Reduces a full record to just the fields that changed.
 *
 * Storing whole rows makes the log enormous and the actual change hard to spot.
 * "creditLimit: 50000 -> 200000" is the useful artefact.
 */
function diff(before, after) {
  const a = sanitise(before) || {};
  const b = sanitise(after) || {};
  const changedBefore = {};
  const changedAfter = {};

  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const from = a[key];
    const to = b[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changedBefore[key] = from ?? null;
      changedAfter[key] = to ?? null;
    }
  }
  return { before: changedBefore, after: changedAfter };
}

/* ------------------------------------------------------------------ *
 * Transactional write
 * ------------------------------------------------------------------ */

/**
 * @param {object} tx     Prisma transaction client (or `prisma` for a standalone write)
 * @param {object} entry
 *   actor      {object}  req.user
 *   action     {string}  from ACTIONS
 *   entityType {string}  from ENTITIES
 *   entityId   {string}
 *   before     {object=} full record before the change
 *   after      {object=} full record after the change
 *   meta       {object=} request context: ip, userAgent
 */
async function record(tx, { actor, action, entityType, entityId, before, after, meta = {} }) {
  const changes = before || after ? diff(before, after) : { before: null, after: null };

  return tx.auditLog.create({
    data: {
      actorId: actor?.id || null,
      action,
      entityType,
      entityId: entityId ? String(entityId).slice(0, 64) : null,
      before: changes.before,
      after: changes.after,
      ip: (meta.ip || '').slice(0, 45) || null,
      userAgent: (meta.userAgent || '').slice(0, 255) || null,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Fire-and-forget write
 * ------------------------------------------------------------------ */

/**
 * For observability-only events. Swallows its own errors so an audit failure
 * can never break the request that triggered it.
 *
 * Do NOT use this for anything with financial or legal consequence — use
 * record() inside the transaction instead.
 */
function recordAsync(entry) {
  record(prisma, entry).catch((err) => {
    console.error(`[audit] failed to record ${entry.action}:`, err.message);
  });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function list({ page = 1, limit = 50, actorId, entityType, entityId, action, from, to }) {
  const where = {};
  if (actorId) where.actorId = actorId;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (action) where.action = action;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        actor: { select: { id: true, name: true, email: true, role: true } },
      },
    }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}

/** Full history for one record — "who changed this account and when". */
async function trailFor(entityType, entityId, limit = 100) {
  return prisma.auditLog.findMany({
    where: { entityType, entityId: String(entityId) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { id: true, name: true, email: true, role: true } } },
  });
}

module.exports = { ACTIONS, ENTITIES, record, recordAsync, list, trailFor, diff, sanitise };