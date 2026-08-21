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
const tripService = require('./trip.service');
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
  COMPLETED: {
    from: ['ONGOING'],
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
 * ONGOING -> COMPLETED.
 *
 * `finalFare` is captured here. Until Day 11 measures actual distance it equals
 * the estimate, but the column is separate from `estimatedFare` on purpose: the
 * quote and the charge are different facts, and conflating them would make a
 * dispute impossible to answer.
 */
async function completeTrip(bookingId, actor, meta, { finalFare = null, odometerKm = null, lat = null, lng = null } = {}) {
  const existing = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { estimatedFare: true, advancePaid: true },
  });
  if (!existing) throw ApiError.notFound('Booking not found');

  const settled = finalFare ?? existing.estimatedFare.toString();
  const balance = Number(settled) - Number(existing.advancePaid);

  const booking = await transition(bookingId, 'COMPLETED', actor, {
    meta,
    extraData: {
      finalFare: settled,
      balanceDue: balance > 0 ? balance.toFixed(2) : '0.00',
    },
    // Invoice + balanced ledger set, atomic with the COMPLETED write.
    hook: (tx) => billing.finaliseBooking(tx, bookingId, actor, meta),
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
  completeTrip,
  expire,
  availableActions,
  explainRejection,
};