'use strict';

/**
 * src/middlewares/serviceAuth.js
 *
 * Authenticates a trusted SERVICE — the WhatsApp bot — as distinct from a
 * human. It does NOT authenticate a customer and deliberately cannot act as
 * one: all it does is prove the caller is our own bot, which then exchanges
 * that proof for a normal short-lived customer token.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT LET THE KEY ACT AS THE CUSTOMER DIRECTLY
 * ---------------------------------------------------------------------------
 * The obvious design is to accept `x-service-key` plus a phone number on every
 * booking route and set req.user from the phone. It is fewer moving parts and
 * it is a much worse trade:
 *
 *   - One static secret would authorise acting as ANY customer. Its blast
 *     radius is the whole customer base, and unlike a JWT it never expires.
 *   - It would live in the bot's .env, its CI, and whatever the bot logs.
 *   - Every protected route would need a second auth path, so every future
 *     route would have to remember to handle both.
 *   - The audit trail would record "the bot" rather than a real user.
 *
 * Exchanging it for a 15-minute customer token keeps every existing route
 * exactly as it is, bounds the damage of a leaked key to one short window, and
 * leaves audit_logs naming an actual person.
 */

const crypto = require('node:crypto');
const env = require('../config/env');
const { ApiError, asyncHandler } = require('../utils/helpers');

/**
 * Constant-time comparison.
 *
 * `a !== b` on secrets leaks their contents through timing: it returns on the
 * first differing byte, so an attacker can recover a key one character at a
 * time by measuring response latency. Rare to be practical over the internet,
 * free to prevent.
 *
 * Lengths are compared first because timingSafeEqual throws on a mismatch —
 * and that length check is itself a small leak, which is why the key should be
 * long and random rather than a guessable word.
 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const requireServiceKey = asyncHandler(async (req, _res, next) => {
  const configured = env.services.whatsappBotKey;

  /*
   * An unset key must FAIL, not pass.
   *
   * With a naive `key !== configured` check, an environment that never set the
   * variable compares undefined to undefined and lets everyone through — the
   * endpoint would be wide open precisely where it was least configured.
   */
  if (!configured) {
    throw ApiError.unauthorized(
      'Service authentication is not configured on this server',
      'SERVICE_AUTH_UNCONFIGURED',
    );
  }

  const presented = req.get('x-service-key');
  if (!presented || !safeEqual(presented, configured)) {
    throw ApiError.unauthorized('Invalid service key', 'INVALID_SERVICE_KEY');
  }

  // Marks the request as machine-originated. Anything that wants to treat a
  // bot differently — rate limits, audit notes — can read this.
  req.service = { name: 'whatsapp-bot' };
  return next();
});

module.exports = { requireServiceKey };