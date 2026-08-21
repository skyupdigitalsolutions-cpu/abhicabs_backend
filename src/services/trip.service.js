'use strict';

/**
 * src/services/trip.service.js   — Day 11
 *
 * Durable trip breadcrumbs. Where location.service handles the ephemeral live
 * position (Redis), this handles the PERMANENT record (Postgres) — and it is
 * deliberately sparse.
 *
 * ---------------------------------------------------------------------------
 * WHAT GETS PERSISTED, AND WHAT DOES NOT
 * ---------------------------------------------------------------------------
 * A trip needs enough of a durable trail to answer "where did this trip go?"
 * for a dispute or an audit — but NOT every 4-second ping. So we persist:
 *
 *   - trip STARTED   (once)
 *   - trip COMPLETED (once)
 *   - a CHECKPOINT   at most every GPS_CHECKPOINT_SECONDS (default 120s)
 *
 * The checkpoint throttle is enforced with a Redis key that carries a TTL: the
 * first ping after the window writes a TripEvent and re-arms the key; every
 * ping in between is a no-op against Postgres. So a 60-minute trip pinging every
 * 4s (900 pings) produces ~30 checkpoint rows, not 900 — and under the
 * 100-driver ping storm with no active trips, ZERO. That is what keeps the
 * Postgres write count flat.
 */

const { prisma } = require('../config/prisma');
const redis = require('../config/redis');
const env = require('../config/env');
const { emit, EVENTS } = require('../lib/events');

const checkpointGate = (bookingId) => `trip:cp:${bookingId}`;

/**
 * Records the trip's start point. Called once, when the booking goes ONGOING.
 * A single durable row marking where the meter started.
 */
async function recordStart(bookingId, { lat = null, lng = null, odometerKm = null } = {}) {
  return prisma.tripEvent.create({
    data: {
      bookingId,
      eventType: 'started',
      lat: lat != null ? String(lat) : null,
      lng: lng != null ? String(lng) : null,
      odometerKm: odometerKm != null ? Number(odometerKm) : null,
      meta: {},
    },
  });
}

/**
 * Records the trip's end point. Called once, at completion.
 */
async function recordEnd(bookingId, { lat = null, lng = null, odometerKm = null } = {}) {
  return prisma.tripEvent.create({
    data: {
      bookingId,
      eventType: 'completed',
      lat: lat != null ? String(lat) : null,
      lng: lng != null ? String(lng) : null,
      odometerKm: odometerKm != null ? Number(odometerKm) : null,
      meta: {},
    },
  });
}

/**
 * Persists a CHECKPOINT — but only if the throttle window has elapsed for this
 * trip. This is the function the ping path calls; almost every call is a no-op
 * against Postgres.
 *
 * The throttle uses SET NX EX: the first caller after the window sets the gate
 * key (with a checkpointSeconds TTL) and writes the row; subsequent callers find
 * the key present and skip. Race-free and DB-free for the skipped case.
 *
 * @returns {Promise<{ persisted: boolean }>}
 */
async function maybeCheckpoint(bookingId, { lat, lng, speed = null, heading = null }) {
  if (!redis.isCacheUp()) {
    // Without Redis we cannot throttle safely; skip the checkpoint rather than
    // risk writing one per ping. Start/end still persist directly.
    return { persisted: false, reason: 'NO_THROTTLE' };
  }

  // SET gate NX EX <window>. Returns 'OK' only if it did not already exist.
  const won = await redis.cache.set(
    checkpointGate(bookingId),
    '1',
    'EX', env.gps.checkpointSeconds,
    'NX'
  );

  if (won !== 'OK') {
    // Inside the throttle window — a checkpoint already exists for it. No DB.
    return { persisted: false };
  }

  await prisma.tripEvent.create({
    data: {
      bookingId,
      eventType: 'checkpoint',
      lat: lat != null ? String(lat) : null,
      lng: lng != null ? String(lng) : null,
      meta: {
        speed: speed == null ? null : Number(speed),
        heading: heading == null ? null : Number(heading),
      },
    },
  });

  return { persisted: true };
}

/**
 * The full ordered trail for a trip: start, checkpoints, end. For the ops
 * "replay this route" view and dispute handling.
 */
async function trail(bookingId) {
  return prisma.tripEvent.findMany({
    where: { bookingId },
    orderBy: { occurredAt: 'asc' },
  });
}

/**
 * A driver posting a checkpoint-bearing ping DURING a trip. The live position
 * (Redis) is handled by location.service.ingestPing; this adds the durable,
 * throttled breadcrumb on top. Kept here so the ping controller can do both in
 * one call without the location service knowing about trips.
 */
async function onTripPing(bookingId, ping) {
  return maybeCheckpoint(bookingId, ping);
}

module.exports = {
  recordStart,
  recordEnd,
  maybeCheckpoint,
  onTripPing,
  trail,
};