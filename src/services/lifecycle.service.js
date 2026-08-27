'use strict';

/**
 * src/services/lifecycle.service.js
 *
 * The booking status machine.
 *
 * ---------------------------------------------------------------------------
 * EVERY TRANSITION IS A CONDITIONAL UPDATE
 * ---------------------------------------------------------------------------
 * The naive implementation reads the booking, checks its status, then writes:
 *
 *     const b = await findBooking(id);
 *     if (b.status !== 'CONFIRMED') throw ...;     // <-- gap
 *     await update(id, { status: 'ALLOCATED' });
 *
 * Two ops staff clicking Allocate at the same instant both read CONFIRMED, both
 * pass the check, and both write. The second silently overwrites the first, and
 * two allocations exist for one booking.
 *
 * Instead every transition is ONE statement that names the expected current
 * status in its WHERE clause:
 *
 *     UPDATE bookings SET status = 'ALLOCATED'
 *      WHERE id = ? AND status = 'CONFIRMED'
 *
 * The database serialises it. The winner affects one row; the loser affects
 * ZERO. Checking the affected-row count is what turns "probably fine" into a
 * guarantee — and it is the reason every function here inspects `count`.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const audit = require('./audit.service');
const { emit, EVENTS } = require('../lib/events');
const billing = require('./billing.service');
const allocationService = require('./allocation.service');
const tripService = require('./trip.service');
const fare = require('./fare.service');
const M = require('../lib/money');
const { BOOKING_SELECT, STATUS_FLOW, ACTIVE_STATUSES } = require('../models/booking.model');

/* ------------------------------------------------------------------ *
 * Transition table
 * ------------------------------------------------------------------ */

/**
 * Which statuses may precede each target, plus the timestamp column that
 * transition stamps and who is allowed to perform it.
 *
 * Keeping this as data rather than a chain of if-statements means the rules can
 * be read in one place, and a new status is a table entry rather than a hunt
 * through controllers.
 */
const TRANSITIONS = Object.freeze({
  CONFIRMED: {
    from: ['PENDING'],
    stamp: 'confirmedAt',
    permission: 'BOOKING_MANAGE',
    event: EVENTS.BOOKING_CONFIRMED,
    label: 'confirmed',
  },
  ALLOCATED: {
    from: ['CONFIRMED'],
    stamp: null,                    // Day 9 writes the allocation row itself
    permission: 'DISPATCH_MANAGE',
    event: EVENTS.ALLOCATION_MADE,
    label: 'allocated a vehicle',
  },
  EN_ROUTE: {
    from: ['ALLOCATED'],
    stamp: null,
    permission: 'DISPATCH_MANAGE',
    allowDriver: true,              // the driver marks themselves en route
    label: 'marked en route',
  },
  ONGOING: {
    from: ['EN_ROUTE'],
    stamp: 'startedAt',
    permission: 'DISPATCH_MANAGE',
    allowDriver: true,
    label: 'started',
  },
  ARRIVED: {
    from: ['ONGOING'],
    stamp: 'arrivedAt',
    permission: 'DISPATCH_MANAGE',
    allowDriver: true,              // the driver marks arrival at the destination
    label: 'arrived at the destination',
  },
  COMPLETED: {
    from: ['ARRIVED'],              // only after arrival (and payment) can it finalise
    stamp: 'completedAt',
    permission: 'DISPATCH_MANAGE',
    allowDriver: true,
    label: 'completed',
  },
  EXPIRED: {
    from: ['PENDING'],
    stamp: null,
    permission: 'BOOKING_MANAGE',
    label: 'expired',
  },
});

/** Human-readable reason a transition is not allowed. */
function explainRejection(current, target) {
  if (current === target) {
    return `Booking is already ${target}`;
  }
  if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(current)) {
    return `Booking is ${current} and cannot change status`;
  }
  const allowed = STATUS_FLOW[current] || [];
  if (!allowed.includes(target)) {
    return allowed.length
      ? `A ${current} booking can only move to ${allowed.join(' or ')}`
      : `A ${current} booking cannot change status`;
  }
  return `Booking is no longer ${target === 'CONFIRMED' ? 'PENDING' : 'in the expected state'}`;
}

/* ------------------------------------------------------------------ *
 * The core transition
 * ------------------------------------------------------------------ */

/**
 * Moves a booking to `target`, but only if it is currently in an allowed
 * preceding status.
 *
 * @param {string} bookingId
 * @param {string} target      a key of TRANSITIONS
 * @param {object} actor       req.user
 * @param {object} opts        extraData, meta, reason
 */
