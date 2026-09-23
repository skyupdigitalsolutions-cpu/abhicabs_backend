'use strict';

/**
 * src/routes/index.js   — UPDATED for Day 5
 */

const express = require('express');
const { apiLimiter, contactLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API v1',
    endpoints: {
      auth: '/api/v1/auth',
      users: '/api/v1/users',
      customers: '/api/v1/customers',
      deviceTokens: '/api/v1/device-tokens',
      fares: '/api/v1/fares',
      bookings: '/api/v1/bookings',
      payments: '/api/v1/payments',
      contact: '/api/v1/contact',
      drivers: '/api/v1/admin/drivers',
      vehicles: '/api/v1/admin/vehicles',
      fleet: '/api/v1/admin/fleet',
      adminPayments: '/api/v1/admin/payments',
      invoices: '/api/v1/admin/invoices',
      reports: '/api/v1/admin/reports',
      fareConfigs: '/api/v1/admin/fare-configs',
      vehicles: '/api/v1/vehicles',
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
router.use('/device-tokens', apiLimiter, require('./deviceToken.routes'));
router.use('/fares', apiLimiter, require('./fare.routes'));
router.use('/bookings', apiLimiter, require('./booking.routes'));
router.use('/payments', apiLimiter, require('./payment.routes'));

// Public website contact form (no auth) + the staff inbox that reads it.
const contactRoutes = require('./contact.routes');
router.use('/contact', contactLimiter, contactRoutes.publicRoutes);
router.use('/admin/contacts', apiLimiter, contactRoutes.adminRoutes);

router.use('/admin', apiLimiter, require('./admin.routes'));
router.use('/admin/customers', apiLimiter, require('./adminCustomer.routes'));
router.use('/admin/corporate', apiLimiter, require('./corporate.routes'));
router.use('/admin/bookings', apiLimiter, require('./adminBooking.routes'));
router.use('/admin/drivers', apiLimiter, require('./driver.routes'));
router.use('/admin/vehicles', apiLimiter, require('./vehicle.routes'));
router.use('/admin/fleet', apiLimiter, require('./fleet.routes'));
router.use('/admin/payments', apiLimiter, require('./adminPayment.routes'));
router.use('/admin/invoices', apiLimiter, require('./invoice.routes'));
router.use('/admin/reports', apiLimiter, require('./report.routes'));

// Rate cards. Mounted BEFORE the bare '/admin' router would matter if that one
// had a catch-all; it does not, but keeping the admin mounts grouped is what
// stops the next one from being forgotten the way this one was.
router.use('/admin/fare-configs', apiLimiter, require('./fareConfig.routes'));

// Vehicle catalogue. The browse side is PUBLIC — see the route file for why —
// so it is mounted outside the /admin tree, next to the other rider routes.
const vehicleCatalog = require('./vehicleCatalog.routes');
router.use('/vehicles', apiLimiter, vehicleCatalog.publicRouter);
router.use('/admin/vehicles', apiLimiter, vehicleCatalog.adminRouter);

// Out-of-area enquiries. Three audiences, three routers — see the route file.
const bookingRequestRoutes = require('./bookingRequest.routes');
router.use('/', bookingRequestRoutes.pub);
router.use('/booking-requests', apiLimiter, bookingRequestRoutes.customer);
router.use('/admin/booking-requests', apiLimiter, bookingRequestRoutes.ops);

// The state allowlist. Public READ is on /service-states above; these are the
// admin writes.
router.use('/admin/service-states', apiLimiter, require('./serviceState.routes'));

const dispatchRoutes = require('./dispatch.routes');
router.use('/admin/dispatch', apiLimiter, dispatchRoutes.ops);
router.use('/driver/offers', apiLimiter, dispatchRoutes.driver);
router.use('/driver/bookings', apiLimiter, require('./driverBooking.routes'));
// Driver self-service: own profile, documents, vehicle registration/claims.
router.use('/driver/me', apiLimiter, require('./driverSelf.routes'));

const locationRoutes = require('./location.routes');
router.use('/driver/location', apiLimiter, locationRoutes.driver);
router.use('/admin/location', apiLimiter, locationRoutes.ops);
router.use('/location', apiLimiter, locationRoutes.rider);
router.use('/admin/audit', apiLimiter, require('./audit.routes'));

module.exports = router;