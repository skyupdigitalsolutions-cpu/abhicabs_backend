'use strict';

/**
 * src/routes/adminPayment.routes.js   ->  /api/v1/admin/payments
 *
 * Business-wide payments listing. Gated by PAYMENT_VIEW — the same permission
 * the booking-scoped payments view already uses.
 */

const express = require('express');

const ctrl = require('../controllers/adminPayment.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const s = require('../validators/adminPayment.schemas');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('PAYMENT_VIEW'),
  validate({ query: s.listPaymentsQuerySchema }),
  ctrl.list
);

/* ------------------------------------------------------------------ *
 * Collecting money without the rider app
 *
 * PAYMENT_MANAGE, not PAYMENT_VIEW. Creating a payment link is asking a real
 * customer for real money and sending them an SMS about it — a materially
 * different act from reading the payments list, and one that should not come
 * free with a read-only role.
 *
 * Every creating route is idempotency-keyed. Without it a double-clicked
 * "Create link" sends the customer two SMSes with two payable links, and the
 * second one survives after the first is paid. The in-service reuse check
 * catches most of that; the key catches the concurrent case it cannot.
 * ------------------------------------------------------------------ */

router.post(
  '/bookings/:bookingId/link',
  requirePermission('PAYMENT_MANAGE'),
  idempotent('POST /admin/payments/bookings/:bookingId/link'),
  validate({ params: s.bookingIdParamSchema, body: s.createLinkSchema }),
  ctrl.createLink
);

router.post(
  '/bookings/:bookingId/qr',
  requirePermission('PAYMENT_MANAGE'),
  idempotent('POST /admin/payments/bookings/:bookingId/qr'),
  validate({ params: s.bookingIdParamSchema, body: s.createQrSchema }),
  ctrl.createQr
);

/** Read-only, so the lighter permission is right here. */
router.get(
  '/bookings/:bookingId/collections',
  requirePermission('PAYMENT_VIEW'),
  validate({ params: s.bookingIdParamSchema }),
  ctrl.listCollections
);

router.post(
  '/:id/cancel',
  requirePermission('PAYMENT_MANAGE'),
  validate({ params: s.paymentIdParamSchema }),
  ctrl.cancelCollection
);

router.post(
  '/:id/resend',
  requirePermission('PAYMENT_MANAGE'),
  idempotent('POST /admin/payments/:id/resend'),
  validate({ params: s.paymentIdParamSchema, body: s.resendSchema }),
  ctrl.resendLink
);

module.exports = router;