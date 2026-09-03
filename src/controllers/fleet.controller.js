'use strict';

/**
 * src/controllers/fleet.controller.js
 *
 * Thin HTTP layer over fleet.service. List handlers read the validated query
 * from req.validatedQuery (Express 5 makes req.query read-only, so the
 * validate middleware stores the parsed result there).
 */

const fleetService = require('../services/fleet.service');
const { asyncHandler } = require('../utils/helpers');

/* ---------------- vehicles ---------------- */

exports.listVehicles = asyncHandler(async (req, res) => {
  const data = await fleetService.listVehicles(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.getVehicle = asyncHandler(async (req, res) => {
  const vehicle = await fleetService.getVehicleById(req.params.id);
  res.json({ success: true, data: { vehicle } });
});

/* ---------------- drivers ---------------- */

exports.listDrivers = asyncHandler(async (req, res) => {
  const data = await fleetService.listDrivers(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.getDriver = asyncHandler(async (req, res) => {
  const driver = await fleetService.getDriverById(req.params.userId);
  res.json({ success: true, data: { driver } });
});