async function transition(bookingId, target, actor, opts = {}) {
  const rule = TRANSITIONS[target];
  if (!rule) throw new Error(`[lifecycle] Unknown target status: ${target}`);

  const { extraData = {}, meta = {}, reason = null, hook = null } = opts;

  return prisma.$transaction(async (tx) => {
    // ONE statement that both checks and writes. `from` is a list because some
    // targets are reachable from more than one status.
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: rule.from } },
      data: {
        status: target,
        ...(rule.stamp ? { [rule.stamp]: new Date() } : {}),
        ...extraData,
      },
    });

    if (count === 0) {
      // Zero rows means either the booking does not exist or it was not in an
      // allowed status. Re-read ONLY to produce a precise message — the
      // decision has already been made by the database.
      const current = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { id: true, status: true, bookingNumber: true },
      });

      if (!current) throw ApiError.notFound('Booking not found');

      throw ApiError.conflict(
        explainRejection(current.status, target),
        'INVALID_STATUS_TRANSITION'
      );
    }

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: BOOKING_SELECT,
    });

    await audit.record(tx, {
      actor,
      action: `BOOKING_${target}`,
      entityType: 'booking',
      entityId: bookingId,
      before: { status: rule.from.join('|') },
      after: { status: target, ...(reason ? { reason } : {}) },
      meta,
    });

    // Optional post-transition work that MUST commit atomically with the status
    // change — e.g. Day 8 invoice + ledger generation on COMPLETED. Runs inside
    // this same transaction, so a booking is never COMPLETED without its books.
    if (typeof hook === 'function') {
      await hook(tx, booking);
    }

    return booking;
  });
}

/* ------------------------------------------------------------------ *
 * Named transitions
 * ------------------------------------------------------------------ */

/**
 * PENDING -> CONFIRMED.
 *
 * On Day 7 this becomes the callback from a successful payment rather than a
 * manual action. The guard is identical either way.
 */
async function confirm(bookingId, actor, meta) {
  const booking = await transition(bookingId, 'CONFIRMED', actor, { meta });

  emit(EVENTS.BOOKING_CONFIRMED, {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    customerId: booking.customerId,
    pickupAt: booking.pickupAt,
  });

  return booking;
}

async function markAllocated(bookingId, actor, meta) {
  return transition(bookingId, 'ALLOCATED', actor, { meta });
}

async function markEnRoute(bookingId, actor, meta) {
  return transition(bookingId, 'EN_ROUTE', actor, { meta });
}

async function startTrip(bookingId, actor, meta, { lat = null, lng = null, odometerKm = null } = {}) {
  const booking = await transition(bookingId, 'ONGOING', actor, { meta });

  // Day 11: one durable TripEvent marking where the trip began. This is a
  // single write at a lifecycle boundary — not part of the GPS ping firehose.
  try {
    await tripService.recordStart(bookingId, { lat, lng, odometerKm });
  } catch (err) {
    console.error('[trip] failed to record start:', err.message);
  }

  emit(EVENTS.BOOKING_STATUS_CHANGED, {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: 'ONGOING',
  });

  return booking;
}

/**
 * ONGOING -> ARRIVED.
 *
 * The driver has reached the destination. The trip is not COMPLETED yet: this
 * is the point at which the rider is asked to pay. completeTrip() will refuse
 * to finalise until the balance is settled (see the payment gate there), so
 * ARRIVED is a real waiting state, not a cosmetic label.
 */
async function markArrived(bookingId, actor, meta, { lat = null, lng = null } = {}) {
  const booking = await transition(bookingId, 'ARRIVED', actor, { meta });

  emit(EVENTS.BOOKING_STATUS_CHANGED, {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: 'ARRIVED',
  });

  return booking;
}

/**
 * ONGOING -> COMPLETED.
 *
 * `finalFare` is captured here. Until Day 11 measures actual distance it equals
 * the estimate, but the column is separate from `estimatedFare` on purpose: the
 * quote and the charge are different facts, and conflating them would make a
 * dispute impossible to answer.
 */
/**
 * Reconcile a trip against the distance ACTUALLY travelled.
 *
 * The assigned driver (or ops) reports the real distance at trip end. If it
 * exceeds the distance the fare was quoted on, the surplus km are charged at the
 * booking's FROZEN per-km rate (see fare.computeExtraDistanceCharge) and the
 * final fare is raised by that surcharge. The breakdown is stored on
 * `booking.meta.extraDistance` so the invoice can show it as its own line.
 *
 * This does NOT complete the trip — it records the distance and updates the
 * payable amount. Completion (which finalises the invoice) reads the stored
 * surcharge. Call this before completeTrip, or pass actualKm to completeTrip
 * which calls this for you.
 *
 * Idempotent: re-reporting the same actualKm recomputes from the ORIGINAL quoted
 * distance (not the already-inflated fare), so it never compounds.
 */
