'use strict';

/**
 * src/controllers/vehicleCatalog.controller.js
 */

const service = require('../services/vehicleCatalog.service');
const { asyncHandler, ApiError } = require('../utils/helpers');

const q = (req) => req.validatedQuery || req.query || {};
const auditMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.list = asyncHandler(async (req, res) => {
  const vehicles = await service.list(q(req));
  res.json({ success: true, data: { count: vehicles.length, vehicles } });
});

exports.getOne = asyncHandler(async (req, res) => {
  const vehicle = await service.getByKey(req.params.key);
  res.json({ success: true, data: { vehicle } });
});

exports.create = asyncHandler(async (req, res) => {
  const vehicle = await service.create(req.body, req.user, auditMeta(req));
  res.status(201).json({ success: true, message: `${vehicle.name} added`, data: { vehicle } });
});

exports.update = asyncHandler(async (req, res) => {
  const vehicle = await service.update(req.params.key, req.body, req.user, auditMeta(req));
  res.json({ success: true, message: 'Vehicle updated', data: { vehicle } });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const vehicle = await service.deactivate(req.params.key, req.user, auditMeta(req));
  res.json({ success: true, message: `${vehicle.name} retired`, data: { vehicle } });
});

exports.activate = asyncHandler(async (req, res) => {
  const vehicle = await service.activate(req.params.key, req.user, auditMeta(req));
  res.json({ success: true, message: `${vehicle.name} is live again`, data: { vehicle } });
});

/**
 * multipart/form-data. multer has already parsed the file into req.file before
 * this runs; the text fields arrive on req.body as strings, which is why
 * `asHero` is coerced in the schema rather than read as a boolean here.
 */
exports.addImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw ApiError.badRequest('No image received. Send it as `file`.', 'NO_FILE');
  }

  const vehicle = await service.addImage(
    req.params.key,
    {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      label: req.body.label,
      asHero: req.body.asHero,
    },
    req.user,
    auditMeta(req),
  );

  res.status(201).json({ success: true, message: 'Image uploaded', data: { vehicle } });
});

exports.removeImage = asyncHandler(async (req, res) => {
  // Cloudinary public ids contain '/', so the route captures the rest of the
  // path as one wildcard parameter rather than a single segment.
  const publicId = req.params[0] || req.params.publicId;
  const vehicle = await service.removeImage(req.params.key, publicId, req.user, auditMeta(req));
  res.json({ success: true, message: 'Image removed', data: { vehicle } });
});