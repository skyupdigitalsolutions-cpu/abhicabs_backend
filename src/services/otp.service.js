'use strict';

/**
 * src/services/otp.service.js
 *
 * Phone-based OTP login. State lives in Redis with TTLs, so nothing to clean up
 * and expiry is automatic.
 *
 * Three Redis keys per phone number:
 *   otp:<phone>          hash { hash, attempts, createdAt }   TTL 5 min
 *   otp:cd:<phone>       resend cooldown marker               TTL 30 s
 *   otp:day:<phone>      daily request counter                TTL 24 h
 *
 * ---------------------------------------------------------------------------
 * WHY THE OTP IS HASHED
 * ---------------------------------------------------------------------------
 * A plaintext OTP sitting in Redis is readable by anyone with database access —
 * an ops console, a leaked connection string, a backup. Storing SHA-256 means
 * the stored value cannot be turned back into a working code. SHA-256 rather
 * than bcrypt because verification happens on the login critical path and the
 * code is only alive for five minutes; brute force is bounded by the attempt
 * counter, not by hash cost.
 */

const crypto = require('crypto');
const { cache: redis, isCacheUp } = require('../config/redis');
const env = require('../config/env');
const emailService = require('./email.service');
const { ApiError } = require('../utils/helpers');

const OTP_TTL = env.otp.ttlSeconds;
const MAX_ATTEMPTS = env.otp.maxAttempts;
const COOLDOWN = env.otp.resendCooldownSeconds;
const MAX_PER_DAY = env.otp.maxPerDay;
const LENGTH = env.otp.length;

const key = (phone) => `otp:${phone}`;
const cooldownKey = (phone) => `otp:cd:${phone}`;
const dailyKey = (phone) => `otp:day:${phone}`;

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

/**
 * Uses randomInt, not Math.random.
 *
 * Math.random is not cryptographically secure and its output is predictable
 * from prior values. For a credential that grants account access, an attacker
 * who can predict the next code does not need to intercept the SMS at all.
 */
function generateCode() {
  const min = 10 ** (LENGTH - 1);
  const max = 10 ** LENGTH - 1;
  return String(crypto.randomInt(min, max + 1));
}

const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

/** Constant-time compare so response timing cannot leak how much matched. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/**
 * Channel order: email first when we have an address and a configured mailer,
 * console only as a development fallback, then give up.
 *
 * Email is the interim channel while the MSG91 DLT template is in approval. The
 * caller supplies the address because this service is keyed by phone number and
 * has no business reading the user table itself.
 */
async function deliver(phone, code, recipient = {}) {
  const email = recipient.email;

  if (email && emailService.isConfigured()) {
    const result = await emailService.sendOtpEmail({
      to: email,
      name: recipient.name,
      code,
      ttlSeconds: OTP_TTL,
    });
    return { delivered: true, channel: 'email', to: result.to };
  }

  if (env.otp.devMode) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────┐');
    console.log(`  │  OTP for ${phone.padEnd(14)}  ${code.padEnd(8)} │`);
    console.log(`  │  valid for ${String(OTP_TTL / 60).padEnd(28)}min │`);
    console.log('  └──────────────────────────────────────────┘');
    console.log('');
    return { delivered: true, channel: 'console' };
  }

  // TODO: MSG91 SMS once the DLT template is approved.
  //   await axios.post('https://control.msg91.com/api/v5/otp', {...})
  throw ApiError.badRequest('OTP delivery is not configured', 'OTP_PROVIDER_MISSING');
}

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

/**
 * Sends an OTP. The response is IDENTICAL whether or not the number is
 * registered, so this endpoint cannot be used to discover which phone numbers
 * have accounts.
 */
