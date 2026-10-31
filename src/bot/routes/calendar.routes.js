const express = require('express');
const { showCalendar, appJs, selectDate } = require('../controllers/calendar.controller');
const { webhookLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.get('/app.js', appJs);
router.post('/select', webhookLimiter, selectDate);
router.get('/:token', webhookLimiter, showCalendar);

module.exports = router;
