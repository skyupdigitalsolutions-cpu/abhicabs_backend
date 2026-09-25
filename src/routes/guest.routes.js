'use strict';

/**
 * src/routes/guest.routes.js  ->  /api/v1/guest
 *
 * PUBLIC. No auth — that is the point.
 *
 * authLimiter applies to both routes. Session creation writes a users row on
 * every call, so an unthrottled endpoint is a way to fill the table; and the
 * lookup compares a booking number against a phone, so an unthrottled one is a
 * way to guess pairs.
 *
 * WEB ONLY, as specified. Nothing here enforces that — a mobile client could
 * call it — so if that matters it needs an origin check or a separate key.
 * Worth saying rather than implying a restriction that is not there.
 */

const express = require('express');

const ctrl = require('../controllers/guest.controller');
const { validate } = require('../middlewares/validate');
const { authLimiter } = require('../middlewares/rateLimit');
const s = require('../validators/guest.schemas');

const router = express.Router();

router.post('/session', authLimiter, validate({ body: s.startSessionSchema }), ctrl.startSession);
router.post('/bookings/find', authLimiter, validate({ body: s.findBookingSchema }), ctrl.findBooking);

module.exports = router;