async function requestOtp(phone, recipient = {}) {
  if (!isCacheUp()) {
    // Without Redis there is no attempt counter and no cooldown, so an OTP
    // issued now would be brute-forceable. Refuse rather than degrade.
    throw new ApiError(503, 'OTP_UNAVAILABLE', 'Login by OTP is temporarily unavailable');
  }

  // --- resend cooldown ---
  const onCooldown = await redis.get(cooldownKey(phone));
  if (onCooldown) {
    const ttl = await redis.ttl(cooldownKey(phone));
    throw new ApiError(
      429,
      'OTP_COOLDOWN',
      `Please wait ${ttl > 0 ? ttl : COOLDOWN} seconds before requesting another code`
    );
  }

  // --- daily cap: SMS pumping fraud protection ---
  // Attackers trigger OTPs to premium-rate numbers and take a share of the
  // carrier revenue. Uncapped, this is a real and expensive attack.
  const dailyCount = await redis.incr(dailyKey(phone));
  if (dailyCount === 1) await redis.expire(dailyKey(phone), 86_400);
  if (dailyCount > MAX_PER_DAY) {
    throw new ApiError(429, 'OTP_DAILY_LIMIT', 'Daily OTP limit reached. Try again tomorrow.');
  }

  const code = generateCode();

  // Overwrites any previous code — requesting a new OTP invalidates the old one
  // and resets the attempt counter.
  await redis
    .multi()
    .hset(key(phone), {
      hash: hashCode(code),
      attempts: 0,
      createdAt: Date.now(),
    })
    .expire(key(phone), OTP_TTL)
    .set(cooldownKey(phone), '1', 'EX', COOLDOWN)
    .exec();

  // If the mail server refuses the message, the code above is already stored
  // and the cooldown already set — the user would be locked out for 30s waiting
  // on an email that never left. So undo all three keys and fail loudly instead.
  let delivery;
  try {
    delivery = await deliver(phone, code, recipient);
  } catch (err) {
    await redis.del(key(phone), cooldownKey(phone));
    await redis.decr(dailyKey(phone));

    if (err instanceof ApiError) throw err;

    console.error(`[otp] delivery failed for ${phone}: ${err.message}`);
    throw new ApiError(
      502,
      'OTP_DELIVERY_FAILED',
      'We could not send your code right now. Please try again in a moment.'
    );
  }

  return {
    sent: true,
    expiresInSeconds: OTP_TTL,
    resendAfterSeconds: COOLDOWN,
    // Which channel it actually went out on, and a masked address so the client
    // can say "check a***@gmail.com" instead of leaving the user guessing.
    channel: delivery.channel,
    ...(delivery.to ? { sentTo: delivery.to } : {}),
    // Never return the code, even in dev — it would end up in a client log.
    ...(delivery.channel === 'console' ? { devHint: 'printed to server console' } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Verify
 * ------------------------------------------------------------------ */

/**
 * Returns true on success and CONSUMES the code. Throws on failure.
 *
 * Single-use is essential: without deletion a valid code could be replayed for
 * the rest of its five-minute window by anyone who saw it.
 */
async function verifyOtp(phone, code) {
  if (!isCacheUp()) {
    throw new ApiError(503, 'OTP_UNAVAILABLE', 'Login by OTP is temporarily unavailable');
  }

  const record = await redis.hgetall(key(phone));

  if (!record || !record.hash) {
    throw ApiError.unauthorized('Code is invalid or has expired', 'OTP_INVALID');
  }

  // --- attempt cap: bounds brute force ---
  // A 6-digit code has a million combinations. Five tries makes guessing
  // hopeless; unlimited tries makes it trivial.
  const attempts = Number(record.attempts || 0);
  if (attempts >= MAX_ATTEMPTS) {
    await redis.del(key(phone));
    throw ApiError.unauthorized('Too many incorrect attempts. Request a new code.', 'OTP_LOCKED');
  }

  if (!safeEqual(record.hash, hashCode(code))) {
    const now = await redis.hincrby(key(phone), 'attempts', 1);
    const remaining = Math.max(0, MAX_ATTEMPTS - now);

    if (remaining === 0) {
      await redis.del(key(phone));
      throw ApiError.unauthorized('Too many incorrect attempts. Request a new code.', 'OTP_LOCKED');
    }
    throw ApiError.unauthorized(
      `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      'OTP_INVALID'
    );
  }

  // Success — consume the code and clear the cooldown.
  await redis.del(key(phone), cooldownKey(phone));
  return true;
}

/** For support tooling: clear a stuck OTP state. Audit-log any use of this. */
async function reset(phone) {
  if (!isCacheUp()) return 0;
  return redis.del(key(phone), cooldownKey(phone), dailyKey(phone));
}

module.exports = {
  requestOtp,
  verifyOtp,
  reset,
  generateCode,
  hashCode,
};