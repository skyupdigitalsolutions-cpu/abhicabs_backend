'use strict';

/**
 * src/routes/auth.routes.js   ->  mounted at /api/v1/auth
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const ctrl = require('../controllers/auth.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const s = require('../validators/schemas');

const router = express.Router();

// Brute-force protection on the credential endpoints. In production back this
// with a Redis store so the limit is shared across all instances rather than
// being per-process.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
});

router.post('/register', authLimiter, validate({ body: s.registerSchema }), ctrl.register);
router.post('/login',    authLimiter, validate({ body: s.loginSchema }),    ctrl.login);
router.post('/refresh',  validate({ body: s.refreshSchema }),               ctrl.refresh);
router.post('/logout',   ctrl.logout);

router.get('/me',          requireAuth, ctrl.me);
router.post('/logout-all', requireAuth, ctrl.logoutAll);
router.post('/change-password', requireAuth, validate({ body: s.changePasswordSchema }), ctrl.changePassword);

module.exports = router;