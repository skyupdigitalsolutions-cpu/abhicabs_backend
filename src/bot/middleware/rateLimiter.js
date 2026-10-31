const rateLimit = require('express-rate-limit');

/** General webhook protection — generous, since Meta can burst-deliver. */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

/** Tighter limit for admin/monitoring endpoints. */
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Per-customer limiter keyed by WhatsApp number, applied inside the controller
 * (not as Express middleware) since the number is only known after parsing
 * the payload — see webhook.controller.js perCustomerRateOk(). */
const customerMessageBuckets = new Map();
const CUSTOMER_WINDOW_MS = 60 * 1000;
const CUSTOMER_MAX_MESSAGES = 20;

function perCustomerRateOk(whatsappNumber) {
  const now = Date.now();
  const bucket = customerMessageBuckets.get(whatsappNumber) || [];
  const recent = bucket.filter((ts) => now - ts < CUSTOMER_WINDOW_MS);
  recent.push(now);
  customerMessageBuckets.set(whatsappNumber, recent);
  return recent.length <= CUSTOMER_MAX_MESSAGES;
}

module.exports = { webhookLimiter, adminLimiter, perCustomerRateOk };
