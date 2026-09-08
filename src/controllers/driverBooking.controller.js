'use strict';

/**
 * src/controllers/driverBooking.controller.js
 *
 * Driver-facing actions on a booking the driver is assigned to. Currently:
 * collecting the outstanding balance in cash after the ride.
 */

const paymentService = require('../services/payment.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });

exports.collectCash = asyncHandler(async (req, res) => {
  const result = await paymentService.collectCash(req.params.bookingId, req.user, meta(req));
  res.json({ success: true, message: 'Cash collected', data: result });
});