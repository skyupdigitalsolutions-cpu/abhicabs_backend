'use strict';

/**
 * src/controllers/vehicle.controller.js
 */

const vehicleService = require('../services/vehicle.service');
const { asyncHandler } = require('../utils/helpers');

exports.list = asyncHandler(async (req, res) => {
  const data = await vehicleService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  const vehicle = await vehicleService.findById(req.params.id);
  res.json({ success: true, data: { vehicle } });
});

exports.create = asyncHandler(async (req, res) => {
  const vehicle = await vehicleService.create(req.body);
  res.status(201).json({ success: true, message: 'Vehicle added to fleet', data: { vehicle } });
});

exports.update = asyncHandler(async (req, res) => {
  const vehicle = await vehicleService.update(req.params.id, req.body);
  res.json({ success: true, message: 'Vehicle updated', data: { vehicle } });
});

// Soft delete — the vehicle is deactivated, not physically removed.
exports.remove = asyncHandler(async (req, res) => {
  const vehicle = await vehicleService.softDelete(req.params.id);
  res.json({ success: true, message: 'Vehicle removed from fleet', data: { vehicle } });
});