'use strict';

/**
 * src/routes/index.js   — UPDATED for Day 5
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
      bookings: '/api/v1/bookings',
      payments: '/api/v1/payments',
      drivers: '/api/v1/admin/drivers',
      vehicles: '/api/v1/admin/vehicles',
      adminPayments: '/api/v1/admin/payments',
      invoices: '/api/v1/admin/invoices',
      reports: '/api/v1/admin/reports',
      dispatch: '/api/v1/admin/dispatch',
      location: '/api/v1/admin/location',
      driverLocation: '/api/v1/driver/location',
      webhooks: '/api/v1/webhooks/:provider',
      admin: '/api/v1/admin',
    },
  });
});

// /auth has its own tighter limiters (login, OTP).
router.use('/auth', require('./auth.routes'));

router.use('/users', apiLimiter, require('./user.routes'));
router.use('/customers', apiLimiter, require('./customer.routes'));
router.use('/fares', apiLimiter, require('./fare.routes'));
router.use('/bookings', apiLimiter, require('./booking.routes'));
router.use('/payments', apiLimiter, require('./payment.routes'));

router.use('/admin', apiLimiter, require('./admin.routes'));
router.use('/admin/customers', apiLimiter, require('./adminCustomer.routes'));
router.use('/admin/corporate', apiLimiter, require('./corporate.routes'));
router.use('/admin/bookings', apiLimiter, require('./adminBooking.routes'));
router.use('/admin/drivers', apiLimiter, require('./driver.routes'));
router.use('/admin/vehicles', apiLimiter, require('./vehicle.routes'));
router.use('/admin/payments', apiLimiter, require('./adminPayment.routes'));
router.use('/admin/invoices', apiLimiter, require('./invoice.routes'));
router.use('/admin/reports', apiLimiter, require('./report.routes'));

const dispatchRoutes = require('./dispatch.routes');
router.use('/admin/dispatch', apiLimiter, dispatchRoutes.ops);
router.use('/driver/offers', apiLimiter, dispatchRoutes.driver);

const locationRoutes = require('./location.routes');
router.use('/driver/location', apiLimiter, locationRoutes.driver);
router.use('/admin/location', apiLimiter, locationRoutes.ops);
router.use('/admin/audit', apiLimiter, require('./audit.routes'));

module.exports = router;