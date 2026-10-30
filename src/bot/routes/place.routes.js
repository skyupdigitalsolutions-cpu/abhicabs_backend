const express = require('express');
const rateLimit = require('express-rate-limit');
const { showPage, appJs, suggest, select } = require('../controllers/placePicker.controller');

const router = express.Router();

// Suggestions are requested as the customer types, so the limit is generous but still per IP.
const limiter = rateLimit({ windowMs: 60 * 1000, max: 180, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'too_many_requests' } });

router.get('/app.js', appJs);
router.get('/suggest', limiter, suggest);
router.post('/select', limiter, select);
router.get('/:token', limiter, showPage);

module.exports = router;
