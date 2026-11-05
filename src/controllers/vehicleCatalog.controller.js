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

/**
 * PERMANENT delete of a vehicle class, for one created by mistake.
 *
 * Distinct from `deactivate` on a distinct route, not a flag: only one of the
 * two is reversible, and an admin tool should not be able to send the
 * destructive one by accident. Refused by the service if anything — a booking,
 * a vehicle, a rate card, a rental package — still names the class.
 */
exports.destroy = asyncHandler(async (req, res) => {
  const vehicle = await service.destroy(req.params.key, req.user, auditMeta(req));
  res.json({
    success: true,
    message: `${vehicle.name} permanently deleted`,
    data: { vehicle },
  });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const vehicle = await service.deactivate(req.params.key, req.user, auditMeta(req));
  res.json({ success: true, message: `${vehicle.name} retired`, data: { vehicle } });
});

exports.activate = asyncHandler(async (req, res) => {
  const vehicle = await service.activate(req.params.key, req.user, auditMeta(req));
  res.json({ success: true, message: `${vehicle.name} is live again`, data: { vehicle } });
});

/* ------------------------------------------------------------------ *
 * The booking switch
 * ------------------------------------------------------------------ */

/**
 * Switch booking on or off for ONE class.
 *
 * PATCH /admin/vehicles/:key/booking   { enabled: false, reason?: "..." }
 *
 * Distinct from `deactivate` on a distinct route, because the two are
 * different decisions with different blast radii: deactivate retires the class
 * from the catalogue and refuses while rate cards price it, this takes it off
 * sale for the weekend and leaves everything else alone. An admin UI that
 * routed its on/off toggle to deactivate would be asking people to delete
 * rate cards to park a car.
 */
exports.setBooking = asyncHandler(async (req, res) => {
  const vehicle = await service.setBookingEnabled(
    req.params.key,
    { enabled: req.body.enabled, reason: req.body.reason ?? null },
    req.user,
    auditMeta(req),
  );

  res.json({
    success: true,
    message: vehicle.bookingEnabled
      ? `${vehicle.name} is open for booking`
      : `${vehicle.name} is no longer bookable`,
    data: { vehicle },
  });
});

/**
 * The global switch: stop or resume taking bookings for every vehicle.
 *
 * PATCH /admin/vehicles/booking/all   { enabled: false, reason?: "..." }
 *
 * Declared BEFORE the '/:key' routes in the router — see the note there. It
 * does not touch any class's own switch, so turning this back on restores
 * whatever per-class configuration was in place beforehand rather than
 * flattening it.
 */
exports.setBookingAll = asyncHandler(async (req, res) => {
  const state = await service.setAllBookingEnabled(
    { enabled: req.body.enabled, reason: req.body.reason ?? null },
    req.user,
    auditMeta(req),
  );

  res.json({
    success: true,
    message: state.allDisabled
      ? 'Bookings are now switched off for all vehicles'
      : 'Bookings are open again',
    data: { booking: state },
  });
});

/**
 * Everything the admin switch panel needs in one call: the global switch, and
 * every class with its own state plus whether it is EFFECTIVELY bookable once
 * both switches are taken together.
 */
exports.bookingStatus = asyncHandler(async (req, res) => {
  const status = await service.bookingStatus();
  res.json({ success: true, data: status });
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