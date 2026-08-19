'use strict';

/**
 * src/routes/payment.routes.js   — Day 7
 *   -> /api/v1/payments
 *
 * Money-in endpoints. These are normal JSON routes (mounted after
 * express.json()). The gateway webhook is NOT here — it needs the raw body and
 * lives in webhook.routes.js, mounted before the JSON parser in app.js.
 */

const express = require('express');

const ctrl = require('../controllers/payment.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const s = require('../validators/payment.schemas');

const router = express.Router();

router.use(requireAuth);

// Create (or return the existing open) gateway order for a booking + purpose.
// Idempotent-keyed as well: a retried "Pay" tap replays the same response,
// and even without a key the partial unique index returns the same order.
router.post(
  '/orders',
  idempotent('POST /payments/orders'),
  validate({ body: s.createOrderSchema }),
  ctrl.createOrder
);

// All payments for a booking (advance, balance, refunds) in creation order.
router.get(
  '/booking/:bookingId',
  requirePermission('PAYMENT_VIEW'),
  validate({ params: s.bookingIdParamSchema }),
  ctrl.listForBooking
);

// Test helper — mock provider, non-prod only. Drives a signed webhook through
// the real ingest pipeline so replay/forward-only can be demonstrated.
router.post(
  '/:id/simulate-webhook',
  validate({ params: s.idParamSchema, body: s.simulateWebhookSchema }),
  ctrl.simulateWebhook
);

// Single payment status. Kept last so it does not shadow the static segments.
router.get('/:id', validate({ params: s.idParamSchema }), ctrl.getOne);

module.exports = router;