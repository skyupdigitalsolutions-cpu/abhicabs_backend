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
const s = require('../validators/adminPayment.schemas');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('PAYMENT_VIEW'),
  validate({ query: s.listPaymentsQuerySchema }),
  ctrl.list
);

module.exports = router;