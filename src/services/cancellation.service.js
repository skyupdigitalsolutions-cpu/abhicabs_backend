'use strict';

/**
 * src/services/cancellation.service.js
 *
 * Cancellation, the fee, and the refund.
 *
 * ---------------------------------------------------------------------------
 * ABHICABS POLICY — CONFIRMED
 * ---------------------------------------------------------------------------
 *   30 minutes or more before pickup   FREE, full refund of any advance
 *   less than 30 minutes               full cancellation fee from the rate card
 *   after the scheduled pickup time    full cancellation fee
 *   once the trip is ONGOING           cannot be cancelled at all
 *
 * A trip already in progress is not a cancellation, it is an early completion —
 * a different operation with a different fare, and Day 11 handles it.
 *
 * ---------------------------------------------------------------------------
 * REFUND RULE — CONFIRMED
 * ---------------------------------------------------------------------------
 * Any advance already paid is kept UP TO the fee, and the remainder refunded:
 *
 *     retained    = min(advancePaid, fee)
 *     refund      = advancePaid - retained
 *     outstanding = fee - retained          (still owed if the advance was small)
 *
 * This is cleaner than refunding in full and invoicing the fee separately: it
 * settles in one movement, and the customer sees one number rather than a
 * credit followed by a bill.
 *
 * The system NEVER cancels a booking by itself. Every cancellation records who
 * did it.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const M = require('../lib/money');
const audit = require('./audit.service');
const fareService = require('./fare.service');
const corporateService = require('./corporate.service');
const { emit, EVENTS } = require('../lib/events');
const { BOOKING_SELECT } = require('../models/booking.model');

/** Statuses a booking may be cancelled from. ONGOING is deliberately absent. */
const CANCELLABLE = ['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE'];

const FREE_MINUTES = Number(process.env.CANCEL_FREE_MINUTES || 30);

/* ------------------------------------------------------------------ *
 * Quote a cancellation without performing it
 * ------------------------------------------------------------------ */

/**
 * "What would it cost me to cancel right now?"
 *
 * The app shows this before asking the customer to confirm, so nobody discovers
 * a fee only after the booking is already gone.
 */
async function quoteCancellation(bookingId, actor) {
  const booking = await loadCancellable(bookingId, actor, { allowTerminal: true });

  const config = await prisma.fareConfig.findFirst({
    where: {
      cityId: booking.cityId,
      vehicleClass: booking.vehicleClass,
      tripType: booking.tripType,
      isActive: true,
    },
  });

  const assessment = assess(booking, config);

  return {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    cancellable: CANCELLABLE.includes(booking.status),
    ...assessment,
    policy: policyText(config),
  };
}

/* ------------------------------------------------------------------ *
 * Fee and refund arithmetic
 * ------------------------------------------------------------------ */

/**
 * Pure: given a booking and its rate card, what is owed and what comes back.
 * No database, no clock beyond `now`, so it is directly testable.
 */
function assess(booking, config, now = new Date()) {
  // FREE_MINUTES is passed as BOTH thresholds so the engine collapses to two
  // bands, matching the confirmed policy: free at 30+, full fee under 30.
  const band = fareService.computeCancellationFee({
    pickupAt: booking.pickupAt,
    now,
    fareTotal: booking.estimatedFare,
    config,
    freeCancellationMinutes: FREE_MINUTES,
    shortNoticeMinutes: FREE_MINUTES,
  });

  const fee = M.round2(band.fee);
  const advance = M.round2(booking.advancePaid || 0);

  // Keep the advance up to the fee; refund whatever is left over.
  const retained = M.min(advance, fee);
  const refund = M.sub(advance, retained);
  const outstanding = M.sub(fee, retained);

  return {
    fee: M.toStr(fee),
    band: band.band,
    minutesToPickup: band.minutesToPickup,
    reason: band.reason,
    advancePaid: M.toStr(advance),
    retainedFromAdvance: M.toStr(retained),
    refundAmount: M.toStr(refund),
    // Non-zero when the fee exceeds what was paid up front — for a ZERO-payment
    // booking cancelled late, this is the whole fee and must still be collected.
    outstandingAmount: M.toStr(outstanding),
    settlement: describeSettlement(refund, outstanding),
  };
}

function describeSettlement(refund, outstanding) {
  if (M.isPositive(refund)) return `Rs ${M.toStr(refund)} will be refunded`;
  if (M.isPositive(outstanding)) return `Rs ${M.toStr(outstanding)} remains payable`;
  return 'Nothing to refund or collect';
}

/* ------------------------------------------------------------------ *
 * Perform the cancellation
 * ------------------------------------------------------------------ */

/**
 * @param {string} bookingId
 * @param {object} actor          req.user
 * @param {object} body           { reason, cancelledByType }
 * @param {object} meta           ip, userAgent
 */
