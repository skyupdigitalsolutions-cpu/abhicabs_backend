'use strict';

/**
 * src/services/authOtp.service.js
 *
 * OTP login/signup. Kept separate from auth.service.js so the password flow and
 * the phone flow can evolve independently — customers and drivers use OTP,
 * staff use passwords.
 *
 * The account-creation policy here matters: verifying a phone number proves
 * control of that number and nothing more, so an OTP login can only ever create
 * or authenticate a USER. Staff roles are assigned by an admin, never earned by
 * receiving an SMS.
 */

const otpService = require('./otp.service');
const tokens = require('../utils/tokens');
const { prisma } = require('../config/prisma');
const { ApiError, publicUser } = require('../utils/helpers');

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

/**
 * Sends a code — but ONLY to numbers that already have an account. This app is
 * registration-gated: an unregistered number is refused with NOT_REGISTERED so
 * the client can send the user to sign up first. (This deliberately reveals
 * whether a number is registered, which is the intended product behaviour here.)
 */
async function requestOtp(phone) {
  const existing = await prisma.user.findFirst({
    where: { phone, role: { in: ['USER', 'DRIVER'] } },
    select: { id: true },
  });
  if (!existing) {
    throw ApiError.notFound(
      'No account found for this number. Please register first.',
      'NOT_REGISTERED',
    );
  }

  const result = await otpService.requestOtp(phone);
  return { ...result, message: 'A verification code has been sent' };
}

/* ------------------------------------------------------------------ *
 * Verify → log in or sign up
 * ------------------------------------------------------------------ */

async function verifyAndLogin({ phone, code }, meta = {}) {
  // Throws on wrong/expired/locked. Consumes the code on success.
  await otpService.verifyOtp(phone, code);

  const user = await prisma.user.findFirst({
    where: { phone, role: { in: ['USER', 'DRIVER'] } },
    orderBy: { createdAt: 'asc' },
  });

  // OTP no longer creates accounts. A verified code proves control of the
  // number, but without an existing account there is nothing to log in to — the
  // user must register (name + email + mobile) first.
  if (!user) {
    throw ApiError.notFound(
      'No account found for this number. Please register first.',
      'NOT_REGISTERED',
    );
  }

  if (!user.isActive) {
    throw ApiError.forbidden('Your account has been deactivated', 'ACCOUNT_INACTIVE');
  }

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

  return { user: publicUser(user), accessToken, refreshToken };
}

module.exports = { requestOtp, verifyAndLogin };