'use strict';

/**
 * src/services/allocation.service.js   — Day 9
 *
 * Binds a vehicle (and optionally a driver) to a booking for a time window.
 *
 * ---------------------------------------------------------------------------
 * THE ONE IDEA THAT MAKES THIS CORRECT UNDER CONCURRENCY
 * ---------------------------------------------------------------------------
 * We do NOT check "is this vehicle free?" and then insert. That is a race: ten
 * dispatchers all read "free", all insert, all succeed, and one vehicle is
 * committed to ten trips.
 *
 * Instead we just INSERT the allocation and let the database referee. Day 1
 * created a GiST EXCLUDE constraint (excl_allocation_vehicle_overlap) that
 * forbids two ACTIVE allocations for the same vehicle whose time windows
 * intersect. Postgres serialises the concurrent inserts: exactly one commits,
 * the rest raise 23P01. We catch that and return a clean 409.
 *
 * So "exactly one winner out of N" is not something this code arranges with
 * locks or careful ordering — it is a property of the constraint. This service
 * only has to (a) compute the right window, (b) attempt the insert, and
 * (c) translate the database's refusal into an HTTP answer. That is the whole
 * trick behind the Day 9 done-line.
 */

const { prisma, isUniqueViolation, isExclusionViolation } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const env = require('../config/env');
const audit = require('./audit.service');
const { emit, EVENTS } = require('../lib/events');
const cache = require('./cache.service');

const {
  ALLOCATION_SELECT,
  computeHoldWindow,
  ASSIGNABLE_BOOKING_STATUSES,
} = require('../models/allocation.model');

/* ------------------------------------------------------------------ *
 * Core: allocate a specific vehicle to a booking
 * ------------------------------------------------------------------ */

/**
 * Attempts to hold `vehicleId` (and optionally `driverId`) for `bookingId`.
 *
 * Returns the created allocation on success. Throws:
 *   409 VEHICLE_UNAVAILABLE  — the vehicle already has an overlapping hold
 *   409 DRIVER_UNAVAILABLE   — the driver already has an overlapping hold
 *   409 ALREADY_ALLOCATED    — the booking already has an active allocation
 *   409 BOOKING_NOT_ASSIGNABLE — booking is not in a state that can be allocated
 *
 * The vehicle/driver/booking checks that happen BEFORE the insert are for a
 * helpful early error only; they are NOT what guarantees correctness. The
 * insert and its constraint are. Two callers that both pass the pre-checks
 * still cannot both succeed — the second insert loses at the database.
 */
