'use strict';

/**
 * src/controllers/payment.controller.js
 */

const paymentService = require('../services/payment.service');
const webhookService = require('../services/webhook.service');
const paymentProvider = require('../services/providers/payment.provider');
const mockProvider = require('../services/providers/mock.provider');
const env = require('../config/env');
const { asyncHandler, ApiError } = require('../utils/helpers');

const meta = (req) => ({
  ip: req.ip || '',
  userAgent: req.get('user-agent') || '',
  source: req.get('x-client-source') || 'api',
});

exports.createOrder = asyncHandler(async (req, res) => {
  const { bookingId, purpose } = req.body;
  const { payment, reused } = await paymentService.createOrder(
    bookingId,
    purpose,
    req.user,
    meta(req)
  );

  /*
   * The gateway's PUBLIC key, sent so the app can open the checkout sheet.
   *
   * key_id is public by design — Razorpay's own docs put it in client-side
   * code, and it can only be used to open a checkout against an order that
   * already exists on our account. The key SECRET never leaves the server and
   * is not in this response.
   *
   * Sent from here rather than baked into the app build so that rotating a key
   * or moving from test to live is a server env change, not an app-store
   * release. An app already on a rider's phone picks up the new key on its next
   * order.
   *
   * Null for the mock provider, which has no checkout to open — the app treats
   * that as "nothing to pay through a gateway" rather than crashing on a
   * missing key.
   */
  const provider = paymentProvider.getProvider();
  const keyId = provider.name === 'razorpay' ? env.payment.razorpay.keyId : null;

  res.status(reused ? 200 : 201).json({
    success: true,
    message: reused ? 'Returning existing open order' : 'Payment order created',
    data: { payment, reused, provider: provider.name, keyId },
  });
});

exports.getOne = asyncHandler(async (req, res) => {
  const payment = await paymentService.getById(req.params.id, req.user);
  res.json({ success: true, data: { payment } });
});

exports.listForBooking = asyncHandler(async (req, res) => {
  const payments = await paymentService.listForBooking(req.params.bookingId);
  res.json({ success: true, data: { payments, count: payments.length } });
});

/**
 * TEST HELPER — mock provider only, non-production only.
 *
 * Builds a correctly-signed `captured` (or authorized/failed) webhook for the
 * given payment's order and runs it through the REAL ingest pipeline. Because
 * the envelope is deterministic on eventId, calling this repeatedly with the
 * same eventId is a true replay: the first call changes state, the rest dedupe.
 *
 * This is how you demonstrate the Day 7 done-line in Postman without a real
 * gateway: hit it five times with the same eventId, watch `changed` go
 * true, false, false, false, false.
 */
exports.simulateWebhook = asyncHandler(async (req, res) => {
  /*
   * Refused in production UNLESS explicitly enabled for this environment.
   *
   * The second guard below (mock provider only) is what actually keeps this
   * safe once real payments are live: with PAYMENT_PROVIDER=razorpay this
   * endpoint is unreachable no matter what the flag says.
   */
  if (env.isProd && !env.allowPaymentSimulation) {
    throw ApiError.forbidden(
      'Webhook simulation is disabled in production. Set ALLOW_PAYMENT_SIMULATION=true on a test environment to enable it.',
      'SIMULATE_DISABLED',
    );
  }
  if (paymentProvider.getProvider().name !== 'mock') {
    throw ApiError.badRequest(
      'Webhook simulation only works with the mock provider',
      'SIMULATE_REQUIRES_MOCK'
    );
  }

  const payment = await paymentService.getById(req.params.id);
  if (!payment.providerOrderId) {
    throw ApiError.badRequest('Payment has no gateway order to simulate against', 'NO_ORDER');
  }

  const { raw, signature } = mockProvider.simulateWebhook({
    eventId: req.body.eventId,
    eventType: `payment.${req.body.status || 'captured'}`,
    status: req.body.status || 'captured',
    providerOrderId: payment.providerOrderId,
    providerPaymentId: `pay_sim_${req.body.eventId}`,
    amount: req.body.amount != null ? req.body.amount : payment.amount,
  });

  const result = await webhookService.ingest({
    provider: 'mock',
    rawBody: Buffer.from(raw, 'utf8'),
    signature,
    headers: {},
  });

  res.json({
    success: true,
    message: result.changed
      ? 'Event applied'
      : result.duplicate
        ? 'Duplicate event ignored'
        : 'Event ignored (no forward move)',
    data: result,
  });
});