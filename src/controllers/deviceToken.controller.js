'use strict';

/**
 * src/controllers/deviceToken.controller.js
 * Self-service: every handler acts on req.user.id — nothing to tamper with.
 */

const push = require('../services/push.service');
const { asyncHandler } = require('../utils/helpers');

exports.register = asyncHandler(async (req, res) => {
  const data = await push.registerToken(req.user.id, req.body);
  res.status(201).json({ success: true, message: 'Device registered for notifications', data });
});

exports.unregister = asyncHandler(async (req, res) => {
  const data = await push.unregisterToken(req.user.id, req.body.token);
  res.json({ success: true, message: 'Device unregistered', data });
});

exports.list = asyncHandler(async (req, res) => {
  const data = await push.listTokens(req.user.id);
  res.json({ success: true, data });
});