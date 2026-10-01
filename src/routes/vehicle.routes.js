'use strict';

/**
 * src/routes/vehicle.routes.js   ->  /api/v1/admin/vehicles
 *
 * Full-fleet vehicle management. Gated by VEHICLE_MANAGE (held by ADMIN and
 * FLEET in the seeded role_permissions). DELETE is a soft delete — see
 * vehicle.service.
 */

const express = require('express');

const ctrl = require('../controllers/vehicle.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/vehicle.schemas');

const router = express.Router();

router.use(requireAuth);
router.use(requirePermission('VEHICLE_MANAGE'));

router.get('/', validate({ query: s.listVehiclesQuerySchema }), ctrl.list);

router.post('/', validate({ body: s.createVehicleSchema }), ctrl.create);

router.get('/:id', validate({ params: s.idParamSchema }), ctrl.getOne);

router.patch(
  '/:id',
  validate({ params: s.idParamSchema, body: s.updateVehicleSchema }),
  ctrl.update
);

// Soft delete (deactivate). Keeps the vehicle's trip history.
router.delete('/:id', validate({ params: s.idParamSchema }), ctrl.remove);

/*
 * PERMANENT delete. Registered AFTER '/:id' is harmless here — the paths
 * differ by a trailing segment, so Express cannot confuse them — but it is
 * kept adjacent so the pair is read together.
 *
 * Refused by the service unless the vehicle has never been dispatched, so
 * this cannot be used to erase a trip record. See vehicle.service.hardDelete.
 */
router.delete('/:id/permanent', validate({ params: s.idParamSchema }), ctrl.destroy);

module.exports = router;