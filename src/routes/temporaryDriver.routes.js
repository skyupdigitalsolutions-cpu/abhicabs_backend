'use strict';

/**
 * src/routes/temporaryDriver.routes.js  ->  /api/v1/admin/temporary-drivers
 *
 * Behind DRIVER_APPROVE — the same permission as onboarding a permanent
 * driver. Creating one grants someone the ability to be dispatched to a
 * paying customer, which is the same authority whether the hire lasts a day
 * or a year.
 */

const express = require('express');

const ctrl = require('../controllers/temporaryDriver.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/temporaryDriver.schemas');

const router = express.Router();

router.use(requireAuth);

const PERM = 'DRIVER_APPROVE';

router.get('/', requirePermission(PERM),
  validate({ query: s.listQuerySchema }), ctrl.list);

router.post('/', requirePermission(PERM),
  validate({ body: s.createSchema }), ctrl.create);

// Ends the hire: driver offline, account and vehicle deactivated. Refuses
// while a live allocation exists — see the service.
router.delete('/:id', requirePermission(PERM),
  validate({ params: s.userIdParamSchema }), ctrl.release);

module.exports = router;