'use strict';

/**
 * src/routes/booking.routes.js   — UPDATED for Day 6
 *   -> /api/v1/bookings
 *
 * Customer-facing. A customer can create, read, and cancel their own booking.
 * Forward transitions (confirm, allocate, start, complete) are operations work
 * and live on /admin/bookings — a customer cannot mark their own trip complete.
 */

const express = require('express');

const ctrl = require('../controllers/booking.controller');
const life = require('../controllers/lifecycle.controller');
const invoiceCtrl = require('../controllers/invoice.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, attachPermissions } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { writeLimiter } = require('../middlewares/rateLimit');
const s = require('../validators/booking.schemas');
const ls = require('../validators/lifecycle.schemas');

const router = express.Router();

router.use(requireAuth);

/* ---------------- create ---------------- */

router.post(
  '/',
  writeLimiter,
  attachPermissions,
  idempotent('POST /bookings'),
  validate({ body: s.createBookingSchema }),
  ctrl.create
);

/* ---------------- read ---------------- */

router.get('/', validate({ query: s.listBookingsQuerySchema }), ctrl.list);

// Static segments must precede /:id or they are captured as a uuid parameter.
router.get(
  '/cancellation-policy',
  validate({ query: ls.policyQuerySchema }),
  life.policy
);

router.get(
  '/number/:bookingNumber',
  validate({ params: s.numberParamSchema }),
  ctrl.getByNumber
);

router.get('/:id', validate({ params: s.idParamSchema }), ctrl.getOne);

// Day 14: per-screen aggregate for the trip-detail view.
router.get('/:id/summary', validate({ params: s.idParamSchema }), ctrl.summary);

/** What can happen next — lets the app render only buttons that would work. */
router.get('/:id/actions', validate({ params: ls.idParamSchema }), life.actions);

/**
 * Driver reports the actual distance travelled for a trip they are assigned to.
 * Authorization is the allocation itself (checked in the service): only the
 * ACTIVE assigned driver may record distance. Extra km over the quote are
 * charged at the booking's frozen per-km rate and shown on the invoice.
 */
router.patch(
  '/:id/trip-distance',
  writeLimiter,
  validate({ params: ls.idParamSchema, body: ls.recordDistanceSchema }),
  life.recordDistance
);

/** The customer's tax/non-tax invoice for a completed booking. */
router.get('/:id/invoice', validate({ params: ls.idParamSchema }), invoiceCtrl.myInvoice);

/* ---------------- cancellation ---------------- */

/**
 * Quote first, then cancel. Two endpoints on purpose: the customer sees the fee
 * and refund BEFORE confirming, rather than discovering the charge after the
 * booking is already gone.
 */
router.get(
  '/:id/cancellation-quote',
  validate({ params: ls.idParamSchema }),
  life.quoteCancellation
);

router.post(
  '/:id/cancel',
  idempotent('POST /bookings/:id/cancel'),
  validate({ params: ls.idParamSchema, body: ls.cancelSchema }),
  life.cancel
);

module.exports = router;