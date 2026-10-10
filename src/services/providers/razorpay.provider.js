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

/* ------------------------------------------------------------------ *
 * Collecting money WITHOUT the app: Payment Links and UPI QR codes
 *
 * Both exist for the same customer: one who is not holding the rider app open.
 * A phone booking, a walk-in, a corporate coordinator paying for someone
 * else's trip, a rider whose app will not open the checkout.
 *
 *   LINK  Razorpay hosts a page and (optionally) sends the SMS/email itself.
 *         Right for "pay before tomorrow" — it survives being sent and read
 *         later, and Razorpay chases it with reminders.
 *
 *   QR    A UPI QR image. Right for someone standing in front of you or on
 *         WhatsApp right now. Nothing is sent anywhere — the admin shares the
 *         image. UPI only, so no cards.
 *
 * BOTH ARE JUST ANOTHER WAY TO REACH THE SAME ORDER. Neither gets its own
 * capture path: each produces an id that is stored as providerOrderId, and the
 * existing webhook pipeline moves the payment to CAPTURED and writes the
 * ledger entry exactly as it does for a checkout order. The only thing this
 * file adds is knowing which entity in the webhook carries that id.
 * ------------------------------------------------------------------ */

function authHeader() {
  const auth = Buffer.from(
    `${env.payment.razorpay.keyId}:${env.payment.razorpay.keySecret}`,
  ).toString('base64');
  return `Basic ${auth}`;
}

