'use strict';

/**
 * src/routes/city.routes.js   ->  /api/v1/admin/cities
 *
 * Create and edit the cities the rate-card editor, the quote engine and
 * dispatch all key off. Until this existed there was no write path for a city
 * anywhere in the API — the only city endpoint in the codebase was the
 * read-only lookup at GET /admin/fare-configs/cities, which is why the admin
 * "add city" action 404'd. That lookup stays where it is; the rate-card screen
 * calls it to fill a dropdown and should keep doing so.
 *
 * ---------------------------------------------------------------------------
 * PERMISSIONS: WHY WRITES ARE SETTINGS_MANAGE AND READS ARE NOT
 * ---------------------------------------------------------------------------
 * Opening a city is the same kind of decision as opening a state — where the
 * company operates — so the writes sit behind SETTINGS_MANAGE, matching
 * serviceState.routes rather than the rate-card router's FARE_EDIT.
 *
 * The reads accept EITHER, because the rate-card screen needs the city list
 * and its users hold FARE_EDIT. Today both permissions are granted only to
 * ADMIN, so this distinction costs nothing and is already correct for the day
 * a pricing role is split out from a settings one.
 */

const express = require('express');

const ctrl = require('../controllers/city.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/city.schemas');

const router = express.Router();

router.use(requireAuth);

const WRITE = 'SETTINGS_MANAGE';
/** requirePermission is ANY-of, so this reads as "either permission". */
const READ = ['SETTINGS_MANAGE', 'FARE_EDIT'];

router.get('/', requirePermission(READ),
  validate({ query: s.listQuerySchema }), ctrl.list);

router.post('/', requirePermission(WRITE),
  validate({ body: s.createSchema }), ctrl.create);

router.get('/:id', requirePermission(READ),
  validate({ params: s.idParamSchema }), ctrl.getOne);

router.patch('/:id', requirePermission(WRITE),
  validate({ params: s.idParamSchema, body: s.updateSchema }), ctrl.update);

router.patch('/:id/activate', requirePermission(WRITE),
  validate({ params: s.idParamSchema }), ctrl.activate);

// DELETE deactivates rather than removing — see the service for why.
router.delete('/:id', requirePermission(WRITE),
  validate({ params: s.idParamSchema }), ctrl.deactivate);

module.exports = router;