'use strict';

/**
 * src/middlewares/auth.js
 *
 * requireAuth      — verifies the Bearer access token, loads the user
 * requireRole      — role gate, used AFTER requireAuth
 * requireSelfOrAdmin — a user may act on their own record; an admin on any
 */

const jwt = require('jsonwebtoken');
const { verifyAccessToken } = require('../utils/tokens');
const { prisma } = require('../config/prisma');
const { ApiError, asyncHandler } = require('../utils/helpers');

function extractBearer(req) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length ? token : null;
}

/**
 * Verifies the token, then re-loads the user from the database.
 *
 * Why hit the DB rather than trusting the token alone: a token issued 10
 * minutes ago still says "ADMIN" even if the account was demoted or
 * deactivated 9 minutes ago. For an admin panel that matters more than the
 * saved query.
 */
const requireAuth = asyncHandler(async (req, res, next) => {
  const token = extractBearer(req);
  if (!token) throw ApiError.unauthorized('Authorization header missing', 'NO_TOKEN');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // The client interceptor keys off this code to decide whether to
      // silently refresh or hard-logout. Keep it stable.
      throw ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });

  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_NOT_FOUND');
  if (!user.isActive) throw ApiError.forbidden('Account is deactivated', 'ACCOUNT_INACTIVE');

  req.user = user;
  next();
});

/** Usage: router.get('/users', requireAuth, requireRole('ADMIN'), handler) */
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

/**
 * Guards :id routes so a user can only touch their own record.
 *
 * This is the defence against IDOR — the single most common real-world API
 * vulnerability, where changing the id in the URL exposes someone else's data.
 * Never rely on the URL alone; always compare against the authenticated user.
 */
function requireSelfOrAdmin(paramName = 'id') {
  return function ownershipGate(req, res, next) {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === 'ADMIN') return next();
    if (req.params[paramName] === req.user.id) return next();
    // 404 rather than 403 — do not confirm that the record exists.
    return next(ApiError.notFound());
  };
}

module.exports = { requireAuth, requireRole, requireSelfOrAdmin };