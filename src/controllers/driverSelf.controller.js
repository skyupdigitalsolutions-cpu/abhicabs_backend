'use strict';

/**
 * src/controllers/driverSelf.controller.js
 *
 * Every handler below acts on req.user.id. There is no :id route param for the
 * driver's own record anywhere in driverSelf.routes.js, so there is nothing for
 * a caller to tamper with — the same design customer.controller.js uses.
 *
 * :vehicleId does appear, and ownership is checked in the service
 * (requireOwnedVehicle), not here.
 */

const driverSelfService = require('../services/driverSelf.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });

/* ---------------- registration (public) ---------------- */

exports.register = asyncHandler(async (req, res) => {
  const result = await driverSelfService.register(req.body, meta(req));
  res.status(201).json({
    success: true,
    message: 'Driver account created. Upload your documents to continue.',
    data: result,
  });
});

/* ---------------- profile ---------------- */

exports.getMe = asyncHandler(async (req, res) => {
  const data = await driverSelfService.getMe(req.user.id);
  res.json({ success: true, data });
});

exports.updateMe = asyncHandler(async (req, res) => {
  const driver = await driverSelfService.updateMe(req.user.id, req.body);
  res.json({ success: true, message: 'Profile updated', data: { driver } });
});

exports.getOnboarding = asyncHandler(async (req, res) => {
  const onboarding = await driverSelfService.onboardingState(req.user.id);
  res.json({ success: true, data: { onboarding } });
});

/* ---------------- documents ---------------- */

exports.uploadDocument = asyncHandler(async (req, res) => {
  const data = await driverSelfService.saveDriverDocument(
    req.user.id,
    req.body.docType,
    req.file,
  );
  res.status(201).json({ success: true, message: `${req.body.docType} uploaded`, data });
});

exports.uploadVehicleDocument = asyncHandler(async (req, res) => {
  const data = await driverSelfService.saveVehicleDocument(
    req.user.id,
    req.params.vehicleId,
    req.body.docType,
    req.file,
    req.body.expiry || null,
  );
  res.status(201).json({ success: true, message: `${req.body.docType} uploaded`, data });
});

/* ---------------- vehicles ---------------- */

exports.registerVehicle = asyncHandler(async (req, res) => {
  const data = await driverSelfService.registerOwnVehicle(req.user.id, req.body);
  res.status(201).json({
    success: true,
    message: 'Vehicle submitted for verification',
    data,
  });
});

exports.claimVehicle = asyncHandler(async (req, res) => {
  const claim = await driverSelfService.claimFleetVehicle(req.user.id, req.body);
  res.status(201).json({
    success: true,
    message: 'Vehicle request submitted for approval',
    data: { claim },
  });
});

exports.listVehicles = asyncHandler(async (req, res) => {
  const data = await driverSelfService.listMyVehicles(req.user.id, req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.withdrawClaim = asyncHandler(async (req, res) => {
  const claim = await driverSelfService.withdrawClaim(req.user.id, req.params.claimId);
  res.json({ success: true, message: 'Request withdrawn', data: { claim } });
});

/* ---------------- submit ---------------- */

exports.submit = asyncHandler(async (req, res) => {
  const data = await driverSelfService.submitForReview(req.user.id);
  res.json({
    success: true,
    message: 'Application submitted for review',
    data,
  });
});