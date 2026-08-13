'use strict';

/**
 * src/controllers/auth.controller.js
 *
 * Controllers stay thin: read the request, call the service, shape the
 * response. No business logic lives here.
 */

const authService = require('../services/auth.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({
  userAgent: req.get('user-agent') || '',
  ip: req.ip || '',
});

exports.register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body, meta(req));
  res.status(201).json({ success: true, message: 'Account created', data: result });
});

exports.login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, meta(req));
  res.json({ success: true, message: 'Logged in', data: result });
});

exports.refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body.refreshToken, meta(req));
  res.json({ success: true, message: 'Token refreshed', data: result });
});

exports.logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body?.refreshToken);
  // Always 200 — logging out must never fail from the user's point of view.
  res.json({ success: true, message: 'Logged out' });
});

exports.logoutAll = asyncHandler(async (req, res) => {
  const result = await authService.logoutAll(req.user.id);
  res.json({ success: true, message: 'Logged out from all devices', data: result });
});

exports.me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

exports.changePassword = asyncHandler(async (req, res) => {
  const result = await authService.changePassword(req.user.id, req.body);
  res.json({ success: true, ...result });
});