async function allocate(bookingId, { vehicleId, driverId = null }, actor = null, meta = {}) {
  if (!vehicleId) throw ApiError.badRequest('vehicleId is required', 'VEHICLE_REQUIRED');

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      vehicleClass: true,
      cityId: true,
      tripType: true,
      pickupAt: true,
      returnAt: true,
      durationMinutes: true,
      bookingNumber: true,
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  if (!ASSIGNABLE_BOOKING_STATUSES.includes(booking.status)) {
    throw ApiError.conflict(
      `A ${booking.status} booking cannot be allocated`,
      'BOOKING_NOT_ASSIGNABLE'
    );
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { id: true, vehicleClass: true, cityId: true, status: true, isActive: true },
  });
  if (!vehicle) throw ApiError.notFound('Vehicle not found');

  // Class match is a business rule, not a safety one — a sedan booking must not
  // be served by a hatchback. Checked up front so the caller gets a clear
  // reason rather than a successful-but-wrong assignment.
  if (vehicle.vehicleClass !== booking.vehicleClass) {
    throw ApiError.conflict(
      `Vehicle is ${vehicle.vehicleClass}, booking needs ${booking.vehicleClass}`,
      'VEHICLE_CLASS_MISMATCH'
    );
  }
  if (!vehicle.isActive || vehicle.status === 'MAINTENANCE' || vehicle.status === 'INACTIVE') {
    throw ApiError.conflict('Vehicle is not in service', 'VEHICLE_OUT_OF_SERVICE');
  }

  const window = computeHoldWindow(booking, {
    bufferMinutes: env.dispatch.holdBufferMinutes,
    defaultTripMinutes: env.dispatch.defaultTripMinutes,
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // THE decisive write. If a concurrent attempt already holds this vehicle
      // for an overlapping window, this insert raises 23P01 and the whole
      // transaction rolls back — the booking is NOT moved, no partial state.
      const allocation = await tx.allocation.create({
        data: {
          bookingId,
          vehicleId,
          driverId,
          status: 'ACTIVE',
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          assignedById: actor?.id || null,
        },
        select: ALLOCATION_SELECT,
      });

      // Move the booking forward and mark the vehicle assigned, in the same tx.
      // Conditional update on status keeps the booking transition race-free too.
      const moved = await tx.booking.updateMany({
        where: { id: bookingId, status: { in: ASSIGNABLE_BOOKING_STATUSES } },
        data: { status: 'ALLOCATED' },
      });
      if (moved.count === 0) {
        // Someone completed/cancelled the booking between our read and here.
        // Abort so we never leave an allocation attached to a dead booking.
        throw ApiError.conflict('Booking changed state during allocation', 'BOOKING_MOVED');
      }

      await tx.vehicle.update({
        where: { id: vehicleId },
        data: { status: 'ASSIGNED' },
      });

      await audit.record(tx, {
        actor,
        action: 'ALLOCATION_CREATED',
        entityType: 'allocation',
        entityId: allocation.id,
        after: {
          bookingId,
          vehicleId,
          driverId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        },
        meta,
      });

      return allocation;
    });

    // Day 14: the fleet-availability list just changed (a vehicle went
    // ASSIGNED). Invalidate it so the dispatch board does not show a car that is
    // now taken. After-commit + fire-and-forget: a cache miss is harmless, and a
    // failed invalidation must never fail the allocation.
    cache.delByPrefix(cache.keys.vehiclesAvailablePrefix()).catch(() => {});

    return result;
  } catch (err) {
    // Translate the database's refusals into clean, specific 409s. This is the
    // "7 clean rejections" half of the done-line.
    if (isExclusionViolation(err, 'excl_allocation_vehicle_overlap')) {
      throw ApiError.conflict('Vehicle is already committed for this window', 'VEHICLE_UNAVAILABLE');
    }
    if (isExclusionViolation(err, 'excl_allocation_driver_overlap')) {
      throw ApiError.conflict('Driver is already committed for this window', 'DRIVER_UNAVAILABLE');
    }
    // Some drivers of pg surface the constraint name only generically; fall back
    // to a vehicle-unavailable answer for any remaining exclusion violation.
    if (isExclusionViolation(err)) {
      throw ApiError.conflict('Resource is already committed for this window', 'RESOURCE_UNAVAILABLE');
    }
    if (isUniqueViolation(err)) {
      // uq_allocation_active_booking — the booking already has an active hold.
      throw ApiError.conflict('Booking already has an active allocation', 'ALREADY_ALLOCATED');
    }
    throw err;
  } finally {
    // Emitted outside the tx; a listener must never roll back an allocation.
    // (No-op if the tx threw — emit only reached on success below.)
  }
}

/* ------------------------------------------------------------------ *
 * Manual assign (thin wrapper that emits)
 * ------------------------------------------------------------------ */

/**
 * The ONLY way a booking gets a car. A dispatcher names the vehicle and driver.
 *
 * ---------------------------------------------------------------------------
 * ASSIGNMENT IS FINAL — THERE IS NO OFFER
 * ---------------------------------------------------------------------------
 * The allocation is marked accepted at the moment it is created. The driver is
 * told which trip is theirs; they are not asked.
 *
 * `acceptedAt` is stamped rather than dropped so that every downstream reader —
 * the dispatch board, the audit trail, historical allocations — keeps the shape
 * it already had, and so an allocation made today still reads the same as one
 * made before the offer flow was removed. It now records WHEN DISPATCH COMMITTED
 * the car, not when a driver agreed.
 *
 * The consequence to be awake to: a driver who is asleep, off shift or out of
 * signal no longer surfaces themselves by letting an offer lapse. The timeout
 * sweep that used to release those holds is gone with the offer, so nothing
 * self-corrects. A bad assignment stays on the board until a human reassigns it.
 */
