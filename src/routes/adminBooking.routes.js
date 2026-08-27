'use strict';

/**
 * src/routes/adminBooking.routes.js   — UPDATED for Day 6
 *   -> /api/v1/admin/bookings
 *
 * Operations view plus every forward transition. Guarded per route by
 * capability, so dispatch staff can move trips along without holding the
 * permissions that let them edit customers or issue refunds.
 */

const express = require('express');

const ctrl = require('../controllers/booking.controller');
const life = require('../controllers/lifecycle.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission, attachPermissions } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const s = require('../validators/booking.schemas');
const ls = require('../validators/lifecycle.schemas');

const router = express.Router();

router.use(requireAuth);

/* ---------------- read ---------------- */

router.get('/stats', requirePermission('REPORT_VIEW'),
  validate({ query: s.statsQuerySchema }), ctrl.stats);

/**
 * Every booking initiation, including abandoned and failed ones. The rows exist
 * because the attempt is logged before validation can reject it.
 */
router.get('/attempts', requirePermission('BOOKING_MANAGE'),
  validate({ query: s.listAttemptsQuerySchema }), ctrl.listAttempts);

router.get('/', requirePermission('BOOKING_MANAGE'),
  validate({ query: s.listBookingsQuerySchema }), ctrl.list);

router.post('/', requirePermission('BOOKING_CREATE'), attachPermissions,
  idempotent('POST /admin/bookings'), validate({ body: s.createBookingSchema }), ctrl.create);

// Static segments must precede /:id or they are captured as a uuid parameter.
// Without this the request falls through to GET /:id, which validates
// "cancellation-policy" as a booking id and 400s with "Invalid id".
router.get('/cancellation-policy', requirePermission('BOOKING_MANAGE'),
  validate({ query: ls.policyQuerySchema }), life.policy);

router.get('/:id', requirePermission('BOOKING_MANAGE'),
  validate({ params: s.idParamSchema }), ctrl.getOne);

router.get('/:id/actions', requirePermission('BOOKING_MANAGE'),
  validate({ params: ls.idParamSchema }), life.actions);

/* ------------------------------------------------------------------ *
 * Forward transitions
 *
 * Each is a separate endpoint rather than one "set status" route. That way the
 * permitted source statuses are fixed by the transition table and a client
 * cannot name an arbitrary destination.
 * ------------------------------------------------------------------ */

/** PENDING -> CONFIRMED. Day 7 makes this the payment-success callback. */
router.patch('/:id/confirm', requirePermission('BOOKING_MANAGE'),
  validate({ params: ls.idParamSchema, body: ls.transitionSchema }), life.confirm);

/** CONFIRMED -> ALLOCATED. Day 9 writes the allocation row alongside this. */
router.patch('/:id/allocate', requirePermission('DISPATCH_MANAGE'),
  validate({ params: ls.idParamSchema, body: ls.transitionSchema }), life.allocate);

router.patch('/:id/en-route', requirePermission('DISPATCH_MANAGE'),
  validate({ params: ls.idParamSchema, body: ls.transitionSchema }), life.enRoute);

router.patch('/:id/start', requirePermission('DISPATCH_MANAGE'),
  validate({ params: ls.idParamSchema, body: ls.transitionSchema }), life.start);

/** ONGOING -> ARRIVED. Driver reached the destination; rider is asked to pay. */
router.patch('/:id/arrive', requirePermission('DISPATCH_MANAGE'),
  validate({ params: ls.idParamSchema, body: ls.transitionSchema }), life.arrive);

/** ARRIVED -> COMPLETED. Refused with PAYMENT_REQUIRED if a balance is unpaid. */
router.patch('/:id/complete', requirePermission('DISPATCH_MANAGE'),
  validate({ params: ls.idParamSchema, body: ls.completeSchema }), life.complete);

/**
 * PENDING -> EXPIRED. For the Day 12 sweeper: an unpaid booking whose pickup
 * has passed. Deliberately NOT a cancellation — nobody chose it, so no fee
 * applies and it stays out of cancellation reporting.
 */
router.patch('/:id/expire', requirePermission('BOOKING_MANAGE'),
  validate({ params: ls.idParamSchema, body: ls.transitionSchema }), life.expire);

/* ---------------- cancellation ---------------- */

router.get('/:id/cancellation-quote', requirePermission('BOOKING_CANCEL'),
  validate({ params: ls.idParamSchema }), life.quoteCancellation);

router.post('/:id/cancel', requirePermission('BOOKING_CANCEL'),
  idempotent('POST /admin/bookings/:id/cancel'),
  validate({ params: ls.idParamSchema, body: ls.cancelSchema }), life.cancel);

module.exports = router;