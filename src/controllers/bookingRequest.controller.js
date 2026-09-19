'use strict';

/**
 * src/controllers/bookingRequest.controller.js
 *
 * Enquiries for routes outside the service states. See
 * src/services/bookingRequest.service.js for why these are not Bookings.
 */

const service = require('../services/bookingRequest.service');
const { allowedStateNames } = require('../lib/serviceArea');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({
  ip: req.ip || '',
  userAgent: req.get('user-agent') || '',
  source: req.get('x-client-source') || 'api',
});

const q = (req) => req.validatedQuery || req.query || {};

/* ---------------- public ---------------- */

/**
 * The states served, for the app to display and to gate its own UI with.
 *
 * Unauthenticated on purpose: it is the answer to "do you cover my city",
 * which someone should be able to ask before creating an account. It exposes
 * nothing an ad would not.
 */
exports.serviceStates = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { states: await allowedStateNames() } });
});

/* ---------------- customer ---------------- */

exports.create = asyncHandler(async (req, res) => {
  const request = await service.create(req.body, req.user, meta(req));
  res.status(201).json({
    success: true,
    // Says plainly that nothing is booked. A rider who reads "request
    // received" and waits for a driver has been misled by the wrong verb.
    message:
      'Request received. Our team will contact you with a quote — no booking has been made yet.',
    data: { request },
  });
});

exports.listMine = asyncHandler(async (req, res) => {
  const data = await service.listMine(req.user.id, q(req));
  res.json({ success: true, data });
});

exports.cancelMine = asyncHandler(async (req, res) => {
  const request = await service.cancelMine(req.params.id, req.user.id);
  res.json({ success: true, message: 'Request withdrawn', data: { request } });
});

/* ---------------- admin ---------------- */

exports.list = asyncHandler(async (req, res) => {
  const data = await service.list(q(req));
  res.json({ success: true, data });
});

exports.getById = asyncHandler(async (req, res) => {
  const request = await service.getById(req.params.id);
  res.json({ success: true, data: { request } });
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const request = await service.updateStatus(req.params.id, req.body, req.user);
  res.json({ success: true, message: 'Request updated', data: { request } });
});