'use strict';

/**
 * src/services/otp.service.js
 *
 * OTP login. State lives in Redis with TTLs, so nothing to clean up and expiry
 * is automatic.
 *
 * Three Redis keys per SUBJECT — an opaque string chosen by the caller, which
 * is the user's id in practice:
 *   otp:<subject>          hash { hash, attempts, createdAt }   TTL 5 min
 *   otp:cd:<subject>       resend cooldown marker               TTL 30 s
 *   otp:day:<subject>      daily request counter                TTL 24 h
 *
 * Keying by account id rather than by the typed identifier matters: a person
 * can reach the same account by email today and by phone later, and codes must
 * not fork into two independent buckets that each carry their own attempt
 * counter. It also means the cap cannot be sidestepped by varying the spelling
 * of an address.
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

const key = (subject) => `otp:${subject}`;
const cooldownKey = (subject) => `otp:cd:${subject}`;
const dailyKey = (subject) => `otp:day:${subject}`;

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
 * caller supplies the address because this service is keyed by an opaque
 * subject and has no business reading the user table itself.
 */
async function deliver(subject, code, recipient = {}) {
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
    const label = String(recipient.email || subject).slice(0, 28);
    console.log(`  │  OTP for ${label.padEnd(28)} ${code.padEnd(8)} │`);
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
 * Sends an OTP for `subject` — an opaque key, not something the caller typed.
 * Resolving an identifier to an account is the caller's job; this service only
 * issues, stores and checks codes.
 */
async function requestOtp(subject, recipient = {}) {
  if (!isCacheUp()) {
    // Without Redis there is no attempt counter and no cooldown, so an OTP
    // issued now would be brute-forceable. Refuse rather than degrade.
    throw new ApiError(503, 'OTP_UNAVAILABLE', 'Login by OTP is temporarily unavailable');
  }

  // --- resend cooldown ---
  const onCooldown = await redis.get(cooldownKey(subject));
  if (onCooldown) {
    const ttl = await redis.ttl(cooldownKey(subject));
    throw new ApiError(
      429,
      'OTP_COOLDOWN',
      `Please wait ${ttl > 0 ? ttl : COOLDOWN} seconds before requesting another code`
    );
  }

  // --- daily cap ---
  // Uncapped, this endpoint is a free mail cannon: an attacker can point it at
  // one account and bury the real user, or burn through the sending quota so
  // nobody's codes get through.
  const dailyCount = await redis.incr(dailyKey(subject));
  if (dailyCount === 1) await redis.expire(dailyKey(subject), 86_400);
  if (dailyCount > MAX_PER_DAY) {
    throw new ApiError(429, 'OTP_DAILY_LIMIT', 'Daily OTP limit reached. Try again tomorrow.');
  }

  const code = generateCode();

  // Overwrites any previous code — requesting a new OTP invalidates the old one
  // and resets the attempt counter.
  await redis
    .multi()
    .hset(key(subject), {
      hash: hashCode(code),
      attempts: 0,
      createdAt: Date.now(),
    })
    .expire(key(subject), OTP_TTL)
    .set(cooldownKey(subject), '1', 'EX', COOLDOWN)
    .exec();

  // If the mail server refuses the message, the code above is already stored
  // and the cooldown already set — the user would be locked out for 30s waiting
  // on an email that never left. So undo all three keys and fail loudly instead.
  let delivery;
  try {
    delivery = await deliver(subject, code, recipient);
  } catch (err) {
    await redis.del(key(subject), cooldownKey(subject));
    await redis.decr(dailyKey(subject));

    if (err instanceof ApiError) throw err;

    console.error(`[otp] delivery failed for ${recipient.email || subject}: ${err.message}`);
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
async function verifyOtp(subject, code) {
  if (!isCacheUp()) {
    throw new ApiError(503, 'OTP_UNAVAILABLE', 'Login by OTP is temporarily unavailable');
  }

  const record = await redis.hgetall(key(subject));

  if (!record || !record.hash) {
    throw ApiError.unauthorized('Code is invalid or has expired', 'OTP_INVALID');
  }

  // --- attempt cap: bounds brute force ---
  // A 6-digit code has a million combinations. Five tries makes guessing
  // hopeless; unlimited tries makes it trivial.
  const attempts = Number(record.attempts || 0);
  if (attempts >= MAX_ATTEMPTS) {
    await redis.del(key(subject));
    throw ApiError.unauthorized('Too many incorrect attempts. Request a new code.', 'OTP_LOCKED');
  }

  if (!safeEqual(record.hash, hashCode(code))) {
    const now = await redis.hincrby(key(subject), 'attempts', 1);
    const remaining = Math.max(0, MAX_ATTEMPTS - now);

    if (remaining === 0) {
      await redis.del(key(subject));
      throw ApiError.unauthorized('Too many incorrect attempts. Request a new code.', 'OTP_LOCKED');
    }
    throw ApiError.unauthorized(
      `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      'OTP_INVALID'
    );
  }

  // Success — consume the code and clear the cooldown.
  await redis.del(key(subject), cooldownKey(subject));
  return true;
}

/** For support tooling: clear a stuck OTP state. Audit-log any use of this. */
async function reset(subject) {
  if (!isCacheUp()) return 0;
  return redis.del(key(subject), cooldownKey(subject), dailyKey(subject));
}

module.exports = {
  requestOtp,
  verifyOtp,
  reset,
  generateCode,
  hashCode,
};