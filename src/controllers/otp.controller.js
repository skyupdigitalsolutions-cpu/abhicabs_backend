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
  // audience tells the service WHICH APP is asking. The driver app sends
  // 'DRIVER' so a rider-only number is answered NOT_REGISTERED instead of
  // being sent a code it cannot use. Omitted by the rider app and by older
  // clients, which keeps their behaviour unchanged.
  const data = await authOtp.requestOtp({
    phone: req.body.phone,
    email: req.body.email,
    audience: req.body.audience,
  });
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