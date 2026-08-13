'use strict';

/**
 * src/controllers/admin.controller.js
 *
 * Admin-only routes. Every route mounting these is guarded by
 * requireAuth + requireRole('ADMIN').
 */

const userService = require('../services/user.service');
const { asyncHandler } = require('../utils/helpers');

exports.listUsers = asyncHandler(async (req, res) => {
  // Express 5 makes req.query read-only, so the validate middleware stores the
  // parsed result on req.validatedQuery.
  const result = await userService.list(req.validatedQuery || req.query);
  res.json({ success: true, data: result });
});

exports.getUser = asyncHandler(async (req, res) => {
  const user = await userService.findById(req.params.id);
  res.json({ success: true, data: { user } });
});

exports.createUser = asyncHandler(async (req, res) => {
  const user = await userService.create(req.body);
  res.status(201).json({ success: true, message: 'User created', data: { user } });
});

exports.updateUser = asyncHandler(async (req, res) => {
  const user = await userService.update(req.params.id, req.body, req.user);
  res.json({ success: true, message: 'User updated', data: { user } });
});

exports.deleteUser = asyncHandler(async (req, res) => {
  const result = await userService.remove(req.params.id, req.user);
  res.json({ success: true, ...result });
});

exports.activateUser = asyncHandler(async (req, res) => {
  const user = await userService.setActive(req.params.id, true, req.user);
  res.json({ success: true, message: 'User activated', data: { user } });
});

exports.deactivateUser = asyncHandler(async (req, res) => {
  const user = await userService.setActive(req.params.id, false, req.user);
  res.json({ success: true, message: 'User deactivated', data: { user } });
});

exports.stats = asyncHandler(async (req, res) => {
  const data = await userService.stats();
  res.json({ success: true, data });
});