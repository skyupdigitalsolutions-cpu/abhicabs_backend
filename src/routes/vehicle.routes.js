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

// Soft delete (deactivate). Physical deletion is intentionally not offered.
router.delete('/:id', validate({ params: s.idParamSchema }), ctrl.remove);

module.exports = router;