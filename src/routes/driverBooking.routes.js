'use strict';

/**
 * src/routes/driverBooking.routes.js   ->  /api/v1/driver/bookings
 *
 * Driver-authenticated reads + actions on the driver's OWN trips. Authorisation
 * to a specific booking is enforced in the controller (caller must be the
 * allocated driver), not by a dispatch permission.
 *
 * Route order matters: the literal '/active' is declared BEFORE '/:bookingId'
 * so it is not swallowed by the param route.
 */

const express = require('express');

const ctrl = require('../controllers/driverBooking.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requireRole } = require('../middlewares/auth');
const { uploadSingle } = require('../middlewares/upload');
const s = require('../validators/payment.schemas');

const router = express.Router();

router.use(requireAuth, requireRole('DRIVER'));

/* ---------------- reads ---------------- */

// GET /api/v1/driver/bookings?page=&limit=  — paginated trip history
router.get('/', ctrl.list);

// GET /api/v1/driver/bookings/active  — the single live trip, or null
router.get('/active', ctrl.active);

// GET /api/v1/driver/bookings/:bookingId  — one trip the driver is on
router.get('/:bookingId', validate({ params: s.bookingIdParamSchema }), ctrl.getById);

/* ---------------- lifecycle ---------------- */

// ALLOCATED -> EN_ROUTE
router.post(
  '/:bookingId/en-route',
  validate({ params: s.bookingIdParamSchema }),
  ctrl.enRoute
);

// EN_ROUTE -> REACHED (issues the customer OTP)
router.post(
  '/:bookingId/reached',
  validate({ params: s.bookingIdParamSchema }),
  ctrl.recordReached
);

// REACHED -> ONGOING. multipart/form-data:
//   fields { otp | startOtp, odometerKm, lat?, lng? }   file { photo }  — both required
// uploadSingle runs BEFORE validate: multer is what fills req.body from a
// multipart request, so validating first would see an empty body.
router.post(
  '/:bookingId/start',
  uploadSingle('photo'),
  validate({ params: s.bookingIdParamSchema, body: s.startTripSchema }),
  ctrl.startTrip
);

// ARRIVED -> COMPLETED. multipart/form-data:
//   fields { odometerKm?, actualKm?, finalFare?, lat?, lng? }   file { photo? }
// The END odometer (photo + reading) is REQUIRED to complete — sent here, or
// earlier via /odometer. Photo and reading go together or not at all.
router.post(
  '/:bookingId/complete',
  uploadSingle('photo'),
  validate({ params: s.bookingIdParamSchema, body: s.completeTripSchema }),
  ctrl.complete
);

// ARRIVED | COMPLETED — collect outstanding cash balance
router.post(
  '/:bookingId/collect-cash',
  validate({ params: s.bookingIdParamSchema }),
  ctrl.collectCash
);

// ONGOING | ARRIVED — END odometer: multipart { odometerKm } + file { photo }, both
// required. Re-submitting before completion replaces it; locked once COMPLETED.
router.post(
  '/:bookingId/odometer',
  uploadSingle('photo'),
  validate({ params: s.bookingIdParamSchema, body: s.odometerSubmitSchema }),
  ctrl.recordOdometer
);

module.exports = router;