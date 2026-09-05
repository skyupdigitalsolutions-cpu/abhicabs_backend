'use strict';

/**
 * src/services/auth.service.js
 *
 * All authentication business logic. Controllers stay thin and call into here.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { prisma, isUniqueViolation } = require('../config/prisma');
const tokens = require('../utils/tokens');
const { ApiError, publicUser } = require('../utils/helpers');

const BCRYPT_ROUNDS = 12;

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

async function issueTokens(user, meta = {}) {
  const accessToken = tokens.signAccessToken({ userId: user.id, role: user.role });
  const refreshToken = tokens.signRefreshToken({ userId: user.id });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: tokens.hashToken(refreshToken),
      expiresAt: tokens.refreshExpiryDate(),
      userAgent: (meta.userAgent || '').slice(0, 255) || null,
      ip: (meta.ip || '').slice(0, 45) || null,
    },
  });

  return { accessToken, refreshToken };
}

/* ---------------------------------------------------------------- *
 * Register
 * ---------------------------------------------------------------- */

async function register({ name, email, phone }, meta) {
  // Registration is passwordless — riders authenticate by OTP. The password
  // column is non-null, so we store an unguessable random hash that nobody can
  // ever log in with (there is no plaintext, so password login is impossible
  // for these accounts by construction).
  const hash = await bcrypt.hash(crypto.randomUUID(), BCRYPT_ROUNDS);

  let user;
  try {
    // Create-and-catch rather than findFirst-then-create: the unique index on
    // email is atomic, so two simultaneous signups cannot both succeed.
    user = await prisma.user.create({
      data: { name, email, password: hash, phone: phone || null, role: 'USER' },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');
    }
    throw err;
  }

  const issued = await issueTokens(user, meta);
  return { user: publicUser(user), ...issued };
}

/* ---------------------------------------------------------------- *
 * Login
 * ---------------------------------------------------------------- */

async function login({ email, password }, meta) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Compare against a dummy hash when the user is missing so the response time
  // is the same either way. Otherwise an attacker can tell which emails are
  // registered purely by how fast the request comes back.
  const hashToCompare =
    user?.password || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const passwordOk = await bcrypt.compare(password, hashToCompare);

  if (!user || !passwordOk) {
    // Deliberately vague — never reveal whether it was the email or the
    // password that was wrong.
    throw ApiError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw ApiError.forbidden('Your account has been deactivated', 'ACCOUNT_INACTIVE');
  }

  const issued = await issueTokens(user, meta);
  return { user: publicUser(user), ...issued };
}

/* ---------------------------------------------------------------- *
 * Refresh (with rotation)
 * ---------------------------------------------------------------- */

/**
 * Each refresh token is single use. The old row is revoked and a new token is
 * issued, so a stolen token has a short useful life and reuse is detectable.
 */
async function refresh(refreshToken, meta) {
  let payload;
  try {
    payload = tokens.verifyRefreshToken(refreshToken);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Session expired, please log in again', 'REFRESH_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH');
  }

  const tokenHash = tokens.hashToken(refreshToken);

  // Atomically claim this token: only succeeds if it is still live. Two
  // concurrent refreshes cannot both win — the loser sees count 0.
  const claim = await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  });

  if (claim.count === 0) {
    // Either already used, already revoked, or unknown. Treat every case as a
    // dead session — the user simply logs in again.
    throw ApiError.unauthorized('Session is no longer valid', 'REFRESH_REVOKED');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_NOT_FOUND');
  if (!user.isActive) throw ApiError.forbidden('Account is deactivated', 'ACCOUNT_INACTIVE');

  const issued = await issueTokens(user, meta);
  return { user: publicUser(user), ...issued };
}

/* ---------------------------------------------------------------- *
 * Logout
 * ---------------------------------------------------------------- */

async function logout(refreshToken) {
  if (!refreshToken) return { revoked: 0 };
  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash: tokens.hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: result.count };
}

/** "Log out everywhere" — also call this after a password change. */
async function logoutAll(userId) {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: result.count };
}

/* ---------------------------------------------------------------- *
 * Change password
 * ---------------------------------------------------------------- */

async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('User not found');

  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) throw ApiError.unauthorized('Current password is incorrect', 'WRONG_PASSWORD');

  const same = await bcrypt.compare(newPassword, user.password);
  if (same) throw ApiError.badRequest('New password must be different from the current one');

  await prisma.user.update({
    where: { id: userId },
    data: { password: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
  });

  // A password change must invalidate every existing session, or a thief who
  // already has a refresh token keeps their access.
  await logoutAll(userId);

  return { message: 'Password changed. Please log in again.' };
}

/** Housekeeping — run on a schedule; this table grows with every login. */
async function pruneExpiredTokens() {
  const result = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  changePassword,
  pruneExpiredTokens,
  BCRYPT_ROUNDS,
};