async function call(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    /*
     * Razorpay puts the useful part in error.description — "Payment Links are
     * not enabled for this account", "customer contact is invalid". Surfacing
     * the raw status alone sends an admin to support with nothing to act on.
     */
    let detail = text;
    try {
      detail = JSON.parse(text)?.error?.description || text;
    } catch {
      /* not JSON — use the body as-is */
    }
    const err = new Error(`[payment:razorpay] ${method} ${path} failed (${res.status}): ${detail}`);
    err.statusCode = res.status;
    err.providerMessage = detail;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

/**
 * A hosted payment page, optionally delivered by Razorpay over SMS and email.
 *
 * `reference_id` is set to our own booking number so the Razorpay dashboard is
 * searchable by the thing staff actually know. It must be unique per link,
 * so the caller suffixes it — a booking can legitimately need a second link
 * (the first expired, the fare changed), and reusing the reference would be
 * rejected by the API with an error no admin can decode.
 *
 * NOTE ON expire_by: Razorpay requires at least 15 minutes in the future and
 * takes UNIX SECONDS, not milliseconds. Sending ms silently books an expiry
 * fifty thousand years out, which is not an error anywhere — the link just
 * never expires.
 */
async function createPaymentLink({
  amount,
  currency = 'INR',
  bookingId,
  purpose,
  referenceId,
  description,
  customer,
  notifyBySms = true,
  notifyByEmail = true,
  expireBy,
  callbackUrl,
}) {
  const link = await call('/payment_links', {
    body: {
      amount: toPaise(amount),
      currency,
      // Razorpay would otherwise accept a part payment and leave the booking
      // half-settled with no way for the webhook to know what to do.
      accept_partial: false,
      description: String(description || `Trip ${bookingId}`).slice(0, 2048),
      reference_id: String(referenceId || bookingId).slice(0, 40),
      customer: {
        name: customer?.name || undefined,
        email: customer?.email || undefined,
        contact: customer?.phone || undefined,
      },
      // Razorpay does the sending. We have no transactional SMS template for
      // this (sms.service only sends OTPs through MSG91's templated API), and
      // adding one would mean a DLT registration for a message the gateway
      // already sends for free.
      notify: { sms: !!notifyBySms, email: !!notifyByEmail },
      reminder_enable: true,
      notes: { bookingId, purpose },
      ...(expireBy ? { expire_by: Math.floor(new Date(expireBy).getTime() / 1000) } : {}),
      ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
    },
  });

  return {
    /*
     * THE LINK ID, NOT AN ORDER ID — and this is the load-bearing decision in
     * the whole feature.
     *
     * Razorpay creates the underlying order only when the customer actually
     * pays, so there is no order id to store at creation time. The id we have
     * is plink_xxx, so that is what goes in providerOrderId, and parseWebhook
     * below must therefore read the payment_link entity rather than the
     * payment entity's order_id. Store the order id instead and the row can
     * never be matched; store the link id without teaching parseWebhook about
     * it and the money arrives with nothing to attach it to.
     */
    id: link.id,
    shareUrl: link.short_url,
    status: link.status,
    amount: link.amount,
    currency: link.currency,
    expiresAt: link.expire_by ? new Date(link.expire_by * 1000) : null,
    raw: link,
  };
}

/** Cancels a link that has not been paid. Razorpay rejects a paid one. */
async function cancelPaymentLink(linkId) {
  return call(`/payment_links/${linkId}/cancel`);
}

/** Re-sends an existing link over SMS or email without creating a new one. */
async function resendPaymentLink(linkId, medium = 'sms') {
  return call(`/payment_links/${linkId}/notify_by/${medium}`);
}

/**
 * A fixed-amount, single-use UPI QR code.
 *
 * single_use + fixed_amount, both deliberately:
 *   - multiple_use would let the same image be paid twice, and the second
 *     payment arrives against a booking that is already settled.
 *   - a variable amount lets the customer type whatever they like, which turns
 *     every capture into a reconciliation question.
 *
 * `close_by` is in UNIX SECONDS and Razorpay requires it to be at least 15
 * minutes out. A QR with no expiry is a payment instrument sitting in a
 * WhatsApp thread forever.
 */
async function createQrCode({
  amount,
  bookingId,
  purpose,
  description,
  customerId,
  closeBy,
}) {
  const qr = await call('/payments/qr_codes', {
    body: {
      type: 'upi_qr',
      name: String(description || `Trip ${bookingId}`).slice(0, 120),
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: toPaise(amount),
      description: String(description || `Trip ${bookingId}`).slice(0, 2048),
      ...(customerId ? { customer_id: customerId } : {}),
      ...(closeBy ? { close_by: Math.floor(new Date(closeBy).getTime() / 1000) } : {}),
      notes: { bookingId, purpose },
    },
  });

  return {
    id: qr.id,
    // The QR IMAGE, not a page. There is nothing to "open" and nothing is sent
    // to the customer — the admin shares this picture.
    shareUrl: qr.image_url,
    status: qr.status,
    amount: qr.payment_amount,
    currency: 'INR',
    expiresAt: qr.close_by ? new Date(qr.close_by * 1000) : null,
    raw: qr,
  };
}

/** Closes a QR so it can no longer be paid. */
async function closeQrCode(qrId) {
  return call(`/payments/qr_codes/${qrId}/close`);
}

/**
 * Normalises a Razorpay webhook into the system's common shape.
 *
 * ---------------------------------------------------------------------------
 * THREE ENTITIES CAN CARRY THE ID WE MATCH ON
 * ---------------------------------------------------------------------------
 * Every event is matched to a row by providerOrderId, and WHICH field holds
 * that id depends on how the money was collected:
 *
 *   checkout order   payload.payment.entity.order_id      order_xxx
 *   payment link     payload.payment_link.entity.id       plink_xxx
 *   UPI QR           payload.qr_code.entity.id            qr_xxx
 *
 * The link and QR events also carry a payment entity with its own order_id —
 * the order Razorpay created internally at payment time, which we have never
 * seen and cannot match. So the order is checked LAST, not first: reading it
 * first would hand back an id with no row behind it and the capture would be
 * dropped as `no_matching_payment` while the customer's money sat in the
 * account.
 *
 * The status is read from the PAYMENT entity throughout, because that is the
 * one the status machine understands ('captured', 'failed'). A link's own
 * status is 'paid', which mapGatewayStatus does not know — and a qr_code.closed
 * event has no payment at all, so it maps to nothing and is acknowledged
 * without touching a row, which is correct.
 */
function parseWebhook(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : payload;

  const payment = p.payload?.payment?.entity || {};
  const link = p.payload?.payment_link?.entity || null;
  const qr = p.payload?.qr_code?.entity || null;
  const event = String(p.event || '');

  /*
   * Only trust the link/QR id on an event that is ABOUT that instrument.
   * Razorpay includes a payment_link entity on some payment.* events too, and
   * taking it there would redirect an ordinary checkout capture onto the wrong
   * row.
   */
  const matchId =
    (event.startsWith('payment_link.') && link?.id) ||
    (event.startsWith('qr_code.') && qr?.id) ||
    payment.order_id ||
    null;

  return {
    eventId: p.__eventId || `${p.event}:${payment.id || link?.id || qr?.id || ''}`,
    eventType: p.event,
    providerOrderId: matchId,
    providerPaymentId: payment.id || null,
    amountPaise: payment.amount != null ? Number(payment.amount) : null,
    amount: payment.amount != null ? toRupees(payment.amount) : null,
    status: payment.status || null,
    method: (payment.method || '').toUpperCase() || null,
    /** Which instrument this arrived through. Informational; nothing branches on it. */
    collectionType: event.startsWith('payment_link.')
      ? 'LINK'
      : event.startsWith('qr_code.')
        ? 'QR'
        : null,
    raw: p,
  };
}

module.exports = {
  name: NAME,
  createOrder,
  verifyWebhookSignature,
  parseWebhook,
  createPaymentLink,
  cancelPaymentLink,
  resendPaymentLink,
  createQrCode,
  closeQrCode,
  toPaise,
  toRupees,
};