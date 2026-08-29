'use strict';

/**
 * src/routes/fare.routes.js   ->  /api/v1/fares
 *
 * Quoting is authenticated. An open estimate endpoint is a free proxy to your
 * paid maps account: anyone could loop it and run up the bill without ever
 * booking. Requiring a token means abuse is attributable and rate-limited per
 * user rather than per IP.
 */

const express = require('express');

const ctrl = require('../controllers/fare.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/fare.schemas');

const router = express.Router();

router.use(requireAuth);

/* ---------------- quoting ---------------- */

router.post('/estimate', validate({ body: s.estimateSchema }), ctrl.estimate);
router.post('/compare', validate({ body: s.compareSchema }), ctrl.compare);
router.post('/options', validate({ body: s.allClassesSchema }), ctrl.options);
router.post('/cancellation-fee', validate({ body: s.cancellationSchema }), ctrl.cancellationFee);

/* ---------------- maps ---------------- */

router.post('/geocode', validate({ body: s.geocodeSchema }), ctrl.geocode);
router.get('/reverse-geocode', validate({ query: s.reverseGeocodeSchema }), ctrl.reverseGeocode);
router.get('/autocomplete', validate({ query: s.autocompleteSchema }), ctrl.autocomplete);
router.post('/distance', validate({ body: s.distanceSchema }), ctrl.distance);
router.post('/route', validate({ body: s.distanceSchema }), ctrl.route);

/* ---------------- ops ---------------- */

router.get('/maps/health', requirePermission('REPORT_VIEW'), ctrl.mapsHealth);

module.exports = router;