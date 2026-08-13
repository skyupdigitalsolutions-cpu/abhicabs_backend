'use strict';

/**
 * src/controllers/user.controller.js
 *
 * Self-service routes — a signed-in user acting on their own record.
 */

const userService = require('../services/user.service');
const { asyncHandler } = require('../utils/helpers');

exports.getProfile = asyncHandler(async (req, res) => {
  const user = await userService.findById(req.user.id);
  res.json({ success: true, data: { user } });
});

exports.updateProfile = asyncHandler(async (req, res) => {
  // req.user is passed as the actor so the service can strip privileged
  // fields (role, isActive) that a non-admin must never set.
  const user = await userService.update(req.user.id, req.body, req.user);
  res.json({ success: true, message: 'Profile updated', data: { user } });
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  const result = await userService.remove(req.user.id, req.user);
  res.json({ success: true, ...result });
});