async function recordTripDistance(bookingId, actor, meta, { actualKm, odometerKm = null } = {}) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, status: true, estimatedFare: true, advancePaid: true,
      distanceKm: true, fareBasis: true, meta: true,
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  // The distance the fare was quoted on. The quote is nested under
  // fareBasis.components (see booking.service.js). computeExtraDistanceCharge
  // also resolves this, but we compute a sensible fallback here too.
  const quote = (booking.fareBasis && booking.fareBasis.components) || booking.fareBasis || {};
  const quotedKm =
    (quote.meta && quote.meta.actualKm != null ? quote.meta.actualKm : null) ??
    booking.distanceKm ??
    0;

  const calc = fare.computeExtraDistanceCharge({
    fareBasis: booking.fareBasis,
    quotedKm,
    actualKm,
  });

  // Base fare = the original estimate. Extra charge is always computed from the
  // ORIGINAL quoted distance, so re-reporting is idempotent (never compounds).
  const baseFare = M.dec(booking.estimatedFare);
  const newFinal = M.round2(M.add(baseFare, M.dec(calc.extraCharge)));
  const balance = M.round2(M.sub(newFinal, M.dec(booking.advancePaid)));

  const extraDistanceMeta = calc.hasExtra
    ? {
        quotedKm: calc.quotedKm,
        actualKm: calc.actualKm,
        extraKm: calc.extraKm,
        perKm: calc.perKm,
        extraCharge: calc.extraCharge,
        odometerKm: odometerKm ?? null,
        recordedAt: new Date().toISOString(),
        recordedById: actor?.id ?? null,
      }
    : null;

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      finalFare: newFinal.toFixed(2),
      balanceDue: (balance.greaterThan(0) ? balance : M.dec(0)).toFixed(2),
      meta: {
        ...(booking.meta && typeof booking.meta === 'object' ? booking.meta : {}),
        // Store (or clear) the extra-distance breadcrumb the invoice reads.
        ...(extraDistanceMeta ? { extraDistance: extraDistanceMeta } : { extraDistance: null }),
      },
    },
    select: { id: true, finalFare: true, balanceDue: true, meta: true },
  });

  audit.recordAsync({
    actor,
    action: 'TRIP_DISTANCE_RECORDED',
    entityType: 'booking',
    entityId: bookingId,
    after: {
      actualKm: calc.actualKm,
      quotedKm: calc.quotedKm,
      extraKm: calc.extraKm,
      extraCharge: calc.extraCharge,
      finalFare: updated.finalFare.toString(),
    },
    meta,
  });

  return { booking: updated, extra: calc };
}

/**
 * Assert that `userId` is the driver actively allocated to this booking. Used to
 * scope the driver-facing distance endpoint: a driver may only reconcile a trip
 * they actually drove. Ops/admin bypass this via the permissioned admin route.
 */
