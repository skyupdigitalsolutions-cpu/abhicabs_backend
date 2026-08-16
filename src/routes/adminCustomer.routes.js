'use strict';

/**
 * src/routes/adminCustomer.routes.js   ->  /api/v1/admin/customers
 *
 * Staff-facing customer management. This is the ONLY place accountType can be
 * changed, and every change here is written inside a transaction with its audit
 * entry.
 */

const express = require('express');

const ctrl = require('../controllers/customer.controller');
const addressCtrl = require('../controllers/address.controller');
const auditCtrl = require('../controllers/audit.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/customer.schemas');

const router = express.Router();

router.use(requireAuth);

router.get('/stats', requirePermission('CUSTOMER_MANAGE'), ctrl.stats);

router.get(
  '/',
  requirePermission('CUSTOMER_MANAGE'),
  validate({ query: s.listCustomersQuerySchema }),
  ctrl.listCustomers
);

router.get(
  '/:id',
  requirePermission('CUSTOMER_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.getCustomer
);

/**
 * The audited path. accountType, corporate linkage, loyalty and notes.
 * There is deliberately no self-service equivalent.
 */
router.patch(
  '/:id',
  requirePermission('CUSTOMER_MANAGE'),
  validate({ params: s.idParamSchema, body: s.updateCustomerAdminSchema }),
  ctrl.updateCustomer
);

/**
 * Day 3 acceptance endpoint — shows which entity a customer's bookings bill to.
 * Day 5's booking engine calls the same service function.
 */
router.get(
  '/:id/billing',
  requirePermission('CUSTOMER_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.getCustomerBilling
);

/* ---------------- a customer's addresses, staff view ---------------- */

router.get(
  '/:customerId/addresses',
  requirePermission('CUSTOMER_MANAGE'),
  validate({ params: s.customerIdParamSchema }),
  addressCtrl.list
);

router.post(
  '/:customerId/addresses',
  requirePermission('CUSTOMER_MANAGE'),
  validate({ params: s.customerIdParamSchema, body: s.createAddressSchema }),
  addressCtrl.create
);

/* ---------------- audit trail for one customer ---------------- */

router.get('/:entityId/audit', requirePermission('AUDIT_VIEW'), (req, res, next) => {
  req.params.entityType = 'customer';
  return auditCtrl.trail(req, res, next);
});

module.exports = router;