async function cancel(bookingId, actor, body = {}, meta = {}) {
  const booking = await loadCancellable(bookingId, actor);

  const config = await prisma.fareConfig.findFirst({
    where: {
      cityId: booking.cityId,
      vehicleClass: booking.vehicleClass,
      tripType: booking.tripType,
      isActive: true,
    },
  });

  const assessment = assess(booking, config);

  // Who cancelled. A customer cannot claim it was the driver or the system —
  // that field feeds cancellation reporting and, later, driver ratings.
  const cancelledByType =
    actor.role === 'USER' ? 'CUSTOMER' : (body.cancelledByType || 'ADMIN');

  const updated = await prisma.$transaction(async (tx) => {
    // The same guarded conditional update used by every other transition. A
    // booking that moved to ONGOING between our read and this write affects
    // zero rows and is refused.
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: CANCELLABLE } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancelledByType,
        cancellationReason: body.reason || null,
        cancellationFee: assessment.fee,
        refundAmount: assessment.refundAmount,
        balanceDue: assessment.outstandingAmount,
      },
    });

    if (count === 0) {
      const current = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      });
      if (!current) throw ApiError.notFound('Booking not found');
      throw ApiError.conflict(
        current.status === 'CANCELLED'
          ? 'Booking is already cancelled'
          : `A ${current.status} booking cannot be cancelled`,
        'NOT_CANCELLABLE'
      );
    }

    // Release corporate credit that this booking had consumed. Uses an atomic
    // decrement, not read-modify-write, so concurrent bookings cannot lose one
    // another's adjustment.
    if (booking.corporateAccountId) {
      const consumed = Number(booking.estimatedFare) - Number(assessment.fee);
      if (consumed > 0) {
        await corporateService.adjustCreditUsed(
          booking.corporateAccountId,
          -consumed,
          tx
        );
      }
    }

    await audit.record(tx, {
      actor,
      action: 'BOOKING_CANCELLED',
      entityType: 'booking',
      entityId: bookingId,
      before: { status: booking.status },
      after: {
        status: 'CANCELLED',
        cancelledByType,
        fee: assessment.fee,
        refund: assessment.refundAmount,
        band: assessment.band,
        reason: body.reason || null,
      },
      meta,
    });

    return tx.booking.findUnique({ where: { id: bookingId }, select: BOOKING_SELECT });
  });

  // Day 7 turns this into an actual gateway refund; Day 9 releases the vehicle;
  // Day 10 notifies the customer. Emitting rather than calling keeps this
  // service unaware of all three.
  emit(EVENTS.BOOKING_CANCELLED, {
    bookingId: updated.id,
    bookingNumber: updated.bookingNumber,
    customerId: updated.customerId,
    cancelledByType,
    fee: assessment.fee,
    refundAmount: assessment.refundAmount,
    outstandingAmount: assessment.outstandingAmount,
    previousStatus: booking.status,
  });

  return { booking: updated, cancellation: assessment };
}

/* ------------------------------------------------------------------ *
 * Loading with ownership scoping
 * ------------------------------------------------------------------ */

async function loadCancellable(bookingId, actor, { allowTerminal = false } = {}) {
  const where = { id: bookingId };

  // Scoped in the query, so another customer's booking simply is not found.
  if (actor.role === 'USER') where.customerId = actor.id;

  const booking = await prisma.booking.findFirst({
    where,
    select: {
      id: true,
      bookingNumber: true,
      customerId: true,
      corporateAccountId: true,
      cityId: true,
      vehicleClass: true,
      tripType: true,
      status: true,
      pickupAt: true,
      estimatedFare: true,
      advancePaid: true,
      paymentMode: true,
    },
  });

  if (!booking) throw ApiError.notFound('Booking not found');

  if (!allowTerminal && !CANCELLABLE.includes(booking.status)) {
    throw ApiError.conflict(
      booking.status === 'ONGOING'
        ? 'A trip that has already started cannot be cancelled'
        : `A ${booking.status} booking cannot be cancelled`,
      'NOT_CANCELLABLE'
    );
  }

  return booking;
}

/* ------------------------------------------------------------------ *
 * Policy text
 * ------------------------------------------------------------------ */

/**
 * Shown at confirmation and sent with the booking notification.
 *
 * Generated from the same configuration the fee calculation uses, so the text a
 * customer was shown can never drift from the amount actually charged. Writing
 * it as a constant string is how that drift happens.
 */
function policyText(config) {
  const fee = M.toStr(config?.cancellationFee ?? 0);

  return {
    summary: `Free cancellation up to ${FREE_MINUTES} minutes before pickup. After that a Rs ${fee} fee applies.`,
    bands: [
      {
        window: `${FREE_MINUTES} minutes or more before pickup`,
        fee: '0.00',
        note: 'Any advance paid is refunded in full',
      },
      {
        window: `Less than ${FREE_MINUTES} minutes before pickup`,
        fee,
        note: 'The vehicle is already committed',
      },
      {
        window: 'After the scheduled pickup time',
        fee,
        note: 'Counts as a no-show',
      },
    ],
    rules: [
      'A trip that has already started cannot be cancelled.',
      'Any advance paid is kept up to the fee; the remainder is refunded.',
      'If the fee exceeds the advance paid, the difference remains payable.',
      'Bookings are never cancelled automatically — only you or our team can cancel.',
    ],
  };
}

/** Standalone policy for the terms screen, before any booking exists. */
async function getPolicy({ cityId, vehicleClass, tripType }) {
  const config = await prisma.fareConfig.findFirst({
    where: { cityId: Number(cityId), vehicleClass, tripType, isActive: true },
  });

  if (!config) {
    throw ApiError.notFound('No fare configuration for that city and vehicle class');
  }

  return { cityId: Number(cityId), vehicleClass, tripType, ...policyText(config) };
}

module.exports = {
  CANCELLABLE,
  FREE_MINUTES,
  quoteCancellation,
  cancel,
  assess,
  policyText,
  getPolicy,
};