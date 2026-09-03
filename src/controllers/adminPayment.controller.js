'use strict';

/**
 * src/controllers/adminPayment.controller.js
 */

const adminPaymentService = require('../services/adminPayment.service');
const { asyncHandler } = require('../utils/helpers');

exports.list = asyncHandler(async (req, res) => {
  const data = await adminPaymentService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});