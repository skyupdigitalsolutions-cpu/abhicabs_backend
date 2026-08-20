'use strict';

/**
 * src/routes/dispatch.routes.js   — Day 9
 *   -> /api/v1/admin/dispatch   (ops board + allocation)
 *   -> /api/v1/driver/offers    (driver accept/decline)
 *
 * Two routers exported: the ops-facing dispatch board and allocation actions
 * (DISPATCH_MANAGE), and the driver-facing accept/decline (role DRIVER).
 */

const express = require('express');

const ctrl = require('../controllers/dispatch.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission, requireRole } = require('../middlewares/auth');
const s = require('../validators/dispatch.schemas');

/* ---------------- ops: /admin/dispatch ---------------- */

const ops = express.Router();
ops.use(requireAuth);

ops.get('/board', requirePermission('DISPATCH_MANAGE'),
  validate({ query: s.boardQuerySchema }), ctrl.board);

ops.get('/pending', requirePermission('DISPATCH_MANAGE'),
  validate({ query: s.boardQuerySchema }), ctrl.pending);

ops.get('/live', requirePermission('DISPATCH_MANAGE'),
  validate({ query: s.boardQuerySchema }), ctrl.live);

ops.get('/vehicles', requirePermission('DISPATCH_MANAGE'),
  validate({ query: s.availableVehiclesQuerySchema }), ctrl.availableVehicles);

// Rule-assisted auto-assign — picks a matching, free vehicle.
ops.post('/bookings/:bookingId/auto-assign', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.bookingIdParamSchema }), ctrl.autoAssign);

// Manual assign — dispatcher names the vehicle (and optionally driver).
ops.post('/bookings/:bookingId/assign', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.bookingIdParamSchema, body: s.assignSchema }), ctrl.assign);

ops.get('/bookings/:bookingId/allocation', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.bookingIdParamSchema }), ctrl.getForBooking);

// Manual trigger for the offer-timeout sweep (Day 12 will schedule this).
ops.post('/expire-offers', requirePermission('DISPATCH_MANAGE'), ctrl.expireOffers);

/* ---------------- driver: /driver/offers ---------------- */

const driver = express.Router();
driver.use(requireAuth, requireRole('DRIVER'));

driver.post('/:allocationId/accept',
  validate({ params: s.allocationIdParamSchema }), ctrl.accept);

driver.post('/:allocationId/decline',
  validate({ params: s.allocationIdParamSchema }), ctrl.decline);

module.exports = { ops, driver };