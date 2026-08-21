'use strict';

/**
 * src/controllers/location.controller.js   — Day 11
 */

const location = require('../services/location.service');
const trip = require('../services/trip.service');
const { asyncHandler, ApiError } = require('../utils/helpers');

// Best-effort live broadcast of a driver's position over the Day 10 sockets.
// Loaded lazily and guarded so the ping path never fails because realtime is
// unavailable — a ping is a Redis write first, a broadcast second.
function broadcastPosition(driverId, bookingId, body) {
  try {
    const { getIO, rooms } = require('../realtime');
    const io = getIO();
    if (bookingId) {
      io.to(rooms.booking(bookingId)).emit('trip:location', { driverId, bookingId, ...body });
    }
    io.to(rooms.DISPATCH).emit('driver:location', { driverId, ...body });
  } catch (_) {
    /* realtime not initialised, or no listeners — ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Driver ping — the hot path. Redis only; no Postgres on the happy path.
 * ------------------------------------------------------------------ */

exports.ping = asyncHandler(async (req, res) => {
  const driverId = req.user.id;
  const { lat, lng, speed, heading, bookingId, at } = req.body;

  const result = await location.ingestPing(driverId, { lat, lng, speed, heading, at });

  if (!result.accepted) {
    // A rejected ping (teleport / implausible speed) is a 202 with a reason, not
    // a hard error — the client keeps pinging, and one bad fix should not look
    // like a failed request.
    return res.status(202).json({ success: false, data: result });
  }

  // If the driver is on a trip, add the durable throttled checkpoint. Almost
  // every call here is a no-op against Postgres (inside the throttle window).
  let checkpoint = null;
  if (bookingId) {
    checkpoint = await trip.onTripPing(bookingId, { lat, lng, speed, heading });
  }

  // Fire the live broadcast after the write so watchers see the new position.
  broadcastPosition(driverId, bookingId, { lat, lng, speed: speed ?? null, heading: heading ?? null, at: at || new Date().toISOString() });

  res.json({
    success: true,
    data: { accepted: true, speedKmph: result.speedKmph, jumpKm: result.jumpKm, checkpoint },
  });
});

/* ------------------------------------------------------------------ *
 * Online / offline
 * ------------------------------------------------------------------ */

exports.goOnline = asyncHandler(async (req, res) => {
  const out = await location.markOnline(req.user.id);
  res.json({ success: true, message: 'You are online', data: out });
});

exports.goOffline = asyncHandler(async (req, res) => {
  const out = await location.markOffline(req.user.id);
  res.json({ success: true, message: 'You are offline', data: out });
});

/* ------------------------------------------------------------------ *
 * Dispatch reads
 * ------------------------------------------------------------------ */

exports.nearby = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const vehicles = await location.nearbyVehicles({
    lat: q.lat,
    lng: q.lng,
    radiusKm: q.radiusKm || 5,
    limit: q.limit || 20,
  });
  res.json({ success: true, data: { count: vehicles.length, drivers: vehicles } });
});

exports.driverLocation = asyncHandler(async (req, res) => {
  const loc = await location.driverLocation(req.params.driverId);
  if (!loc) throw ApiError.notFound('No live location for this driver');
  res.json({ success: true, data: { location: loc } });
});

exports.tripTrail = asyncHandler(async (req, res) => {
  const events = await trip.trail(req.params.bookingId);
  res.json({ success: true, data: { count: events.length, trail: events } });
});

exports.sweepStale = asyncHandler(async (req, res) => {
  const result = await location.sweepStaleDrivers();
  res.json({ success: true, message: 'Stale drivers swept', data: result });
});