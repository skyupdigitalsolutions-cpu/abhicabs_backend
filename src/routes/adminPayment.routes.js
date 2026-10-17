'use strict';

/**
 * src/routes/adminPayment.routes.js   ->  /api/v1/admin/payments
 *
 * Business-wide payments listing, and the instruments an admin uses to ask a
 * customer for money outside the rider app.
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
 * customer for real money and sending them a message about it — a materially
 * different act from reading the payments list, and one that should not come
 * free with a read-only role.
 *
 * Every creating route is idempotency-keyed. Without it a double-clicked
 * "Create link" sends the customer two messages with two payable links, and
 * the second one survives after the first is paid. The in-service reuse check
 * catches most of that; the key catches the concurrent case it cannot.
 *
 * ROUTE ORDER: the literal paths are declared before the ':id' ones. Express
 * matches in declaration order, and '/links' would otherwise be swallowed by
 * nothing today but by the first ':id' route somebody adds tomorrow.
 * ------------------------------------------------------------------ */

/* ---- No booking required ---- */

/**
 * POST /admin/payments/links
 *
 * The booking is frequently the LAST thing to exist: a customer calls, agrees
 * a fare, and pays the advance before anyone has entered a trip. This takes
 * the amount and the payer directly, stores the payment with a null bookingId,
 * and captures through exactly the same webhook path as everything else.
 */
router.post(
  '/links',
  requirePermission('PAYMENT_MANAGE'),
  idempotent('POST /admin/payments/links'),
  validate({ body: s.createStandaloneLinkSchema }),
  ctrl.createStandaloneLink
);

/** POST /admin/payments/qr — the same, as a fixed-amount UPI QR. */
router.post(
  '/qr',
  requirePermission('PAYMENT_MANAGE'),
  idempotent('POST /admin/payments/qr'),
  validate({ body: s.createStandaloneQrSchema }),
  ctrl.createStandaloneQr
);

/**
 * GET /admin/payments/collections
 *
 * Every link and QR, with a booking or without. Read-only, so the lighter
 * permission is right. `scope=standalone` is the important filter: those rows
 * are reachable from nowhere else in the panel, because they have no booking
 * screen to live on.
 */
router.get(
  '/collections',
  requirePermission('PAYMENT_VIEW'),
  validate({ query: s.listCollectionsQuerySchema }),
  ctrl.listAllCollections
);

/* ---- Against an existing booking ---- */

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

/* ---- Acting on one instrument ---- */

/**
 * POST /admin/payments/:id/whatsapp
 *
 * Distinct from /resend, which asks RAZORPAY to deliver the link again over
 * SMS or email. This one goes out from us: through our own bot when it is
 * configured, otherwise as a wa.me deep link the admin taps to send from
 * their own WhatsApp.
 *
 * PAYMENT_MANAGE even though it creates nothing, because it puts a message on
 * a customer's phone. Idempotency-keyed for the same reason the creates are:
 * a double click must not send the same person the same link twice.
 */
router.post(
  '/:id/whatsapp',
  requirePermission('PAYMENT_MANAGE'),
  idempotent('POST /admin/payments/:id/whatsapp'),
  validate({ params: s.paymentIdParamSchema, body: s.whatsappShareSchema }),
  ctrl.shareOnWhatsApp
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