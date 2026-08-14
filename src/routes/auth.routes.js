'use strict';

/**
 * src/routes/auth.routes.js   — UPDATED for Day 2
 *   -> mounted at /api/v1/auth
 *
 * Adds the two OTP endpoints and moves every limiter to the Redis-backed store.
 */

const express = require('express');

const ctrl = require('../controllers/auth.controller');
const otpCtrl = require('../controllers/otp.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, attachPermissions } = require('../middlewares/auth');
const {
  authLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  refreshLimiter,
} = require('../middlewares/rateLimit');

const s = require('../validators/schemas');
const otpSchemas = require('../validators/otp.schemas');

const router = express.Router();

/* ---------------- password flow (staff) ---------------- */

router.post('/register', authLimiter, validate({ body: s.registerSchema }), ctrl.register);
router.post('/login',    authLimiter, validate({ body: s.loginSchema }),    ctrl.login);

/* ---------------- OTP flow (customers, drivers) ---------------- */

router.post(
  '/otp/request',
  otpRequestLimiter,
  validate({ body: otpSchemas.otpRequestSchema }),
  otpCtrl.requestOtp
);

router.post(
  '/otp/verify',
  otpVerifyLimiter,
  validate({ body: otpSchemas.otpVerifySchema }),
  otpCtrl.verifyOtp
);

/* ---------------- session management ---------------- */

router.post('/refresh', refreshLimiter, validate({ body: s.refreshSchema }), ctrl.refresh);
router.post('/logout', ctrl.logout);

// attachPermissions puts the caller's permission list on the response so the
// admin UI knows which controls to render. Convenience only — every action is
// still enforced server-side.
router.get('/me', requireAuth, attachPermissions, ctrl.me);

router.post('/logout-all', requireAuth, ctrl.logoutAll);
router.post(
  '/change-password',
  requireAuth,
  validate({ body: s.changePasswordSchema }),
  ctrl.changePassword
);

module.exports = router;