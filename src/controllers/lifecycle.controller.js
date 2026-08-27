'use strict';

/**
 * src/controllers/lifecycle.controller.js
 */

const lifecycle = require('../services/lifecycle.service');
const allocationService = require('../services/allocation.service');
const cancellation = require('../services/cancellation.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({
  ip: req.ip || '',
  userAgent: req.get('user-agent') || '',
  source: req.get('x-client-source') || 'api',
});

/* ---------------- forward transitions ---------------- */

exports.confirm = asyncHandler(async (req, res) => {
  const booking = await lifecycle.confirm(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'Booking confirmed', data: { booking } });
});

exports.allocate = asyncHandler(async (req, res) => {
  // Day 9: if a vehicle is named, create a real allocation (holds the vehicle,
  // enforces the overlap constraint) rather than only flipping the status. With
  // no vehicleId this stays the plain status move for backward compatibility.
  if (req.body && req.body.vehicleId) {
    const alloc = await allocationService.assignManually(
      req.params.id,
      { vehicleId: req.body.vehicleId, driverId: req.body.driverId || null },
      req.user,
      meta(req)
    );
    return res
      .status(201)
      .json({ success: true, message: 'Vehicle allocated', data: { allocation: alloc } });
  }
  const booking = await lifecycle.markAllocated(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'Vehicle allocated', data: { booking } });
});

exports.enRoute = asyncHandler(async (req, res) => {
  const booking = await lifecycle.markEnRoute(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'Driver is on the way', data: { booking } });
});

exports.start = asyncHandler(async (req, res) => {
  const booking = await lifecycle.startTrip(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'Trip started', data: { booking } });
});

exports.arrive = asyncHandler(async (req, res) => {
  const booking = await lifecycle.markArrived(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'Arrived at destination — awaiting payment', data: { booking } });
});

/**
 * Driver reports the actual distance travelled. If it exceeds the quoted
 * distance, the surplus km are charged at the booking's frozen per-km rate and
 * the final fare rises; the surcharge appears as its own invoice line at
 * completion. Scoped to the assigned driver only.
 */
exports.recordDistance = asyncHandler(async (req, res) => {
  const { booking, extra } = await lifecycle.recordTripDistanceAsDriver(
    req.params.id,
    req.user,
    meta(req),
    { actualKm: req.body.actualKm, odometerKm: req.body.odometerKm ?? null }
  );
  res.json({
    success: true,
    message: extra.hasExtra
      ? `Recorded ${extra.actualKm} km — ${extra.extraKm} km extra charged`
      : `Recorded ${extra.actualKm} km — no extra distance`,
    data: { booking, extra },
  });
});

exports.complete = asyncHandler(async (req, res) => {
  const booking = await lifecycle.completeTrip(req.params.id, req.user, meta(req), {
    actualKm: req.body?.actualKm != null ? Number(req.body.actualKm) : null,
    odometerKm: req.body?.odometerKm != null ? Number(req.body.odometerKm) : null,
    finalFare: req.body?.finalFare != null ? String(req.body.finalFare) : null,
  });
  res.json({ success: true, message: 'Trip completed', data: { booking } });
});

exports.expire = asyncHandler(async (req, res) => {
  const booking = await lifecycle.expire(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'Booking expired', data: { booking } });
});

/* ---------------- introspection ---------------- */

exports.actions = asyncHandler(async (req, res) => {
  const data = await lifecycle.availableActions(req.params.id, req.user);
  res.json({ success: true, data });
});

/* ---------------- cancellation ---------------- */

/** What it would cost, without cancelling. Shown before the confirm dialog. */
exports.quoteCancellation = asyncHandler(async (req, res) => {
  const data = await cancellation.quoteCancellation(req.params.id, req.user);
  res.json({ success: true, data });
});

exports.cancel = asyncHandler(async (req, res) => {
  const data = await cancellation.cancel(req.params.id, req.user, req.body || {}, meta(req));
  res.json({ success: true, message: data.cancellation.settlement, data });
});

/** Policy text for the terms screen, before any booking exists. */
exports.policy = asyncHandler(async (req, res) => {
  const data = await cancellation.getPolicy(req.validatedQuery || req.query);
  res.json({ success: true, data });
});