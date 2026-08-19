'use strict';

/**
 * src/services/providers/payment.provider.js
 *
 * The provider interface every payment gateway adapter implements, plus the
 * factory that selects one from configuration.
 *
 * ---------------------------------------------------------------------------
 * WHY AN INTERFACE RATHER THAN CALLING RAZORPAY DIRECTLY
 * ---------------------------------------------------------------------------
 * The same reasoning as the maps provider, but the stakes are higher:
 *
 *  1. Credentials are not a blocker. The gateway account, KYC and API keys can
 *     take days. Building against an interface means the whole payments module —
 *     order creation, the status machine, webhook dedup, balance collection —
 *     is written and TESTED today against the mock, and going live later is one
 *     env var plus a secret.
 *
 *  2. The mock makes every money path testable offline, deterministically, with
 *     no real charges. Signature verification, webhook replay, partial capture:
 *     all exercised without touching a real gateway.
 *
 *  3. Gateways get swapped. Pricing changes, a second gateway is added for
 *     redundancy, one region needs a different processor. Downstream code must
 *     never know which gateway took the money.
 *
 * Every adapter returns the SAME shapes, so nothing downstream knows or cares
 * which gateway is active.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 *   createOrder({ amount, currency, bookingId, purpose, receipt })
 *     -> { orderId, amount, currency, status, raw }
 *
 *   verifyWebhookSignature(rawBody, signature)
 *     -> boolean            // constant-time HMAC check over the RAW bytes
 *
 *   parseWebhook(rawBody, headers)
 *     -> { eventId, eventType, providerOrderId, providerPaymentId,
 *          amount, status, method, raw }
 *
 * amount is ALWAYS in the smallest currency unit at the gateway boundary
 * (paise for INR). We convert to/from rupee strings at this boundary and
 * nowhere else, so the money lib only ever sees rupees.
 */

const env = require('../../config/env');

/** Every adapter must implement these three. */
const REQUIRED_METHODS = ['createOrder', 'verifyWebhookSignature', 'parseWebhook'];

function assertImplements(adapter, name) {
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length) {
    throw new Error(`[payment] Provider "${name}" is missing: ${missing.join(', ')}`);
  }
  return adapter;
}

let cached = null;

/**
 * Returns the configured adapter.
 *
 * Falls back to the mock rather than throwing when a real gateway has no
 * credentials. In development this means the app runs with zero setup; in
 * production the env guard (see config/env.js) refuses to boot with the mock,
 * so this fallback can never silently take real money through a fake gateway.
 */
function getProvider() {
  if (cached) return cached;

  const name = (env.payment.provider || 'mock').toLowerCase();

  const build = () => {
    switch (name) {
      case 'razorpay':
        if (!env.payment.razorpay.keyId || !env.payment.razorpay.keySecret) {
          console.warn('[payment] PAYMENT_PROVIDER=razorpay but keys are empty — using mock');
          return require('./mock.provider');
        }
        return require('./razorpay.provider');

      case 'mock':
        return require('./mock.provider');

      default:
        console.warn(`[payment] Unknown PAYMENT_PROVIDER "${name}" — using mock`);
        return require('./mock.provider');
    }
  };

  cached = assertImplements(build(), name);
  console.log(`[payment] provider: ${cached.name}`);
  return cached;
}

/** Test hook — lets a suite inject a fake without touching env. */
function setProvider(adapter) {
  cached = adapter ? assertImplements(adapter, 'injected') : null;
}

module.exports = { getProvider, setProvider, REQUIRED_METHODS };