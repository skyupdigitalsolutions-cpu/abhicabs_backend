'use strict';

/**
 * src/routes/corporate.routes.js   ->  /api/v1/admin/corporate
 *
 * Staff only. Guarded per route by capability, not by role — FINANCE holds
 * CORPORATE_MANAGE, so finance staff can run corporate billing without being
 * given full admin.
 */

const express = require('express');

const ctrl = require('../controllers/corporate.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/customer.schemas');

const router = express.Router();

router.use(requireAuth);

router.get('/stats', requirePermission('CORPORATE_MANAGE'), ctrl.stats);

router.get(
  '/',
  requirePermission('CORPORATE_MANAGE'),
  validate({ query: s.listCorporateQuerySchema }),
  ctrl.list
);

router.post(
  '/',
  requirePermission('CORPORATE_MANAGE'),
  validate({ body: s.createCorporateSchema }),
  ctrl.create
);

router.get(
  '/:id',
  requirePermission('CORPORATE_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.getOne
);

router.patch(
  '/:id',
  requirePermission('CORPORATE_MANAGE'),
  validate({ params: s.idParamSchema, body: s.updateCorporateSchema }),
  ctrl.update
);

router.patch(
  '/:id/activate',
  requirePermission('CORPORATE_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.activate
);

router.patch(
  '/:id/deactivate',
  requirePermission('CORPORATE_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.deactivate
);

/* ---------------- employees ---------------- */

router.get(
  '/:id/employees',
  requirePermission('CORPORATE_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.listEmployees
);

router.post(
  '/:id/employees',
  requirePermission('CORPORATE_MANAGE'),
  validate({ params: s.idParamSchema, body: s.employeeSchema }),
  ctrl.attachEmployee
);

router.delete(
  '/:id/employees/:customerId',
  requirePermission('CORPORATE_MANAGE'),
  ctrl.detachEmployee
);

/* ---------------- audit ---------------- */

router.get(
  '/:id/audit',
  requirePermission('AUDIT_VIEW'),
  validate({ params: s.idParamSchema }),
  ctrl.trail
);

module.exports = router;