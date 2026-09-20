'use strict';

/**
 * src/controllers/fareConfig.controller.js
 *
 * Admin rate-card management. Thin by design — everything that decides
 * anything lives in the service.
 */

const service = require('../services/fareConfig.service');
const { asyncHandler } = require('../utils/helpers');

const q = (req) => req.validatedQuery || req.query || {};
const auditMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.list = asyncHandler(async (req, res) => {
  const data = await service.list(q(req));
  res.json({ success: true, data });
});

exports.cities = asyncHandler(async (req, res) => {
  const data = await service.listCities(q(req));
  res.json({ success: true, data });
});

exports.vehicleClasses = asyncHandler(async (req, res) => {
  const data = await service.listVehicleClasses();
  res.json({ success: true, data });
});

exports.coverage = asyncHandler(async (req, res) => {
  const data = await service.coverage(req.params.cityId);
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  const config = await service.getById(req.params.id);
  res.json({ success: true, data: { config } });
});

exports.create = asyncHandler(async (req, res) => {
  const config = await service.create(req.body, req.user, auditMeta(req));
  res.status(201).json({
    success: true,
    message: `${config.vehicleClass} ${config.tripType} rate card saved — new quotes use it immediately`,
    data: { config },
  });
});

exports.update = asyncHandler(async (req, res) => {
  const config = await service.update(req.params.id, req.body, req.user, auditMeta(req));
  res.json({
    success: true,
    // Says what actually happened: trips already quoted keep their frozen price.
    message: 'Rate card updated — applies to new quotes, not to bookings already made',
    data: { config },
  });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const config = await service.deactivate(req.params.id, req.user, auditMeta(req));
  res.json({ success: true, message: 'Rate card retired', data: { config } });
});

exports.activate = asyncHandler(async (req, res) => {
  const config = await service.activate(req.params.id, req.user, auditMeta(req));
  res.json({ success: true, message: 'Rate card reactivated', data: { config } });
});

exports.clone = asyncHandler(async (req, res) => {
  const config = await service.clone(req.params.id, req.body, req.user, auditMeta(req));
  res.status(201).json({
    success: true,
    message: `Copied to ${config.vehicleClass} ${config.tripType}, effective ${new Date(config.effectiveFrom).toISOString()}`,
    data: { config },
  });
});