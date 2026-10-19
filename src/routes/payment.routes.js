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

const env = require('../config/env');
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

/*
 * TEST HELPER — drives a signed webhook through the real ingest pipeline so
 * replay and forward-only behaviour can be demonstrated without a gateway.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS REGISTERED CONDITIONALLY, AND WHY IT NEEDS PAYMENT_MANAGE
 * ---------------------------------------------------------------------------
 * This endpoint marks a payment CAPTURED for free. It sits on the RIDER-facing
 * payments router, which only applies requireAuth — so as written, every route
 * above it was permission-gated and this one, the single most dangerous route
 * in the file, was reachable by any logged-in customer. A rider could take an
 * admin's payment link and settle it without paying.
 *
 * Two changes, each sufficient on its own:
 *
 *   1. Not registered at all unless simulation is actually possible. In
 *      production without ALLOW_PAYMENT_SIMULATION the path 404s, so there is
 *      nothing to probe and no guard left to misconfigure.
 *
 *   2. PAYMENT_MANAGE when it IS registered. Marking money received is an
 *      admin act on a staging box exactly as it is in production, and a
 *      customer has no business doing it even against their own booking.
 *
 * The controller re-checks both conditions, because a route file is the wrong
 * place to hold a security property on its own.
 */
if (!env.isProd || env.allowPaymentSimulation) {
  router.post(
    '/:id/simulate-webhook',
    requirePermission('PAYMENT_MANAGE'),
    validate({ params: s.idParamSchema, body: s.simulateWebhookSchema }),
    ctrl.simulateWebhook
  );
}

// Single payment status. Kept last so it does not shadow the static segments.
router.get('/:id', validate({ params: s.idParamSchema }), ctrl.getOne);

module.exports = router;