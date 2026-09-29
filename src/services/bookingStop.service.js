'use strict';

/**
 * src/services/bookingStop.service.js
 *
 * Progress through the intermediate stops of a multi-stop trip.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ADDS
 * ---------------------------------------------------------------------------
 * The lifecycle had one destination. EN_ROUTE -> REACHED -> ONGOING -> ARRIVED
 * describes a trip from A to B, so a booking with three stops in between had
 * nowhere to record reaching the second one. The driver had nothing to mark,
 * the rider saw no progress, and time spent waiting at a stop left no trace at
 * all.
 *
 * Stops are tracked as their own records rather than as extra booking
 * statuses. A status is a single value, so "at stop 2, having served stop 1"
 * cannot be expressed in one — it would need a status per stop count, and the
 * number of stops is not fixed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not touch the fare. Waiting time at a stop is recorded and can be
 * read back, but nothing here charges for it: waiting is currently never
 * billed (fare.service sets the waiting charge to zero), and quietly turning
 * these timestamps into money would change what every multi-stop trip costs
 * without anyone deciding to.
 *
 * It does not gate completion. A driver who forgets to mark a stop can still
 * finish the trip. Blocking completion on a housekeeping tap would strand a
 * rider in a finished car over a missing record.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');

/**
 * Trip states in which stop progress can be recorded.
 *
 * ONGOING only. Before the trip starts nothing has been reached; after it ends
 * the record is closed. ARRIVED is excluded on purpose — it means the final
 * drop has been reached, so an intermediate stop marked after it is either a
 * mistake or a driver catching up on taps, and neither should be written as
 * though it happened then.
 */
const TRACKABLE = new Set(['ONGOING']);

/** The stops a booking was BOOKED with — the plan, from the JSON column. */
function plannedStops(booking) {
  const raw = booking.stops;
  if (!Array.isArray(raw)) return [];
  return raw.map((s, i) => ({
    seq: i,
    lat: s?.lat ?? null,
    lng: s?.lng ?? null,
    address: s?.address ?? null,
  }));
}

/**
 * Create one progress row per planned stop, all unreached.
 *
 * Called when the trip STARTS, not when it is booked. A booking that is later
 * cancelled then leaves no stop rows at all, and — more usefully — a booking
 * with no rows can be read as "predates stop tracking" rather than "stalled at
 * the first stop". The two look identical if rows are created at booking time.
 *
 * Safe to call twice: createMany with skipDuplicates leans on the
 * (booking_id, seq) unique index, so a retried start does not double up.
 */
async function initialiseForTrip(bookingId, tx = prisma) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, stops: true },
  });
  if (!booking) return [];

  const planned = plannedStops(booking);
  if (planned.length === 0) return [];

  await tx.bookingStop.createMany({
    data: planned.map((s) => ({
      bookingId,
      seq: s.seq,
      address: s.address,
    })),
    skipDuplicates: true,
  });

  return listForBooking(bookingId, tx);
}

/** Every stop of a booking, in order, plan joined to progress. */
async function listForBooking(bookingId, tx = prisma) {
  const [booking, rows] = await Promise.all([
    tx.booking.findUnique({ where: { id: bookingId }, select: { stops: true } }),
    tx.bookingStop.findMany({ where: { bookingId }, orderBy: { seq: 'asc' } }),
  ]);
  if (!booking) throw ApiError.notFound('Booking not found');

  const progress = new Map(rows.map((r) => [r.seq, r]));

  /*
   * Driven by the PLAN, not by the progress rows. A booking made before stop
   * tracking existed has stops in its JSON and no rows at all; iterating the
   * rows would report it as a trip with no stops, which is a lie about what
   * the rider booked.
   */
  return plannedStops(booking).map((s) => {
    const p = progress.get(s.seq) ?? null;
    return {
      seq: s.seq,
      lat: s.lat,
      lng: s.lng,
      address: s.address ?? p?.address ?? null,
      arrivedAt: p?.arrivedAt ?? null,
      departedAt: p?.departedAt ?? null,
      /*
       * Three states the caller can branch on without comparing timestamps:
       *   PENDING   not reached yet
       *   AT_STOP   driver is there now
       *   DONE      served and left
       * `tracked` is false when there is no row — the booking predates this
       * feature — so the app can say "not tracked" instead of "pending".
       */
      status: !p?.arrivedAt ? 'PENDING' : p.departedAt ? 'DONE' : 'AT_STOP',
      tracked: p !== null,
      waitedSeconds:
        p?.arrivedAt && p?.departedAt
          ? Math.max(0, Math.round((p.departedAt.getTime() - p.arrivedAt.getTime()) / 1000))
          : null,
    };
  });
}

