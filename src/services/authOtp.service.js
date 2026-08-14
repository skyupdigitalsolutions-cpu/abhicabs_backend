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
 * Sends a code. The response is identical whether or not the number is
 * registered, so this cannot be used to discover which numbers have accounts.
 */
async function requestOtp(phone) {
  const result = await otpService.requestOtp(phone);

  // Deliberately does NOT reveal whether the account exists.
  return {
    ...result,
    message: 'If the number is valid, a verification code has been sent',
  };
}

/* ------------------------------------------------------------------ *
 * Verify → log in or sign up
 * ------------------------------------------------------------------ */

async function verifyAndLogin({ phone, code, name }, meta = {}) {
  // Throws on wrong/expired/locked. Consumes the code on success.
  await otpService.verifyOtp(phone, code);

  let user = await prisma.user.findFirst({
    where: { phone, role: { in: ['USER', 'DRIVER'] } },
    orderBy: { createdAt: 'asc' },
  });

  let isNewAccount = false;

  if (!user) {
    // ---- first-time signup ----
    // A random password is stored so the column stays NOT NULL and no one can
    // log in with a guessable value. The user authenticates by OTP; if they
    // later want a password they go through a reset flow.
    const randomPassword = require('crypto').randomBytes(32).toString('base64');
    const bcrypt = require('bcryptjs');

    // Placeholder email keeps the unique (email, role) constraint satisfiable
    // for phone-first accounts. Replaced when the user supplies a real one.
    const placeholderEmail = `phone_${phone}@placeholder.local`;

    try {
      user = await prisma.user.create({
        data: {
          name: (name || '').trim() || `User ${phone.slice(-4)}`,
          email: placeholderEmail,
          phone,
          password: await bcrypt.hash(randomPassword, 12),
          role: 'USER',            // hard-coded — never from input
        },
      });

      // Every phone-first account is a customer.
      await prisma.customer.create({
        data: { userId: user.id, accountType: 'RETAIL' },
      });

      isNewAccount = true;
    } catch (err) {
      // Two simultaneous verifications for the same new number: one wins, the
      // other reads the row the winner created.
      if (err.code === 'P2002') {
        user = await prisma.user.findFirst({ where: { phone } });
        if (!user) throw err;
      } else {
        throw err;
      }
    }
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

  return { user: publicUser(user), accessToken, refreshToken, isNewAccount };
}

module.exports = { requestOtp, verifyAndLogin };