async function assignManually(bookingId, payload, actor = null, meta = {}) {
  const allocation = await allocate(bookingId, payload, actor, meta);

  // Stamped after the insert rather than inside allocate(), so the exclusion
  // constraint still referees the insert exactly as before — the concurrency
  // guarantee this service is built on is untouched by the offer removal.
  const accepted = await prisma.allocation.update({
    where: { id: allocation.id },
    data: { acceptedAt: new Date() },
    select: ALLOCATION_SELECT,
  });

  emit(EVENTS.ALLOCATION_MADE, {
    bookingId,
    allocationId: allocation.id,
    vehicleId: payload.vehicleId,
    driverId: payload.driverId || null,
    auto: false,
  });

  return accepted;
}

/* ------------------------------------------------------------------ *
 * Release
 * ------------------------------------------------------------------ */

async function releaseInTx(tx, alloc, reason, meta = {}) {
  // RELEASED allocations are excluded from the overlap constraint (it filters on
  // status = 'ACTIVE'), so this frees the window immediately.
  await tx.allocation.update({
    where: { id: alloc.id },
    data: { status: 'RELEASED', releasedAt: new Date(), declinedAt: reason === 'declined' ? new Date() : undefined },
  });
  await tx.vehicle.update({
    where: { id: alloc.vehicleId },
    data: { status: 'AVAILABLE' },
  });
  // Pull the booking back so it can be dispatched again.
  await tx.booking.updateMany({
    where: { id: alloc.bookingId, status: 'ALLOCATED' },
    data: { status: 'CONFIRMED' },
  });
}

/**
 * Releases the ACTIVE allocation (if any) tied to a booking, without changing
 * the booking's own status — the caller (completeTrip / cancel) is already
 * writing the terminal booking status in the same transaction, so this only
 * frees the vehicle side.
 *
 * This is what a completed/cancelled trip needs: otherwise the allocation stays
 * ACTIVE and the vehicle stays ASSIGNED forever, so the next booking of that
 * class can never be allocated (NO_VEHICLE_AVAILABLE / ALLOCATION_CONTENDED).
 * Safe to call on a booking with no allocation — then it is a no-op.
 */
