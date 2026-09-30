'use strict';

/**
 * src/routes/assistant.routes.js  ->  /api/v1/assistant
 */

const express = require('express');
const ctrl = require('../controllers/assistant.controller');
const { requireAuth } = require('../middlewares/auth');
const { writeLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

/*
 * Signed in only, and rate limited.
 *
 * Every call costs money at OpenAI, so an open endpoint is a bill anyone can
 * run up. requireAuth ties usage to an account; the limiter caps how fast one
 * account can spend.
 */
router.post('/ask', requireAuth, writeLimiter, ctrl.ask);

module.exports = router;