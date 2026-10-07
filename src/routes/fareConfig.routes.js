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

router.get('/cities', requirePermission(PERM),
  validate({ query: s.listCitiesQuerySchema }), ctrl.cities);

// The "All cities in <state>" dropdown, with the cities each state covers.
router.get('/states', requirePermission(PERM),
  validate({ query: s.listCitiesQuerySchema }), ctrl.states);

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

// Copy onto another class, city, state, or forward in time to stage a price
// change. Also how a statewide card becomes a single-city exception.
router.post('/:id/clone', requirePermission(PERM),
  validate({ params: s.idParamSchema, body: s.cloneSchema }), ctrl.clone);

router.patch('/:id/activate', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.activate);

// DELETE retires the card and keeps the row — the safe default, and what the
// existing admin screen's delete button already calls.
router.delete('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.deactivate);

/*
 * Removes the row for good.
 *
 * A SECOND PATH RATHER THAN ?hard=true ON THE FIRST, deliberately. The two
 * actions are not degrees of the same thing: one is reversible and one is not,
 * and a query string is the easiest part of a request to leave behind in a
 * copied cURL command or a stale frontend build. A distinct URL cannot be
 * reached by accident.
 *
 * It refuses anything that would leave a live city unable to quote, naming the
 * cities; ?force=true overrides that and is recorded in the audit row.
 */
router.delete('/:id/permanent', requirePermission(PERM),
  validate({ params: s.idParamSchema, query: s.deleteQuerySchema }), ctrl.destroy);

module.exports = router;