'use strict';

/**
 * src/routes/driverBooking.routes.js   ->  /api/v1/driver/bookings
 *
 * Driver-authenticated actions on their own trips. Authorisation to a specific
 * booking is enforced in the service (the caller must be the assigned driver),
 * not by a dispatch permission — this is the driver acting on their own ride.
 */

const express = require('express');

const ctrl = require('../controllers/driverBooking.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requireRole } = require('../middlewares/auth');
const s = require('../validators/payment.schemas');

const router = express.Router();

router.use(requireAuth, requireRole('DRIVER'));

// POST /api/v1/driver/bookings/:bookingId/collect-cash
router.post(
  '/:bookingId/collect-cash',
  validate({ params: s.bookingIdParamSchema }),
  ctrl.collectCash
);

module.exports = router;