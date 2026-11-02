const express = require('express');
const rateLimit = require('express-rate-limit');
const { showPage, appJs, suggest, place, reverseHandler, confirm } = require('../controllers/routeMap.controller');

const router = express.Router();

// Suggestions are requested while the customer types, so this is generous, but still limited per IP.
const limiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'too_many_requests' } });

router.get('/app.js', appJs);
router.get('/suggest', limiter, suggest);
router.get('/place', limiter, place);
router.get('/reverse', limiter, reverseHandler);
router.post('/confirm', limiter, confirm);
router.get('/:token', limiter, showPage);

module.exports = router;