/** The booking, checked to be this driver's and in a state that accepts marks. */
async function loadTrackable(bookingId, driverId) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, status: true, stops: true,
      allocations: {
        where: { status: 'ACTIVE' },
        select: { driverId: true },
        take: 1,
      },
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  // A driver may only mark the trip they are actually on.
  const assigned = booking.allocations?.[0]?.driverId ?? null;
  if (!assigned || assigned !== driverId) {
    throw ApiError.forbidden('This trip is not assigned to you', 'NOT_YOUR_TRIP');
  }

  if (!TRACKABLE.has(booking.status)) {
    throw ApiError.badRequest(
      `Stops can only be marked while the trip is running (this one is ${booking.status}).`,
      'TRIP_NOT_RUNNING'
    );
  }
  return booking;
}

/**
 * Mark the driver as having reached stop `seq`.
 *
 * IDEMPOTENT. A retried request — a flaky connection, a double tap — keeps the
 * FIRST arrival time rather than overwriting it. The first tap is when the
 * driver actually got there; a later one only proves the request was sent
 * twice.
 */
async function arrive(bookingId, seq, driverId, { lat, lng } = {}) {
  const booking = await loadTrackable(bookingId, driverId);

  const planned = plannedStops(booking);
  if (seq < 0 || seq >= planned.length) {
    throw ApiError.badRequest(
      `This trip has ${planned.length} stop(s); there is no stop ${seq + 1}.`,
      'NO_SUCH_STOP'
    );
  }

  const existing = await prisma.bookingStop.findUnique({
    where: { bookingId_seq: { bookingId, seq } },
  });

  if (existing?.arrivedAt) {
    // Already recorded. Not an error — the driver is where they say they are.
    return listForBooking(bookingId);
  }

  await prisma.bookingStop.upsert({
    where: { bookingId_seq: { bookingId, seq } },
    create: {
      bookingId,
      seq,
      address: planned[seq].address,
      arrivedAt: new Date(),
      arrivedLat: lat ?? null,
      arrivedLng: lng ?? null,
    },
    update: {
      arrivedAt: new Date(),
      arrivedLat: lat ?? null,
      arrivedLng: lng ?? null,
    },
  });

  return listForBooking(bookingId);
}

/**
 * Mark the driver as having left stop `seq`.
 *
 * Out-of-order stops are ALLOWED. A driver who finds the second address closed
 * and doubles back is doing the trip the rider asked for, and refusing the
 * mark would only mean the record stops matching reality. The sequence is the
 * rider's preference, not a constraint on the road.
 *
 * Departing a stop never reached IS refused, because that is not a routing
 * decision — it is a missing record, and writing a departure without an
 * arrival makes the waiting time unanswerable.
 */
async function depart(bookingId, seq, driverId) {
  await loadTrackable(bookingId, driverId);

  const row = await prisma.bookingStop.findUnique({
    where: { bookingId_seq: { bookingId, seq } },
  });

  if (!row?.arrivedAt) {
    throw ApiError.badRequest(
      'Mark the stop as reached before leaving it.',
      'STOP_NOT_REACHED'
    );
  }
  if (row.departedAt) return listForBooking(bookingId); // idempotent

  await prisma.bookingStop.update({
    where: { bookingId_seq: { bookingId, seq } },
    data: { departedAt: new Date() },
  });

  return listForBooking(bookingId);
}

module.exports = {
  initialiseForTrip,
  listForBooking,
  arrive,
  depart,
  plannedStops,
};