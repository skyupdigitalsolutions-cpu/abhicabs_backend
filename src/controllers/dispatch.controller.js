'use strict';

/**
 * src/controllers/dispatch.controller.js   — Day 9
 */

const dispatch = require('../services/dispatch.service');
const allocation = require('../services/allocation.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({
  ip: req.ip || '',
  userAgent: req.get('user-agent') || '',
  source: req.get('x-client-source') || 'api',
});

const q = (req) => req.validatedQuery || req.query || {};

/* ---------------- board ---------------- */

exports.board = asyncHandler(async (req, res) => {
  const data = await dispatch.board(q(req).cityId || null);
  res.json({ success: true, data });
});

exports.pending = asyncHandler(async (req, res) => {
  const bookings = await dispatch.pendingBookings(q(req).cityId || null);
  res.json({ success: true, data: { count: bookings.length, bookings } });
});

exports.live = asyncHandler(async (req, res) => {
  const trips = await dispatch.liveTrips(q(req).cityId || null);
  res.json({ success: true, data: { count: trips.length, trips } });
});

exports.availableVehicles = asyncHandler(async (req, res) => {
  const { cityId, vehicleClass } = q(req);
  const vehicles = await dispatch.availableVehicles(cityId || null, vehicleClass || null);
  res.json({ success: true, data: { count: vehicles.length, vehicles } });
});

/* ---------------- allocation ---------------- */

exports.assign = asyncHandler(async (req, res) => {
  const alloc = await allocation.assignManually(
    req.params.bookingId,
    { vehicleId: req.body.vehicleId, driverId: req.body.driverId || null },
    req.user,
    meta(req)
  );
  res.status(201).json({ success: true, message: 'Vehicle allocated', data: { allocation: alloc } });
});

exports.reassign = asyncHandler(async (req, res) => {
  const alloc = await allocation.reassign(
    req.params.bookingId,
    { vehicleId: req.body.vehicleId, driverId: req.body.driverId || null },
    req.user,
    meta(req)
  );
  res.json({ success: true, message: 'Vehicle reassigned', data: { allocation: alloc } });
});

exports.getForBooking = asyncHandler(async (req, res) => {
  const alloc = await allocation.getForBooking(req.params.bookingId);
  res.json({ success: true, data: { allocation: alloc } });
});