'use strict';

/**
 * src/services/providers/mock.provider.js
 *
 * Offline payment gateway. No account, no network, no real charges.
 *
 * This is the DEFAULT provider. It lets the entire payments module — order
 * creation, the status machine, webhook signature verification, replay dedup,
 * partial and full capture — be developed and tested with no credentials.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL AND WHAT IS FAKED
 * ---------------------------------------------------------------------------
 * The SIGNATURE is real. It is a genuine HMAC-SHA256 over the raw body using a
 * shared secret, verified in constant time — exactly as a real gateway works.
 * This matters: the point of the mock is to test the security-critical path,
 * so a test that passes here would pass against Razorpay too. Faking the
 * signature check would test nothing.
 *
 * What is faked is only the NETWORK: order ids are generated locally and no
 * money moves. `simulateWebhook()` builds a correctly-signed webhook envelope
 * so a test (or a Postman call) can drive the capture flow end to end.
 */

const crypto = require('crypto');
const env = require('../../config/env');

const NAME = 'mock';

/** Rupees (string/number) -> integer paise, the gateway boundary unit. */
function toPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

/** Integer paise -> rupee string, back to the unit the money lib uses. */
function toRupees(paise) {
  return (Number(paise) / 100).toFixed(2);
}

/**
 * Creates a gateway order. In a real gateway this is a network call that
 * reserves an order id the client SDK then pays against. Here it is local and
 * deterministic-ish (random suffix so two orders never collide).
 */
async function createOrder({ amount, currency = 'INR', bookingId, purpose, receipt }) {
  const orderId = `order_mock_${crypto.randomBytes(9).toString('hex')}`;
  return {
    orderId,
    amount: toPaise(amount),
    currency,
    status: 'created',
    raw: {
      id: orderId,
      entity: 'order',
      amount: toPaise(amount),
      currency,
      receipt: receipt || bookingId,
      notes: { bookingId, purpose },
      created_at: Math.floor(Date.now() / 1000),
    },
  };
}

/**
 * Verifies an HMAC-SHA256 signature over the RAW request bytes.
 *
 * ---------------------------------------------------------------------------
 * WHY rawBody AND NOT req.body
 * ---------------------------------------------------------------------------
 * The signature is computed by the gateway over the exact bytes it sent. Once
 * express.json() has parsed and re-serialised the body, key order and spacing
 * can differ, and the recomputed HMAC no longer matches. The webhook route is
 * therefore mounted with express.raw() so this function sees the original
 * bytes. See app.js.
 *
 * Constant-time comparison so an attacker cannot recover the expected signature
 * one byte at a time by timing the response.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;

  const secret = env.payment.webhookSecret;
  if (!secret) {
    console.warn('[payment:mock] no PAYMENT_WEBHOOK_SECRET set — rejecting webhook');
    return false;
  }

  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac('sha256', secret).update(buf).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // timingSafeEqual throws if lengths differ, so guard first — and the guard
  // itself must not short-circuit in a way that leaks length beyond what the
  // signature format already reveals.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Normalises a gateway webhook into the shape the rest of the system uses.
 *
 * Every gateway names its fields differently; this is the one place that knows
 * the mock's wire format. rawBody is the parsed JSON (the controller parses it
 * AFTER the signature has been verified over the raw bytes).
 */
function parseWebhook(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const entity = p.payload?.payment?.entity || {};

  return {
    eventId: p.id,
    eventType: p.event,
    providerOrderId: entity.order_id || null,
    providerPaymentId: entity.id || null,
    amountPaise: entity.amount != null ? Number(entity.amount) : null,
    amount: entity.amount != null ? toRupees(entity.amount) : null,
    status: entity.status || null,     // 'captured' | 'authorized' | 'failed'
    method: (entity.method || '').toUpperCase() || null,
    raw: p,
  };
}

/* ------------------------------------------------------------------ *
 * TEST HELPER — builds a correctly-signed webhook envelope.
 *
 * Not part of the provider interface. Used by the /webhooks/mock/simulate test
 * route and by the suite so a captured-payment event can be replayed without a
 * real gateway. Returns both the raw body string and the signature header, so
 * a caller sends exactly what a gateway would.
 * ------------------------------------------------------------------ */
function simulateWebhook({
  eventId,
  eventType = 'payment.captured',
  providerOrderId,
  providerPaymentId,
  amount,
  status = 'captured',
  method = 'upi',
}) {
  const body = {
    id: eventId || `evt_mock_${crypto.randomBytes(8).toString('hex')}`,
    event: eventType,
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: providerPaymentId || `pay_mock_${crypto.randomBytes(8).toString('hex')}`,
          order_id: providerOrderId,
          amount: toPaise(amount),
          currency: 'INR',
          status,
          method,
        },
      },
    },
  };

  const raw = JSON.stringify(body);
  const secret = env.payment.webhookSecret || '';
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');

  return { raw, signature, body };
}

module.exports = {
  name: NAME,
  createOrder,
  verifyWebhookSignature,
  parseWebhook,
  simulateWebhook,
  toPaise,
  toRupees,
};