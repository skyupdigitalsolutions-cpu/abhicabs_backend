'use strict';

/**
 * src/routes/invoice.routes.js   — Day 8
 *   -> /api/v1/admin/invoices
 *
 * Read-only. Invoices are generated automatically when a booking completes
 * (see billing.service via lifecycle.completeTrip); there is no manual create.
 */

const express = require('express');

const ctrl = require('../controllers/invoice.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/payment.schemas');

const router = express.Router();

router.use(requireAuth);

// Static segments before /:id so they are not captured as a uuid.
router.get(
  '/booking/:bookingId/ledger',
  requirePermission('PAYMENT_VIEW'),
  validate({ params: s.bookingIdParamSchema }),
  ctrl.ledgerForBooking
);

router.get(
  '/booking/:bookingId',
  requirePermission('PAYMENT_VIEW'),
  validate({ params: s.bookingIdParamSchema }),
  ctrl.getForBooking
);

router.get(
  '/:id',
  requirePermission('PAYMENT_VIEW'),
  validate({ params: s.idParamSchema }),
  ctrl.getOne
);

module.exports = router;