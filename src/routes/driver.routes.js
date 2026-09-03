'use strict';

/**
 * src/routes/driver.routes.js   ->  /api/v1/admin/drivers
 *
 * Driver roster management. Gated by DRIVER_APPROVE (held by ADMIN and FLEET in
 * the seeded role_permissions). The :id param is the driver's userId.
 */

const express = require('express');

const ctrl = require('../controllers/driver.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/driver.schemas');

const router = express.Router();

router.use(requireAuth);
router.use(requirePermission('DRIVER_APPROVE'));

router.get('/', validate({ query: s.listDriversQuerySchema }), ctrl.list);

router.post('/', validate({ body: s.createDriverSchema }), ctrl.create);

router.get('/:id', validate({ params: s.idParamSchema }), ctrl.getOne);

router.patch(
  '/:id',
  validate({ params: s.idParamSchema, body: s.updateDriverSchema }),
  ctrl.update
);

// Account lifecycle. Deactivating also forces the driver offline.
router.patch('/:id/activate', validate({ params: s.idParamSchema }), ctrl.activate);
router.patch('/:id/deactivate', validate({ params: s.idParamSchema }), ctrl.deactivate);

module.exports = router;