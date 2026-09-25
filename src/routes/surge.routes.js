'use strict';

/**
 * src/routes/surge.routes.js  ->  /api/v1/admin/surge
 *
 * Area tiers and the surge percentages they drive.
 *
 * Behind FARE_EDIT, the same permission as rate cards. Surge multiplies the
 * fare, so whoever can change one should be able to change the other — and
 * nobody else. A separate permission would mean an ops user who cannot edit a
 * per-km rate could still add 15% to every trip.
 */

const express = require('express');

const ctrl = require('../controllers/surge.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/surge.schemas');

const router = express.Router();

router.use(requireAuth);

const PERM = 'FARE_EDIT';

/* ---- rules: three rows, one per tier, update only ---- */

router.get('/rules', requirePermission(PERM), ctrl.listRules);

router.patch('/rules/:tier', requirePermission(PERM),
  validate({ params: s.tierParamSchema, body: s.updateRuleSchema }), ctrl.updateRule);

/* ---- areas ---- */

// Before '/areas/:id' so "classify" is never read as an id.
router.get('/areas/classify', requirePermission(PERM),
  validate({ query: s.classifyQuerySchema }), ctrl.classify);

router.get('/areas', requirePermission(PERM), ctrl.listAreas);

router.post('/areas', requirePermission(PERM),
  validate({ body: s.createAreaSchema }), ctrl.createArea);

router.patch('/areas/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema, body: s.updateAreaSchema }), ctrl.updateArea);

// Retires rather than removes — see the controller.
router.delete('/areas/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.deactivateArea);

module.exports = router;