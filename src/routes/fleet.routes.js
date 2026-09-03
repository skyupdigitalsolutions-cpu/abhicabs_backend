'use strict';

/**
 * src/routes/fleet.routes.js   ->  /api/v1/admin/fleet
 *
 * Read-only fleet browsing for ops/fleet staff:
 *   GET /admin/fleet/vehicles          list + filter vehicles
 *   GET /admin/fleet/vehicles/:id      one vehicle (+ assigned drivers)
 *   GET /admin/fleet/drivers           list + filter drivers
 *   GET /admin/fleet/drivers/:userId   one driver (+ assigned vehicle)
 *
 * Vehicles are gated by VEHICLE_MANAGE and drivers by DRIVER_APPROVE — the two
 * permissions the FLEET role (and ADMIN) already hold in the seeded
 * role_permissions table, so no new permission is introduced.
 */

const express = require('express');

const ctrl = require('../controllers/fleet.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/fleet.schemas');

const router = express.Router();

router.use(requireAuth);

/* ---------------- vehicles ---------------- */

router.get(
  '/vehicles',
  requirePermission('VEHICLE_MANAGE'),
  validate({ query: s.listVehiclesQuerySchema }),
  ctrl.listVehicles
);

router.get(
  '/vehicles/:id',
  requirePermission('VEHICLE_MANAGE'),
  validate({ params: s.vehicleIdParamSchema }),
  ctrl.getVehicle
);

/* ---------------- drivers ---------------- */

router.get(
  '/drivers',
  requirePermission('DRIVER_APPROVE'),
  validate({ query: s.listDriversQuerySchema }),
  ctrl.listDrivers
);

router.get(
  '/drivers/:userId',
  requirePermission('DRIVER_APPROVE'),
  validate({ params: s.driverIdParamSchema }),
  ctrl.getDriver
);

module.exports = router;