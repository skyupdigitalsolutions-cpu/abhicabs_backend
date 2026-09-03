'use strict';

/**
 * src/controllers/driver.controller.js
 *
 * The :id route param is the driver's userId.
 */

const driverService = require('../services/driver.service');
const { asyncHandler } = require('../utils/helpers');

exports.list = asyncHandler(async (req, res) => {
  const data = await driverService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  const driver = await driverService.findById(req.params.id);
  res.json({ success: true, data: { driver } });
});

exports.create = asyncHandler(async (req, res) => {
  const driver = await driverService.create(req.body);
  res.status(201).json({ success: true, message: 'Driver onboarded', data: { driver } });
});

exports.update = asyncHandler(async (req, res) => {
  const driver = await driverService.update(req.params.id, req.body);
  res.json({ success: true, message: 'Driver updated', data: { driver } });
});

exports.activate = asyncHandler(async (req, res) => {
  const driver = await driverService.setActive(req.params.id, true);
  res.json({ success: true, message: 'Driver activated', data: { driver } });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const driver = await driverService.setActive(req.params.id, false);
  res.json({ success: true, message: 'Driver deactivated', data: { driver } });
});