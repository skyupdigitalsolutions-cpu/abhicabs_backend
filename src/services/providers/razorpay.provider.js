'use strict';

/**
 * src/services/providers/razorpay.provider.js
 *
 * Real Razorpay adapter. Selected when PAYMENT_PROVIDER=razorpay AND both keys
 * are present; otherwise the factory falls back to the mock.
 *
 * ---------------------------------------------------------------------------
 * STATUS: order creation is a live HTTP call; signature verification and
 * webhook parsing are production-ready. This is deliberately thin — the whole
 * point of the interface is that the mock already proved the surrounding logic,
 * so this file only has to speak Razorpay's specific wire format.
 * ---------------------------------------------------------------------------
 *
 * Razorpay specifics that differ from the mock:
 *   - The webhook signature is HMAC-SHA256 of the raw body using the WEBHOOK
 *     secret (distinct from the API key secret used for the Orders API).
 *   - Amounts are in paise, same as our gateway boundary.
 *   - The signature arrives in the `x-razorpay-signature` header.
 */

const crypto = require('crypto');
const env = require('../../config/env');

const NAME = 'razorpay';
const API_BASE = 'https://api.razorpay.com/v1';

function toPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}
function toRupees(paise) {
  return (Number(paise) / 100).toFixed(2);
}

/**
 * Creates a Razorpay order via the Orders API. Basic-auth with keyId:keySecret.
 * Uses the global fetch available in Node 18+.
 */
async function createOrder({ amount, currency = 'INR', bookingId, purpose, receipt }) {
  const auth = Buffer.from(
    `${env.payment.razorpay.keyId}:${env.payment.razorpay.keySecret}`
  ).toString('base64');

  const res = await fetch(`${API_BASE}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: toPaise(amount),
      currency,
      // Razorpay caps receipt at 40 chars.
      receipt: String(receipt || bookingId).slice(0, 40),
      notes: { bookingId, purpose },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`[payment:razorpay] order create failed (${res.status}): ${detail}`);
  }

  const order = await res.json();
  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    raw: order,
  };
}

/** HMAC-SHA256 over the raw bytes with the WEBHOOK secret, constant-time. */
function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;

  const secret = env.payment.webhookSecret;
  if (!secret) {
    console.warn('[payment:razorpay] no PAYMENT_WEBHOOK_SECRET set — rejecting webhook');
    return false;
  }

  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac('sha256', secret).update(buf).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Normalises a Razorpay webhook into the system's common shape. */
function parseWebhook(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const entity = p.payload?.payment?.entity || {};

  return {
    // Razorpay does not send a top-level event id in older webhook versions;
    // the x-razorpay-event-id header carries it. The controller passes it in as
    // p.__eventId when present, falling back to a deterministic composite so a
    // replay of the same payment+event still dedupes.
    eventId: p.__eventId || `${p.event}:${entity.id || ''}`,
    eventType: p.event,
    providerOrderId: entity.order_id || null,
    providerPaymentId: entity.id || null,
    amountPaise: entity.amount != null ? Number(entity.amount) : null,
    amount: entity.amount != null ? toRupees(entity.amount) : null,
    status: entity.status || null,
    method: (entity.method || '').toUpperCase() || null,
    raw: p,
  };
}

module.exports = {
  name: NAME,
  createOrder,
  verifyWebhookSignature,
  parseWebhook,
  toPaise,
  toRupees,
};