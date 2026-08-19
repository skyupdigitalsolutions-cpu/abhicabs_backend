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
  res.status(reused ? 200 : 201).json({
    success: true,
    message: reused ? 'Returning existing open order' : 'Payment order created',
    data: { payment, reused },
  });
});

exports.getOne = asyncHandler(async (req, res) => {
  const payment = await paymentService.getById(req.params.id);
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
  if (env.isProd) {
    throw ApiError.forbidden('Webhook simulation is disabled in production', 'SIMULATE_DISABLED');
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