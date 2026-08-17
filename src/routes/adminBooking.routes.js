'use strict';

/**
 * src/routes/adminBooking.routes.js   ->  /api/v1/admin/bookings
 *
 * Staff view. Guarded per route by capability, so OPS and SUPPORT can work
 * bookings without being granted full admin.
 */

const express = require('express');

const ctrl = require('../controllers/booking.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission, attachPermissions } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const s = require('../validators/booking.schemas');

const router = express.Router();

router.use(requireAuth);

router.get('/stats', requirePermission('REPORT_VIEW'),
  validate({ query: s.statsQuerySchema }), ctrl.stats);

/**
 * Every booking initiation, including abandoned and failed ones.
 *
 * This is the client's "notify the admin on every booking attempt" requirement.
 * The rows exist because the attempt is logged before validation can reject it.
 */
router.get('/attempts', requirePermission('BOOKING_MANAGE'),
  validate({ query: s.listAttemptsQuerySchema }), ctrl.listAttempts);

router.get('/', requirePermission('BOOKING_MANAGE'),
  validate({ query: s.listBookingsQuerySchema }), ctrl.list);

// Ops creating a booking over the phone, on the customer's behalf.
router.post('/', requirePermission('BOOKING_CREATE'), attachPermissions,
  idempotent('POST /admin/bookings'), validate({ body: s.createBookingSchema }), ctrl.create);

router.get('/:id', requirePermission('BOOKING_MANAGE'),
  validate({ params: s.idParamSchema }), ctrl.getOne);

module.exports = router;