async function assertAssignedDriver(bookingId, userId) {
  const allocation = await prisma.allocation.findFirst({
    where: { bookingId, driverId: userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!allocation) {
    throw ApiError.forbidden(
      'You are not the assigned driver for this trip.',
      'NOT_ASSIGNED_DRIVER'
    );
  }
}

/**
 * Driver-facing wrapper: verify the caller is the assigned driver, that the trip
 * is in a state where distance can be recorded (ONGOING or just COMPLETED), then
 * reconcile the distance.
 */
async function recordTripDistanceAsDriver(bookingId, driverUser, meta, payload) {
  await assertAssignedDriver(bookingId, driverUser.id);

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { status: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!['ONGOING', 'COMPLETED'].includes(booking.status)) {
    throw ApiError.badRequest(
      'Distance can only be recorded once the trip is underway.',
      'INVALID_STATE_FOR_DISTANCE'
    );
  }

  return recordTripDistance(bookingId, driverUser, meta, payload);
}

async function completeTrip(bookingId, actor, meta, { finalFare = null, odometerKm = null, actualKm = null, lat = null, lng = null } = {}) {
  // If the caller reported an actual distance, reconcile the fare FIRST so the
  // surcharge is baked into finalFare before the invoice is finalised.
  if (actualKm != null) {
    await recordTripDistance(bookingId, actor, meta, { actualKm, odometerKm });
  }

  const existing = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { estimatedFare: true, finalFare: true, advancePaid: true, paymentMode: true },
  });
  if (!existing) throw ApiError.notFound('Booking not found');

  // finalFare precedence: explicit arg > a finalFare already set (e.g. by the
  // distance reconciliation above) > the original estimate.
  const settled =
    finalFare ??
    (existing.finalFare != null ? existing.finalFare.toString() : existing.estimatedFare.toString());
  const balance = Number(settled) - Number(existing.advancePaid);

  // ---------------------------------------------------------------------------
  // PAYMENT GATE
  // ---------------------------------------------------------------------------
  // A trip cannot be finalised while money is still owed on it, UNLESS the
  // booking is explicitly a pay-after-ride / cash booking (paymentMode ZERO),
  // where collection happens off-app. For every other mode the rider must have
  // paid at the ARRIVED step first. This is what makes ARRIVED a genuine gate
  // rather than a label: complete is refused with a clear, actionable error the
  // app can turn into a "Pay ₹X to finish" prompt.
  const PAY_LATER = existing.paymentMode === 'ZERO';
  if (!PAY_LATER && balance > 0.009) {
    throw ApiError.conflict(
      `Outstanding balance of ₹${balance.toFixed(2)} must be paid before the trip can be completed`,
      'PAYMENT_REQUIRED'
    );
  }

  const booking = await transition(bookingId, 'COMPLETED', actor, {
    meta,
    extraData: {
      finalFare: settled,
      balanceDue: balance > 0 ? balance.toFixed(2) : '0.00',
    },
    // Invoice + balanced ledger set AND vehicle release, atomic with the
    // COMPLETED write — the vehicle returns to the pool the instant the trip is
    // finalised rather than staying held forever.
    hook: async (tx) => {
      await billing.finaliseBooking(tx, bookingId, actor, meta);
      await allocationService.releaseVehicleForBooking(tx, bookingId, 'completed', meta);
    },
  });

  // Day 11: one durable TripEvent marking the trip end. Lifecycle-boundary
  // write, not part of the ping firehose.
  try {
    await tripService.recordEnd(bookingId, { lat, lng, odometerKm });
  } catch (err) {
    console.error('[trip] failed to record end:', err.message);
  }

  emit(EVENTS.BOOKING_STATUS_CHANGED, {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: 'COMPLETED',
    finalFare: settled,
  });

  return booking;
}

/**
 * PENDING -> EXPIRED.
 *
 * For the Day 12 sweeper: an unpaid booking whose pickup time has passed is
 * dead, but it is NOT a cancellation — nobody chose to cancel it, so no
 * cancellation fee applies and it should not appear in cancellation reporting.
 */
async function expire(bookingId, actor, meta) {
  return transition(bookingId, 'EXPIRED', actor, {
    meta,
    reason: 'Pickup time passed without confirmation',
  });
}

/* ------------------------------------------------------------------ *
 * Introspection
 * ------------------------------------------------------------------ */

/**
 * What can happen to this booking next, and who may do it.
 *
 * Lets the app and dispatch console render only the buttons that would actually
 * work, instead of showing an action that returns 409 when pressed.
 */
async function availableActions(bookingId, actor) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true, customerId: true, pickupAt: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  if (actor.role === 'USER' && booking.customerId !== actor.id) {
    throw ApiError.notFound('Booking not found');
  }

  const next = STATUS_FLOW[booking.status] || [];
  const actions = next
    .filter((s) => s !== 'CANCELLED')
    .map((s) => ({
      status: s,
      label: TRANSITIONS[s]?.label || s.toLowerCase(),
      permission: TRANSITIONS[s]?.permission || null,
      availableToDriver: !!TRANSITIONS[s]?.allowDriver,
    }));

  return {
    bookingId: booking.id,
    currentStatus: booking.status,
    isActive: ACTIVE_STATUSES.includes(booking.status),
    isTerminal: next.length === 0,
    // Cancellation is deliberately separate: it is not a normal forward step,
    // it carries a fee, and it is available from several statuses at once.
    canCancel: ['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE'].includes(booking.status),
    nextStatuses: actions,
  };
}

module.exports = {
  TRANSITIONS,
  transition,
  confirm,
  markAllocated,
  markEnRoute,
  startTrip,
  markArrived,
  completeTrip,
  recordTripDistance,
  recordTripDistanceAsDriver,
  expire,
  availableActions,
  explainRejection,
};