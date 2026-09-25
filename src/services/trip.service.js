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
const { ApiError } = require('../utils/helpers');

const checkpointGate = (bookingId) => `trip:cp:${bookingId}`;

/**
 * Records the trip's start point. Called once, when the booking goes ONGOING.
 * A single durable row marking where the meter started.
 *
 * `tx` is optional so lifecycle.startTrip can write this INSIDE the status
 * transition. The start reading is now mandatory for drivers, so it must not
 * be possible for a trip to be ONGOING with the reading lost to a failed
 * follow-up write — which is what the old fire-and-forget call allowed.
 */
async function recordStart(
  bookingId,
  { lat = null, lng = null, odometerKm = null, photoUrl = null, photoPublicId = null, actorId = null } = {},
  tx = prisma,
) {
  return tx.tripEvent.create({
    data: {
      bookingId,
      eventType: 'started',
      lat: lat != null ? String(lat) : null,
      lng: lng != null ? String(lng) : null,
      odometerKm: odometerKm != null ? Number(odometerKm) : null,
      note: odometerKm != null ? 'Start odometer reading submitted by driver' : null,
      meta: {
        photoUrl: photoUrl || null,
        photoPublicId: photoPublicId || null,
        submittedById: actorId || null,
      },
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

/**
 * The END-of-trip odometer reading and its photo. The only writer of the
 * booking's end_odometer_* columns.
 *
 * Called by the driver's /odometer route, and by /complete when the reading
 * comes with the completion request. A driver cannot complete a trip without
 * one (lifecycle.completeTrip checks the column).
 *
 * In ONE transaction:
 *   1. refuse a booking that is already COMPLETED — its reading is evidence
 *      on an issued invoice and is corrected by ops, not by the driver
 *   2. refuse a reading below this trip's START reading
 *   3. refuse a reading below the vehicle's odometer (first submission only —
 *      see below)
 *   4. write the booking columns, a durable `odometer` trip_event, and advance
 *      the vehicle's odometer
 *
 * RE-SUBMISSION before completion is allowed and REPLACES the earlier one, so
 * a driver who typed 45120 for 45210 can fix it while still at the kerb. The
 * vehicle check is relaxed for a replacement: the first submission already
 * pushed the vehicle's odometer to the mistyped value, so a correct LOWER
 * figure would otherwise be refused against the driver's own typo.
 *
 * Returns `replacedPublicId` — the previous photo — for the caller to delete
 * AFTER this commits. Deleting it inside the transaction would lose it if the
 * transaction then rolled back.
 */
async function recordOdometer(
  bookingId,
  { odometerKm, vehicleId, photoUrl = null, photoPublicId = null, actorId = null } = {},
) {
  const reading = Number(odometerKm);
  if (!Number.isInteger(reading) || reading < 0) {
    throw ApiError.badRequest('A valid odometer reading is required', 'INVALID_ODOMETER');
  }

  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: {
        status: true,
        startOdometerKm: true,
        endOdometerKm: true,
        endOdometerPhotoPublicId: true,
      },
    });
    if (!booking) throw ApiError.notFound('Booking not found');

    if (booking.status === 'COMPLETED') {
      throw ApiError.conflict(
        'This trip is already completed and its odometer reading is locked. Contact support to correct it.',
        'ODOMETER_LOCKED',
      );
    }

    // Repeated INSIDE the transaction. The controller checks this before the
    // upload, but a trip cancelled by ops in the seconds the photo takes to
    // upload would otherwise get an end reading written onto a dead booking.
    if (!['ONGOING', 'ARRIVED'].includes(booking.status)) {
      throw ApiError.conflict(
        `The end odometer can only be recorded on a trip in progress (this one is ${booking.status})`,
        'TRIP_NOT_IN_PROGRESS',
      );
    }

    if (booking.startOdometerKm != null && reading < booking.startOdometerKm) {
      throw ApiError.conflict(
        `End reading ${reading} km is below this trip's start reading (${booking.startOdometerKm} km)`,
        'ODOMETER_BELOW_START',
      );
    }

    const isReplacement = booking.endOdometerKm != null;

    if (vehicleId) {
      const vehicle = await tx.vehicle.findUnique({
        where: { id: vehicleId },
        select: { odometerKm: true },
      });

      if (vehicle && !isReplacement && reading < vehicle.odometerKm) {
        throw ApiError.conflict(
          `Reading ${reading} km is below the vehicle's current odometer (${vehicle.odometerKm} km)`,
          'ODOMETER_BELOW_CURRENT',
        );
      }

      if (vehicle) {
        // Forward, as always — or, for a replacement, back down to the
        // corrected figure ONLY if the vehicle still holds this trip's own
        // earlier (mistyped) value. If anything else has moved it since,
        // leave it alone.
        const ownEarlierValue = isReplacement && vehicle.odometerKm === booking.endOdometerKm;
        if (reading > vehicle.odometerKm || ownEarlierValue) {
          await tx.vehicle.update({ where: { id: vehicleId }, data: { odometerKm: reading } });
        }
      }
    }

    await tx.booking.update({
      where: { id: bookingId },
      data: {
        endOdometerKm: reading,
        endOdometerPhotoUrl: photoUrl,
        endOdometerPhotoPublicId: photoPublicId,
      },
    });

    const event = await tx.tripEvent.create({
      data: {
        bookingId,
        eventType: 'odometer',
        odometerKm: reading,
        note: isReplacement
          ? 'End odometer reading corrected by driver'
          : 'End odometer reading submitted by driver',
        meta: {
          photoUrl: photoUrl || null,
          photoPublicId: photoPublicId || null,
          submittedByDriverId: actorId || null,
          submittedAt: new Date().toISOString(),
          ...(isReplacement ? { replacedReading: booking.endOdometerKm } : {}),
        },
      },
      select: { id: true, odometerKm: true, occurredAt: true },
    });

    return {
      bookingId,
      vehicleId: vehicleId || null,
      odometerKm: reading,
      startOdometerKm: booking.startOdometerKm,
      // Informational only — the fare is NOT derived from this. See the
      // completion notes in lifecycle.completeTrip.
      odometerKmDriven:
        booking.startOdometerKm != null ? reading - booking.startOdometerKm : null,
      replaced: isReplacement,
      replacedPublicId: isReplacement ? booking.endOdometerPhotoPublicId || null : null,
      eventId: event.id,
      at: event.occurredAt,
    };
  });
}

/**
 * The driver reached the PICKUP point. One durable TripEvent capturing where and
 * when — the pickup-arrival breadcrumb (distinct from the `arrived` at drop-off).
 */
async function recordReached(bookingId, { lat = null, lng = null } = {}) {
  return prisma.tripEvent.create({
    data: {
      bookingId,
      eventType: 'reached',
      lat: lat != null ? Number(lat).toFixed(7) : null,
      lng: lng != null ? Number(lng).toFixed(7) : null,
      note: 'Driver reached the pickup point',
    },
    select: { id: true, occurredAt: true },
  });
}

module.exports = {
  recordStart,
  recordReached,
  recordEnd,
  recordOdometer,
  maybeCheckpoint,
  onTripPing,
  trail,
};