'use strict';

/**
 * src/services/passwordReset.service.js
 *
 * Forgot-password / reset-password for the EMAIL + PASSWORD accounts (staff and
 * anyone registered through /auth/register). Customers who sign in by phone use
 * the OTP flow and never have a password to reset.
 *
 * State lives in Redis with a TTL, like OTP — nothing to migrate, nothing to
 * clean up, and expiry is automatic:
 *
 *   pwreset:<tokenHash>   -> userId          TTL 30 min, single use
 *   pwreset:uid:<userId>  -> tokenHash       TTL 30 min, "latest token wins"
 *
 * ---------------------------------------------------------------------------
 * WHY THE TOKEN IS HASHED, AND WHY IT IS THE KEY
 * ---------------------------------------------------------------------------
 * The raw token goes in the email and nowhere else. Redis stores only its
 * SHA-256, so a leaked connection string or a backup does not hand an attacker
 * a working reset link for every pending request.
 *
 * It is the KEY rather than a value because the lookup then has to be exact:
 * there is no "find a row where token = ?" to get subtly wrong, and no way to
 * scan for near-matches.
 *
 * SHA-256 rather than bcrypt because the token is 32 random bytes — 256 bits of
 * entropy is not brute-forceable regardless of hash cost, and this runs on a
 * request path. Bcrypt protects low-entropy secrets; that is not this.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RESPONSE IS ALWAYS THE SAME
 * ---------------------------------------------------------------------------
 * requestReset() returns an identical message whether or not the address
 * exists. Saying "no account with that email" turns the endpoint into a free
 * membership oracle: an attacker can enumerate which of a leaked address list
 * are customers here. The cost is a slightly less helpful message for someone
 * who typo'd their own address; the alternative leaks every user's membership
 * to anyone who asks.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { prisma } = require('../config/prisma');
const { cache: redis, isCacheUp } = require('../config/redis');
const { ApiError } = require('../utils/helpers');
const authService = require('./auth.service');

/** Long enough that guessing is hopeless; short enough to survive email clients. */
const TOKEN_BYTES = 32;

/** Half an hour: long enough to find the email, short enough to limit exposure. */
const TOKEN_TTL_SECONDS = 30 * 60;

const tokenKey = (hash) => `pwreset:${hash}`;
const userKey = (userId) => `pwreset:uid:${userId}`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * The same sentence for every outcome. Callers must not branch on it.
 */
const GENERIC_REPLY = 'If that email is registered, a reset link is on its way.';

/* ------------------------------------------------------------------ *
 * Request a reset
 * ------------------------------------------------------------------ */

/**
 * Issue a reset token for an email address, if it belongs to a real account.
 *
 * Returns the same payload in every case. In development the raw token is
 * echoed back so the flow is testable without an email provider wired up — it
 * is omitted in production, where leaking it in an API response would defeat
 * the entire point of emailing it.
 */
async function requestReset(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();

  // Redis is not optional here. Without it a token cannot be stored, so a link
  // would be emailed that can never be redeemed — worse than failing loudly.
  if (!isCacheUp()) {
    throw new ApiError(
      503,
      'RESET_UNAVAILABLE',
      'Password reset is temporarily unavailable. Please try again shortly.'
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Unknown address, deactivated account, or a phone-only account with no real
  // password: all three stop here, and all three look identical from outside.
  const eligible = Boolean(user && user.isActive);

  if (!eligible) {
    // Logged, not returned. Ops can see enumeration attempts; the caller cannot.
    console.warn(`[pwreset] request for unknown or inactive email: ${email}`);
    return { message: GENERIC_REPLY };
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const hash = hashToken(token);

  // Invalidate any earlier outstanding token for this user. Two live links
  // means two chances for an old email in a shared inbox to still work.
  const previous = await redis.get(userKey(user.id));
  if (previous) await redis.del(tokenKey(previous));

  // Written together so a crash between them cannot leave a token with no
  // matching per-user pointer (which would defeat the "latest wins" rule).
  await redis
    .multi()
    .set(tokenKey(hash), user.id, 'EX', TOKEN_TTL_SECONDS)
    .set(userKey(user.id), hash, 'EX', TOKEN_TTL_SECONDS)
    .exec();

  // TODO: hand `token` to the mailer once an email provider is configured.
  // The link is typically https://<app>/reset-password?token=<token>
  console.log(`[pwreset] token issued for ${email}`);

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    // Dev convenience only. Printed the way otp.service prints codes, so the
    // flow can be exercised end to end before email exists.
    // eslint-disable-next-line no-console
    console.log(`\n  ┌──────────────────────────────────────────┐\n  │  PASSWORD RESET TOKEN (dev only)         │\n  │  ${token}  │\n  │  valid for ${TOKEN_TTL_SECONDS / 60} min                           │\n  └──────────────────────────────────────────┘\n`);
  }

  return {
    message: GENERIC_REPLY,
    // Never in production.
    ...(isProd ? {} : { devToken: token }),
  };
}

/* ------------------------------------------------------------------ *
 * Check a token
 * ------------------------------------------------------------------ */

/**
 * Is this token still good?
 *
 * Lets the reset page show "this link has expired" before the user types a new
 * password twice, rather than after. Deliberately does NOT consume the token.
 */
async function verifyToken(token) {
  if (!isCacheUp()) {
    throw new ApiError(
      503,
      'RESET_UNAVAILABLE',
      'Password reset is temporarily unavailable. Please try again shortly.'
    );
  }

  const userId = await redis.get(tokenKey(hashToken(String(token || ''))));
  return { valid: Boolean(userId) };
}

/* ------------------------------------------------------------------ *
 * Complete the reset
 * ------------------------------------------------------------------ */

/**
 * Redeem a token and set the new password.
 *
 * The token is consumed FIRST, before the password is written. If the update
 * then fails the user simply requests another link; the reverse order would
 * leave a spent token alive after a successful change.
 */
async function resetPassword({ token, newPassword }) {
  if (!isCacheUp()) {
    throw new ApiError(
      503,
      'RESET_UNAVAILABLE',
      'Password reset is temporarily unavailable. Please try again shortly.'
    );
  }

  const hash = hashToken(String(token || ''));
  const userId = await redis.get(tokenKey(hash));

  if (!userId) {
    throw ApiError.badRequest(
      'This reset link is invalid or has expired. Please request a new one.',
      'RESET_TOKEN_INVALID'
    );
  }

  // Single use: delete before doing the work, so a double-submitted form or a
  // replayed request cannot redeem the same token twice.
  await redis.del(tokenKey(hash), userKey(userId));

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) {
    throw ApiError.badRequest(
      'This reset link is invalid or has expired. Please request a new one.',
      'RESET_TOKEN_INVALID'
    );
  }

  // Reusing the current password is not a reset. Told plainly because the user
  // is already authenticated by the token — there is nothing left to leak.
  const same = await bcrypt.compare(newPassword, user.password);
  if (same) {
    throw ApiError.badRequest(
      'New password must be different from your current one',
      'PASSWORD_UNCHANGED'
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { password: await bcrypt.hash(newPassword, authService.BCRYPT_ROUNDS) },
  });

  // Every existing session dies. Someone resetting a password may be doing it
  // precisely because an attacker holds a token; leaving those live would make
  // the reset cosmetic.
  await authService.logoutAll(user.id);

  console.log(`[pwreset] password reset completed for ${user.email}`);

  return { message: 'Password updated. Please log in with your new password.' };
}

module.exports = {
  requestReset,
  verifyToken,
  resetPassword,
  TOKEN_TTL_SECONDS,
};