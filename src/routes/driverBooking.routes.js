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
const { uploadSingle } = require('../middlewares/upload');
const s = require('../validators/payment.schemas');

const router = express.Router();

router.use(requireAuth, requireRole('DRIVER'));

// POST /api/v1/driver/bookings/:bookingId/collect-cash
router.post(
  '/:bookingId/collect-cash',
  validate({ params: s.bookingIdParamSchema }),
  ctrl.collectCash
);

// POST /api/v1/driver/bookings/:bookingId/odometer  — final reading after trip.
// Accepts multipart with an optional `photo` file (uploaded to storage), plus
// odometerKm. multer runs before validate so text fields land in req.body.
router.post(
  '/:bookingId/odometer',
  uploadSingle('photo'),
  validate({ params: s.bookingIdParamSchema, body: s.odometerSubmitSchema }),
  ctrl.recordOdometer
);

module.exports = router;