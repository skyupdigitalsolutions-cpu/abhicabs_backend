'use strict';

/**
 * src/routes/booking.routes.js   ->  /api/v1/bookings
 *
 * Customer-facing. Staff booking management lives on /admin/bookings.
 */

const express = require('express');

const ctrl = require('../controllers/booking.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, attachPermissions } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const s = require('../validators/booking.schemas');

const router = express.Router();

router.use(requireAuth);

/**
 * attachPermissions runs before create so the controller can check
 * BOOKING_MANAGE when a caller books on someone else's behalf.
 *
 * idempotent() sits BEFORE validate() on purpose: a retry of a request that
 * previously succeeded should replay the stored response without re-running
 * validation, which might now reject it (a scheduled pickup that has since
 * passed its lead-time window, for instance).
 */
router.post(
  '/',
  attachPermissions,
  idempotent('POST /bookings'),
  validate({ body: s.createBookingSchema }),
  ctrl.create
);

router.get('/', validate({ query: s.listBookingsQuerySchema }), ctrl.list);

// Placed before /:id so "number" is not swallowed as a uuid parameter.
router.get(
  '/number/:bookingNumber',
  validate({ params: s.numberParamSchema }),
  ctrl.getByNumber
);

router.get('/:id', validate({ params: s.idParamSchema }), ctrl.getOne);

module.exports = router;