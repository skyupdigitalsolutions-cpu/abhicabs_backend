'use strict';

/**
 * src/routes/index.js
 *
 * Single mount point for the versioned API.
 */

const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API v1',
    endpoints: {
      auth: '/api/v1/auth',
      users: '/api/v1/users',
      admin: '/api/v1/admin',
    },
  });
});

router.use('/auth', require('./auth.routes'));
router.use('/users', require('./user.routes'));
router.use('/admin', require('./admin.routes'));

module.exports = router;