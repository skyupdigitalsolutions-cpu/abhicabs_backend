'use strict';

/**
 * src/controllers/otp.controller.js
 */

const authOtp = require('../services/authOtp.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({
  userAgent: req.get('user-agent') || '',
  ip: req.ip || '',
});

exports.requestOtp = asyncHandler(async (req, res) => {
  const data = await authOtp.requestOtp(req.body.phone);
  res.json({ success: true, message: data.message, data });
});

exports.verifyOtp = asyncHandler(async (req, res) => {
  const data = await authOtp.verifyAndLogin(req.body, meta(req));
  res.status(data.isNewAccount ? 201 : 200).json({
    success: true,
    message: data.isNewAccount ? 'Account created' : 'Logged in',
    data,
  });
});