'use strict';

/**
 * src/middlewares/auth.js   — UPDATED for Day 2
 *
 * requireAuth         verifies the Bearer access token, loads the user
 * requireRole         coarse role gate (kept — still right for a few routes)
 * requirePermission   NEW: fine-grained gate backed by role_permissions
 * requireAllPermissions NEW: for genuinely compound operations
 * requireSelfOrAdmin  ownership guard for :id routes
 * attachPermissions   NEW: exposes the caller's permission list to the client
 */

const jwt = require('jsonwebtoken');
const { verifyAccessToken } = require('../utils/tokens');
const { prisma } = require('../config/prisma');
const { ApiError, asyncHandler } = require('../utils/helpers');
const permissionService = require('../services/permission.service');

function extractBearer(req) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length ? token : null;
}

/* ------------------------------------------------------------------ *
 * requireAuth
 * ------------------------------------------------------------------ */

/**
 * Verifies the token, then re-loads the user from the database.
 *
 * Why the extra query: a token issued ten minutes ago still asserts
 * role: ADMIN even if that account was demoted or deactivated nine minutes
 * ago. For an admin console that gap is unacceptable, so we pay one indexed
 * primary-key lookup per request to get immediate revocation.
 */
const requireAuth = asyncHandler(async (req, res, next) => {
  const token = extractBearer(req);
  if (!token) throw ApiError.unauthorized('Authorization header missing', 'NO_TOKEN');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    // The client interceptor keys off these codes to decide between a silent
    // refresh and a hard logout. Keep them stable.
    if (err instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, name: true, email: true, phone: true, role: true, isActive: true },
  });

  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_NOT_FOUND');
  if (!user.isActive) throw ApiError.forbidden('Account is deactivated', 'ACCOUNT_INACTIVE');

  req.user = user;
  return next();
});

/* ------------------------------------------------------------------ *
 * requireRole — coarse
 * ------------------------------------------------------------------ */

/**
 * Still appropriate where the distinction genuinely IS the role rather than a
 * capability — e.g. a driver-only endpoint. For everything an ops team touches,
 * prefer requirePermission.
 */
function requireRole(...allowed) {
  const permitted = new Set(allowed.flat());
  return function roleGate(req, res, next) {
    if (!req.user) return next(ApiError.unauthorized());
    if (!permitted.has(req.user.role)) {
      return next(ApiError.forbidden('Insufficient permissions'));
    }
    return next();
  };
}

/* ------------------------------------------------------------------ *
 * requirePermission — fine-grained
 * ------------------------------------------------------------------ */

/**
 * Passes if the caller's role holds ANY of the listed permissions.
 *
 *   router.post('/refunds', requireAuth, requirePermission('PAYMENT_REFUND'), h)
 *
 * ANY rather than ALL because listing several permissions almost always means
 * "either of these roles may do this", not "must hold both". Use
 * requireAllPermissions for the rare compound case.
 *
 * Permission names are validated at ROUTE-DEFINITION time, not per request: a
 * typo would otherwise deny everyone silently and look like a data bug.
 */
function requirePermission(...required) {
  const list = required.flat();

  if (list.length === 0) {
    throw new Error('[auth] requirePermission called with no permissions');
  }
  for (const p of list) {
    if (!permissionService.PERMISSION_VALUES.has(p)) {
      throw new Error(
        `[auth] Unknown permission "${p}". Add it to PERMISSIONS in permission.service.js ` +
        `and seed it into role_permissions.`
      );
    }
  }

  return asyncHandler(async (req, res, next) => {
    if (!req.user) throw ApiError.unauthorized();

    const ok = await permissionService.roleHasAny(req.user.role, list);
    if (!ok) {
      // Name the missing permission. This is a staff-facing API, so the extra
      // detail is a support aid, not an information leak — the caller is
      // already authenticated and the permission names are not secret.
      throw ApiError.forbidden(
        `This action requires: ${list.join(' or ')}`,
        'PERMISSION_DENIED'
      );
    }
    return next();
  });
}

/** All of them. For operations that genuinely combine two capabilities. */
function requireAllPermissions(...required) {
  const list = required.flat();
  for (const p of list) {
    if (!permissionService.PERMISSION_VALUES.has(p)) {
      throw new Error(`[auth] Unknown permission "${p}"`);
    }
  }
  return asyncHandler(async (req, res, next) => {
    if (!req.user) throw ApiError.unauthorized();
    const ok = await permissionService.roleHasAll(req.user.role, list);
    if (!ok) {
      throw ApiError.forbidden(
        `This action requires all of: ${list.join(', ')}`,
        'PERMISSION_DENIED'
      );
    }
    return next();
  });
}

/* ------------------------------------------------------------------ *
 * attachPermissions
 * ------------------------------------------------------------------ */

/**
 * Puts the caller's permission list on req.permissions so a response can tell
 * the admin UI which buttons to render.
 *
 * This is a convenience for the client, NOT a security boundary — the server
 * still enforces every action independently. A client that hides a button is
 * not protecting anything.
 */
const attachPermissions = asyncHandler(async (req, res, next) => {
  if (req.user) {
    const perms = await permissionService.getPermissionsForRole(req.user.role);
    req.permissions = [...perms];
  }
  return next();
});

/* ------------------------------------------------------------------ *
 * requireSelfOrAdmin
 * ------------------------------------------------------------------ */

/**
 * Guards :id routes so a user can only act on their own record.
 *
 * This is the IDOR defence — the most common real-world API vulnerability,
 * where changing a UUID in the URL exposes someone else's data.
 *
 * Returns 404 rather than 403 on purpose: a 403 confirms the record exists,
 * which is itself an information leak.
 */
function requireSelfOrAdmin(paramName = 'id') {
  return function ownershipGate(req, res, next) {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === 'ADMIN') return next();
    if (req.params[paramName] === req.user.id) return next();
    return next(ApiError.notFound());
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requirePermission,
  requireAllPermissions,
  requireSelfOrAdmin,
  attachPermissions,
};