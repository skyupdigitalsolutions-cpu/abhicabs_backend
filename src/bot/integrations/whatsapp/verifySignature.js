const crypto = require('crypto');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

/**
 * MSG91 does not HMAC-sign webhooks; it lets you attach a custom header.
 * In MSG91 add header  X-Webhook-Secret: <same value as MSG91_WEBHOOK_SECRET>.
 * With NODE_ENV=production a missing secret REJECTS every request (fail closed);
 * in development it only warns so local testing still works.
 */
function verifyMsg91WebhookSecret(headers) {
  const expected = env.MSG91_WEBHOOK_SECRET;
  if (!expected) {
    if (env.NODE_ENV === 'production') return false;
    logger.warn('[webhookAuth] MSG91_WEBHOOK_SECRET is not set - accepting unauthenticated webhooks (development only)');
    return true;
  }
  const provided = String(headers['x-webhook-secret'] || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyMsg91WebhookSecret };
