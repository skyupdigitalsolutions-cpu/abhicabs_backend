const { verifyMsg91WebhookSecret } = require('../integrations/whatsapp/verifySignature');
const { logger } = require('../config/logger');

/**
 * Checks the shared-secret header configured in MSG91's webhook setup
 * (see integrations/whatsapp/verifySignature.js for how that's set up).
 */
function requireMsg91WebhookSecret(req, res, next) {
  if (!verifyMsg91WebhookSecret(req.headers)) {
    logger.warn({ path: req.path }, '[webhookAuth] invalid or missing MSG91 webhook secret header');
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  return next();
}

module.exports = { requireMsg91WebhookSecret };
