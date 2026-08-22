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
 * Rule-assisted auto-assign
 * ------------------------------------------------------------------ */

/**
 * Picks a vehicle for a booking by rule — matching class, in the same city,
 * in service, and with NO overlapping active hold — then allocates it.
 *
 * The candidate query is a hint, not a guarantee: between choosing a vehicle
 * and inserting, another attempt may take it. That is fine — allocate() will
 * lose at the constraint and we move to the next candidate. We try candidates
 * in turn until one sticks or we run out.
 */
async function autoAssign(bookingId, actor = null, meta = {}) {
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
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!ASSIGNABLE_BOOKING_STATUSES.includes(booking.status)) {
    throw ApiError.conflict(
      `A ${booking.status} booking cannot be allocated`,
      'BOOKING_NOT_ASSIGNABLE'
    );
  }

  const window = computeHoldWindow(booking, {
    bufferMinutes: env.dispatch.holdBufferMinutes,
    defaultTripMinutes: env.dispatch.defaultTripMinutes,
  });

  // Candidate vehicles: right class, right city, in service, and free across
  // the window (no ACTIVE allocation that intersects it). The NOT EXISTS is the
  // round-trip hold in action — a vehicle committed for an overlapping journey
  // is excluded from the candidate list.
  const candidates = await prisma.$queryRaw`
    SELECT v.id
    FROM "vehicles" v
    WHERE v."vehicle_class" = ${booking.vehicleClass}
      AND v."city_id" = ${booking.cityId}
      AND v."is_active" = TRUE
      AND v."status" NOT IN ('MAINTENANCE', 'INACTIVE')
      AND NOT EXISTS (
        SELECT 1 FROM "allocations" a
        WHERE a."vehicle_id" = v.id
          AND a."status" = 'ACTIVE'
          AND tsrange(a."starts_at", a."ends_at", '[)')
              && tsrange(${window.startsAt}::timestamp, ${window.endsAt}::timestamp, '[)')
      )
    ORDER BY v."odometer_km" ASC
    LIMIT 5
  `;

  if (!candidates.length) {
    throw ApiError.conflict(
      'No available vehicle of the required class for this window',
      'NO_VEHICLE_AVAILABLE'
    );
  }

  let lastErr = null;
  for (const { id: vehicleId } of candidates) {
    try {
      const allocation = await allocate(bookingId, { vehicleId }, actor, meta);
      emit(EVENTS.ALLOCATION_MADE, {
        bookingId,
        allocationId: allocation.id,
        vehicleId,
        auto: true,
      });
      return allocation;
    } catch (err) {
      // A candidate got taken by a concurrent attempt between query and insert.
      // Try the next one rather than failing the whole request.
      if (
        isExclusionViolation(err) ||
        err.code === 'VEHICLE_UNAVAILABLE' ||
        err.errorCode === 'VEHICLE_UNAVAILABLE'
      ) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw ApiError.conflict(
    'All candidate vehicles were taken concurrently; retry',
    'ALLOCATION_CONTENDED'
  );
}

/* ------------------------------------------------------------------ *
 * Manual assign (thin wrapper that emits)
 * ------------------------------------------------------------------ */

async function assignManually(bookingId, payload, actor = null, meta = {}) {
  const allocation = await allocate(bookingId, payload, actor, meta);
  emit(EVENTS.ALLOCATION_MADE, {
    bookingId,
    allocationId: allocation.id,
    vehicleId: payload.vehicleId,
    driverId: payload.driverId || null,
    auto: false,
  });
  return allocation;
}

/* ------------------------------------------------------------------ *
 * Driver accept / decline
 * ------------------------------------------------------------------ */

/**
 * Driver accepts the offer. Conditional update: only an ACTIVE, not-yet-accepted
 * allocation for THIS driver can be accepted, so a stale or reassigned offer is
 * a clean no-op rather than a wrongful accept.
 */
async function accept(allocationId, driverUserId, meta = {}) {
  const { count } = await prisma.allocation.updateMany({
    where: { id: allocationId, driverId: driverUserId, status: 'ACTIVE', acceptedAt: null },
    data: { acceptedAt: new Date() },
  });
  if (count === 0) {
    throw ApiError.conflict('Offer is no longer available to accept', 'OFFER_NOT_ACCEPTABLE');
  }
  return prisma.allocation.findUnique({ where: { id: allocationId }, select: ALLOCATION_SELECT });
}

/**
 * Driver declines. Releases the hold so the booking can be reallocated: the
 * allocation goes RELEASED (which drops out of the EXCLUDE constraint, freeing
 * the vehicle window), the vehicle returns to AVAILABLE, and the booking is
 * pulled back to CONFIRMED for another dispatch attempt.
 */
async function decline(allocationId, driverUserId, meta = {}) {
  return prisma.$transaction(async (tx) => {
    const alloc = await tx.allocation.findUnique({
      where: { id: allocationId },
      select: { id: true, driverId: true, status: true, bookingId: true, vehicleId: true },
    });
    if (!alloc) throw ApiError.notFound('Allocation not found');
    if (alloc.driverId !== driverUserId) {
      throw ApiError.forbidden('Not your allocation', 'NOT_YOUR_OFFER');
    }
    if (alloc.status !== 'ACTIVE') {
      throw ApiError.conflict('Offer is no longer active', 'OFFER_NOT_ACTIVE');
    }

    await releaseInTx(tx, alloc, 'declined', meta);
    // Day 14: a vehicle returned to AVAILABLE — refresh the fleet list.
    cache.delByPrefix(cache.keys.vehiclesAvailablePrefix()).catch(() => {});
    return { released: true, bookingId: alloc.bookingId };
  });
}

/* ------------------------------------------------------------------ *
 * Release (decline / timeout / manual) + timeout sweep
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
 * Releases allocations that were offered to a driver but not accepted within the
 * timeout. Intended to be called by the Day 12 sweeper; exposed now so it can be
 * triggered manually in testing.
 */
async function expireStaleOffers(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.dispatch.offerTimeoutMinutes * 60000);

  const stale = await prisma.allocation.findMany({
    where: { status: 'ACTIVE', acceptedAt: null, driverId: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, bookingId: true, vehicleId: true },
  });

  let released = 0;
  for (const alloc of stale) {
    await prisma.$transaction((tx) => releaseInTx(tx, alloc, 'timeout')).then(() => {
      released += 1;
    }).catch(() => {});
  }
  return { released, scanned: stale.length };
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

module.exports = {
  allocate,
  autoAssign,
  assignManually,
  accept,
  decline,
  expireStaleOffers,
  getForBooking,
};