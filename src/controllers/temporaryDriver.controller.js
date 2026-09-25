'use strict';

const service = require('../services/temporaryDriver.service');
const { asyncHandler } = require('../utils/helpers');

const auditMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.list = asyncHandler(async (req, res) => {
  const drivers = await service.list(req.validatedQuery || req.query || {});
  res.json({ success: true, data: { count: drivers.length, drivers } });
});

exports.create = asyncHandler(async (req, res) => {
  const driver = await service.create(req.body, req.user, auditMeta(req));
  res.status(201).json({
    success: true,
    message: `${driver.name} added with ${driver.vehicle.registrationNumber} — available to dispatch now`,
    data: { driver },
  });
});

exports.release = asyncHandler(async (req, res) => {
  const result = await service.release(req.params.id, req.user, auditMeta(req));
  res.json({ success: true, message: `${result.name} released`, data: result });
});