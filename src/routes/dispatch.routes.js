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
const { requireAuth, requirePermission } = require('../middlewares/auth');
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

// Manual assign — dispatcher names the vehicle (and optionally driver).
ops.post('/bookings/:bookingId/assign', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.bookingIdParamSchema, body: s.assignSchema }), ctrl.assign);

// Reassign — swap the vehicle (and optionally driver) on an already-allocated
// booking. Logged to the audit trail with before/after + who/when.
ops.patch('/bookings/:bookingId/reassign', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.bookingIdParamSchema, body: s.assignSchema }), ctrl.reassign);

ops.get('/bookings/:bookingId/allocation', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.bookingIdParamSchema }), ctrl.getForBooking);

/**
 * The driver router is GONE, and with it /driver/offers/:id/accept and
 * /decline.
 *
 * Dispatch assigns; the driver is told, not asked. Kept as an empty router
 * rather than deleted from the export so src/routes/index.js keeps mounting
 * something — a missing export there is a boot crash, not a 404, and the trade
 * is one dead mount against the whole API failing to start.
 */
const driver = express.Router();

module.exports = { ops, driver };