async function releaseVehicleForBooking(tx, bookingId, reason, meta = {}) {
  const alloc = await tx.allocation.findFirst({
    where: { bookingId, status: 'ACTIVE' },
    select: { id: true, vehicleId: true, driverId: true },
  });
  if (!alloc) return null;

  await tx.allocation.update({
    where: { id: alloc.id },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });
  await tx.vehicle.update({
    where: { id: alloc.vehicleId },
    data: { status: 'AVAILABLE' },
  });
  await audit.record(tx, {
    actor: null,
    action: 'ALLOCATION_RELEASED',
    entityType: 'allocation',
    entityId: alloc.id,
    after: { bookingId, reason },
    meta,
  });

  return alloc;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

async function getForBooking(bookingId) {
  return prisma.allocation.findFirst({
    where: { bookingId, status: 'ACTIVE' },
    select: ALLOCATION_SELECT,
  });
}

/**
 * Reassign an already-allocated booking to a different vehicle (and optionally
 * driver). Releases the current allocation, holds the new vehicle, and records
 * an audit entry with before/after + who/when. The DB exclusion constraint still
 * referees vehicle/driver overlap, so a reassignment can't double-book a car.
 *
 * Allowed only while the booking is ALLOCATED or EN_ROUTE (before the customer
 * has boarded). The booking's own status is left unchanged — this swaps the
 * assignment under it, it does not move it backward.
 */
const REASSIGNABLE_STATUSES = ['ALLOCATED', 'EN_ROUTE'];

async function reassign(bookingId, { vehicleId, driverId = null }, actor = null, meta = {}) {
  if (!vehicleId) throw ApiError.badRequest('vehicleId is required', 'VEHICLE_REQUIRED');

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, status: true, vehicleClass: true, cityId: true, tripType: true,
      pickupAt: true, returnAt: true, durationMinutes: true, bookingNumber: true,
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!REASSIGNABLE_STATUSES.includes(booking.status)) {
    throw ApiError.conflict(`A ${booking.status} booking cannot be reassigned`, 'BOOKING_NOT_REASSIGNABLE');
  }

  const current = await prisma.allocation.findFirst({
    where: { bookingId, status: 'ACTIVE' },
    select: { id: true, vehicleId: true, driverId: true },
  });
  if (!current) throw ApiError.conflict('Booking has no active allocation to reassign', 'NO_ACTIVE_ALLOCATION');

  if (current.vehicleId === vehicleId && (current.driverId || null) === (driverId || null)) {
    throw ApiError.conflict('That vehicle/driver is already assigned', 'NO_CHANGE');
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { id: true, vehicleClass: true, status: true, isActive: true },
  });
  if (!vehicle) throw ApiError.notFound('Vehicle not found');
  if (vehicle.vehicleClass !== booking.vehicleClass) {
    throw ApiError.conflict(
      `Vehicle is ${vehicle.vehicleClass}, booking needs ${booking.vehicleClass}`,
      'VEHICLE_CLASS_MISMATCH'
    );
  }
  if (!vehicle.isActive || vehicle.status === 'MAINTENANCE' || vehicle.status === 'INACTIVE') {
    throw ApiError.conflict('Vehicle is not in service', 'VEHICLE_OUT_OF_SERVICE');
  }

  const window = computeHoldWindow(booking, {
    bufferMinutes: env.dispatch.holdBufferMinutes,
    defaultTripMinutes: env.dispatch.defaultTripMinutes,
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Release the current allocation and free its vehicle (unless we're
      // keeping the same vehicle and only changing the driver).
      await tx.allocation.update({
        where: { id: current.id },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (current.vehicleId !== vehicleId) {
        await tx.vehicle.update({ where: { id: current.vehicleId }, data: { status: 'AVAILABLE' } });
      }

      // Hold the new vehicle. The exclusion constraint fires here if it's taken.
      const allocation = await tx.allocation.create({
        data: {
          bookingId, vehicleId, driverId, status: 'ACTIVE',
          startsAt: window.startsAt, endsAt: window.endsAt,
          assignedById: actor?.id || null,
        },
        select: ALLOCATION_SELECT,
      });
      await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'ASSIGNED' } });

      await audit.record(tx, {
        actor,
        action: 'ALLOCATION_REASSIGNED',
        entityType: 'allocation',
        entityId: allocation.id,
        before: {
          allocationId: current.id,
          vehicleId: current.vehicleId,
          driverId: current.driverId,
        },
        after: {
          bookingId,
          vehicleId,
          driverId,
          reassignedAt: new Date().toISOString(),
          reassignedBy: actor?.id || null,
        },
        meta,
      });

      return allocation;
    });

    cache.delByPrefix(cache.keys.vehiclesAvailablePrefix()).catch(() => {});
    return result;
  } catch (err) {
    if (isExclusionViolation(err, 'excl_allocation_vehicle_overlap')) {
      throw ApiError.conflict('Vehicle is already committed for this window', 'VEHICLE_UNAVAILABLE');
    }
    if (isExclusionViolation(err, 'excl_allocation_driver_overlap')) {
      throw ApiError.conflict('Driver is already committed for this window', 'DRIVER_UNAVAILABLE');
    }
    throw err;
  }
}

module.exports = {
  allocate,
  assignManually,
  reassign,
  releaseVehicleForBooking,
  getForBooking,
};