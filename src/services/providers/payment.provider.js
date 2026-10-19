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
const { ApiError } = require('../../utils/helpers');

/** Every adapter must implement these three. */
const REQUIRED_METHODS = ['createOrder', 'verifyWebhookSignature', 'parseWebhook'];

/*
 * OPTIONAL capabilities — collecting money without the app.
 *
 * Deliberately not in REQUIRED_METHODS. A gateway that cannot host a payment
 * page, or an account that has not had Payment Links switched on, must still
 * be a valid provider for everything else; promoting these to required would
 * mean a missing feature stops the server booting and takes bookings down with
 * it. Callers ask supports() and get a clean 501 instead.
 */
const OPTIONAL_METHODS = Object.freeze([
  'createPaymentLink',
  'cancelPaymentLink',
  'resendPaymentLink',
  'createQrCode',
  'closeQrCode',
]);

/**
 * Does the active provider implement this capability?
 *
 * Checked at REQUEST time rather than boot, because the answer can change
 * without a deploy: Razorpay enables Payment Links per account, so the same
 * code and the same keys can go from unsupported to supported overnight.
 */
function supports(method) {
  return typeof getProvider()[method] === 'function';
}

function assertImplements(adapter, name) {
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length) {
    throw new Error(`[payment] Provider "${name}" is missing: ${missing.join(', ')}`);
  }
  return adapter;
}

/* ------------------------------------------------------------------ *
 * Refusing to ask for money a fake gateway cannot take
 * ------------------------------------------------------------------ */

/**
 * The three calls that put a payable instrument in front of a customer.
 *
 * Only these. Cancelling a link, closing a QR, verifying a signature and
 * parsing a webhook all stay available when the guard is active: an instrument
 * raised before the misconfiguration was noticed still needs to be cancellable,
 * and a webhook that arrives for one still needs to be processed.
 */
const COLLECTING_METHODS = Object.freeze([
  'createOrder',
  'createPaymentLink',
  'createQrCode',
]);

/**
 * Wraps the adapter so the collecting calls fail loudly instead of producing
 * an instrument nobody can pay.
 *
 * ---------------------------------------------------------------------------
 * WHY HERE RATHER THAN AT BOOT, AND WHY NOT AT EACH CALL SITE
 * ---------------------------------------------------------------------------
 * At boot it was fatal to the whole process — config/env.js is required by
 * config/prisma.js, so a payments problem stopped bookings, dispatch and every
 * worker. At each call site it would be four copies of the same check
 * (createOrder, createLink, createQr, and both standalone variants), and the
 * fifth one somebody adds next month would not have it.
 *
 * Wrapping the adapter is the one place every path already funnels through.
 * `supports()` still reports true for a wrapped method, which is correct: the
 * capability exists, it is the configuration that is refusing.
 *
 * 409 rather than 503 deliberately. The error middleware replaces the message
 * on any 5xx in production, and the message is the entire value of this
 * error — an admin seeing "Internal server error" learns nothing, while
 * "Razorpay is in test mode" is actionable without opening a log.
 */
function guardCollections(adapter) {
  if (!env.payment.blockCollections) return adapter;

  const reason = env.payment.razorpay.isTestKey
    ? 'Razorpay is in test mode (rzp_test_ key), so payments would report success without money moving'
    : `the "${adapter.name}" gateway cannot take real money`;

  const wrapped = Object.create(adapter);

  for (const method of COLLECTING_METHODS) {
    if (typeof adapter[method] !== 'function') continue;
    wrapped[method] = async () => {
      throw new ApiError(
        409,
        'PAYMENT_GATEWAY_NOT_LIVE',
        `Cannot collect payment: ${reason}. Set live Razorpay keys, or set ` +
          'ALLOW_MOCK_PAYMENTS=true if this environment is for testing.',
      );
    };
  }

  return wrapped;
}

let cached = null;

/**
 * Returns the configured adapter.
 *
 * Falls back to the mock rather than throwing when a real gateway has no
 * credentials, so development runs with zero setup.
 *
 * That fallback used to be silent in production too — a console.warn and
 * nothing else — which meant a deployment with PAYMENT_PROVIDER unset, or a
 * razorpay key left empty, happily issued mock.invalid payment links and
 * accepted simulated captures. guardCollections() closes that: in production
 * without a gateway that can take real money, every call that would ask a
 * customer to pay now throws instead.
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

  // Checked against the RAW adapter, before wrapping: the contract is a fact
  // about the adapter, not about this environment's configuration.
  cached = guardCollections(assertImplements(build(), name));

  console.log(
    `[payment] provider: ${cached.name}` +
      (cached.name === 'razorpay' && env.payment.razorpay.isTestKey ? ' (TEST MODE)' : '') +
      (env.payment.blockCollections ? ' — new collections BLOCKED' : ''),
  );

  /*
   * env.js prints the full banner for "no gateway that can take real money".
   * This one covers the case it cannot see: the mock running in production
   * with collections deliberately permitted, where captures are free.
   */
  if (cached.name === 'mock' && env.isProd && !env.payment.blockCollections) {
    console.warn(
      '[payment] WARNING: mock provider in production with ALLOW_MOCK_PAYMENTS=true — ' +
        'payments can be marked captured without money moving. Testing only.',
    );
  }
  return cached;
}

/** Test hook — lets a suite inject a fake without touching env. */
function setProvider(adapter) {
  cached = adapter ? assertImplements(adapter, 'injected') : null;
}

module.exports = { getProvider, setProvider, supports, REQUIRED_METHODS, OPTIONAL_METHODS };