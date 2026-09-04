'use strict';

/**
 * src/routes/location.routes.js   — Day 11
 *   -> /api/v1/driver/location    (driver: ping, online/offline)
 *   -> /api/v1/dispatch/location  (ops: nearby search, live location, trail, sweep)
 *
 * Two routers: the driver hot path and the ops read/dispatch surface.
 */

const express = require('express');

const ctrl = require('../controllers/location.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission, requireRole } = require('../middlewares/auth');
const { pingLimiter } = require('../middlewares/rateLimit');
const s = require('../validators/location.schemas');

/* ---------------- driver: /driver/location ---------------- */

const driver = express.Router();
driver.use(requireAuth, requireRole('DRIVER'));

// THE HOT PATH. A driver posts their position every few seconds. Redis only.
driver.post('/ping', pingLimiter, validate({ body: s.pingSchema }), ctrl.ping);

driver.post('/online', ctrl.goOnline);
driver.post('/offline', ctrl.goOffline);

/* ---------------- ops: /dispatch/location ---------------- */

const ops = express.Router();
ops.use(requireAuth);

ops.get('/nearby', requirePermission('DISPATCH_MANAGE'),
  validate({ query: s.nearbyQuerySchema }), ctrl.nearby);

ops.get('/driver/:driverId', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.driverIdParamSchema }), ctrl.driverLocation);

ops.get('/trip/:bookingId/trail', requirePermission('DISPATCH_MANAGE'),
  validate({ params: s.bookingIdParamSchema }), ctrl.tripTrail);

// Manual trigger for the stale-driver sweep (Day 12 schedules it).
ops.post('/sweep-stale', requirePermission('DISPATCH_MANAGE'), ctrl.sweepStale);

/* ---------------- rider: /location (any signed-in user) ---------------- */

const rider = express.Router();
rider.use(requireAuth);

// Anonymized "cars near me" for the home map. Auth'd but no special permission.
rider.get('/nearby-cars', validate({ query: s.nearbyQuerySchema }), ctrl.nearbyForRider);

module.exports = { driver, ops, rider };