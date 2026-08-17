'use strict';

/**
 * src/routes/index.js   — UPDATED for Day 3
 *
 * Single mount point for the versioned API.
 */

const express = require('express');
const { apiLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API v1',
    endpoints: {
      auth: '/api/v1/auth',
      users: '/api/v1/users',
      customers: '/api/v1/customers',
      fares: '/api/v1/fares',
      admin: '/api/v1/admin',
    },
  });
});

// /auth has its own tighter limiters (login, OTP), so the general ceiling is
// applied only to the authenticated surfaces.
router.use('/auth', require('./auth.routes'));
router.use('/users', apiLimiter, require('./user.routes'));
router.use('/customers', apiLimiter, require('./customer.routes'));
router.use('/fares', apiLimiter, require('./fare.routes'));

router.use('/admin', apiLimiter, require('./admin.routes'));
router.use('/admin/customers', apiLimiter, require('./adminCustomer.routes'));
router.use('/admin/corporate', apiLimiter, require('./corporate.routes'));
router.use('/admin/audit', apiLimiter, require('./audit.routes'));

module.exports = router;