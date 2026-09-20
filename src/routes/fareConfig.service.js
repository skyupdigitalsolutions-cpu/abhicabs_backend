'use strict';

/**
 * src/routes/fareConfig.routes.js   ->  /api/v1/admin/fare-configs
 *
 * The rate-card editor. This is the router the admin ERP's "Rate Cards" screen
 * calls; without it that screen 404s and reports the failure as a missing
 * permission, which sends you looking in the wrong place.
 *
 * Everything sits behind FARE_EDIT, including the reads. A rate card is
 * commercially sensitive — it is the company's margin written down — so the
 * bar for looking at it is the same as the bar for changing it. FARE_EDIT is
 * granted to ADMIN in the Day 1 seed.
 */

const express = require('express');

const ctrl = require('../controllers/fareConfig.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/fareConfig.schemas');

const router = express.Router();

router.use(requireAuth);

const PERM = 'FARE_EDIT';

/* ---------------- lookups ----------------
 * Registered BEFORE /:id. Express matches in order, so a /:id route declared
 * first would swallow /cities and hand the string "cities" to a numeric
 * validator — a 400 that reads like a client bug.
 */

router.get('/cities', requirePermission(PERM), ctrl.cities);
router.get('/vehicle-classes', requirePermission(PERM), ctrl.vehicleClasses);
router.get('/coverage/:cityId', requirePermission(PERM),
  validate({ params: s.cityIdParamSchema }), ctrl.coverage);

/* ---------------- cards ---------------- */

router.get('/', requirePermission(PERM),
  validate({ query: s.listQuerySchema }), ctrl.list);

router.post('/', requirePermission(PERM),
  validate({ body: s.createSchema }), ctrl.create);

router.get('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.getOne);

router.patch('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema, body: s.updateSchema }), ctrl.update);

// Copy onto another class/city, or forward in time to stage a price change.
router.post('/:id/clone', requirePermission(PERM),
  validate({ params: s.idParamSchema, body: s.cloneSchema }), ctrl.clone);

router.patch('/:id/activate', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.activate);

// DELETE retires the card rather than removing it — see the service for why.
router.delete('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.deactivate);

module.exports = router;