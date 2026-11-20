'use strict';

/**
 * src/services/cancellation.service.js
 *
 * Cancellation, the fee, and the refund.
 *
 * ---------------------------------------------------------------------------
 * ABHICABS POLICY — CONFIRMED
 * ---------------------------------------------------------------------------
 *   60 minutes or more before pickup   FREE, full refund of any advance
 *   less than 60 minutes               full cancellation fee from the rate card
 *   after the scheduled pickup time    full cancellation fee
 *   once the trip is ONGOING           cannot be cancelled at all
 *
 * ---------------------------------------------------------------------------
 * HIGH-VALUE BOOKINGS GO THROUGH SUPPORT
 * ---------------------------------------------------------------------------
 * Above a configured fare — Rs 10,000 by default — the rider cannot cancel
 * from the app. They are asked to call support, who cancel it for them.
 *
 * The reason is commercial, not technical. A large booking is usually a coach
 * or a multi-day run: the vehicle has been held out of the pool for days, a
 * driver has been committed, and a tap in a phone app is a very cheap way to
 * destroy an expensive arrangement. Putting a person in the loop buys the
 * chance to move the date instead of losing the trip, and to apply the fee
 * with some judgement rather than arithmetic.
 *
 * Two things about how this is enforced matter:
 *
 *   It is enforced HERE, not in the app. Hiding a button stops an honest
 *   rider and nobody else; the endpoint is public and reachable with curl.
 *   The app's own check exists to show the right screen without a round
 *   trip, and is not what makes the rule true.
 *
 *   It applies to CUSTOMERS ONLY. Support cancelling on the rider's behalf is
 *   the entire point of the rule, so an admin actor passes straight through.
 *   Gating everyone would leave an expensive booking that literally nobody
 *   could cancel.
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
/*
 * The rate card that applies is no longer "the row with this cityId".
 *
 * A city may be priced by its own card or by its state's, and the three
 * lookups in this file each used to run their own query that knew nothing
 * about the second case — and had already drifted in a smaller way, omitting
 * the `effectiveFrom <= now` filter, so a price rise staged for next month was
 * quoting next month's cancellation fee today. All three now go through the
 * one resolver.
 */
const fareLookup = require('./fareLookup.service');
const corporateService = require('./corporate.service');
const allocationService = require('./allocation.service');
const discountService = require('./discount.service');
const { emit, EVENTS } = require('../lib/events');
const { BOOKING_SELECT } = require('../models/booking.model');

/** Statuses a booking may be cancelled from. ONGOING is deliberately absent. */
const CANCELLABLE = ['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE'];

/**
 * How long before pickup a cancellation is still free.
 *
 * One hour. A driver is typically allocated and heading out well inside that
 * window, so a cancellation after it has already cost someone a trip — which is
 * the thing the fee exists to cover.
 *
 * Overridable per environment rather than hardcoded: the number is a commercial
 * decision, and changing it should not need a deploy. Whatever it is set to
 * flows through the quote, the charge, and the policy text the app displays, so
 * those three can never disagree.
 */
const FREE_MINUTES = Number(process.env.CANCEL_FREE_MINUTES || 60);

/**
 * The most a booking can be worth and still be cancellable from the app.
 *
 * Above this the rider is routed to support. Read from the environment for the
 * same reason as FREE_MINUTES: it is a commercial number, the client will want
 * to move it, and moving it should not be a deploy.
 *
 * Set it to 0 to disable the rule entirely and let every booking self-cancel.
 */
const SELF_SERVICE_MAX = Number(process.env.CANCEL_SELF_SERVICE_MAX || 10000);

/**
 * Where to send a rider who cannot cancel themselves.
 *
 * Sent in the error body rather than hardcoded in the app, so the number can be
 * changed without an app release — and so the rider is never told to contact
 * support without being told how.
 */
const SUPPORT = {
  phone: process.env.SUPPORT_PHONE || '+918096000182',
  email: process.env.SUPPORT_EMAIL || 'contact@abhicab.com',
  hours: process.env.SUPPORT_HOURS || '24x7',
};

/**
 * What the booking is worth, for the purpose of this rule.
 *
 * finalFare when it exists, estimatedFare otherwise. A booking repriced upward
 * past the threshold — a vehicle swapped for a larger one, stops added — should
 * start needing support from that moment, and reading only the estimate would
 * leave it self-cancellable at its original quote forever.
 */
function fareValue(booking) {
  const value = booking.finalFare ?? booking.estimatedFare;
  return Number(value || 0);
}

/**
 * Must this cancellation go through a human?
 *
 * Only ever true for a customer. See the header: admins are the escape hatch
 * this rule depends on.
 */
function needsSupport(booking, actor) {
  if (!SELF_SERVICE_MAX) return false;
  if (!actor || actor.role !== 'USER') return false;
  return fareValue(booking) > SELF_SERVICE_MAX;
}

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

  const config = await fareLookup.findActiveCard({
    cityId: booking.cityId,
    vehicleClass: booking.vehicleClass,
    tripType: booking.tripType,
  });

  const assessment = assess(booking, config);

  /*
   * Reported, not thrown. The quote is the screen that EXPLAINS the situation,
   * so it has to be able to describe a booking the rider cannot cancel — and
   * it still shows what the fee would be, because "call support" is a much
   * easier call to make when you already know the number.
   */
  const requiresSupport = needsSupport(booking, actor);

  return {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    cancellable: CANCELLABLE.includes(booking.status) && !requiresSupport,
    requiresSupport,
    selfServiceMaxFare: SELF_SERVICE_MAX ? String(SELF_SERVICE_MAX) : null,
    bookingValue: String(fareValue(booking)),
    support: requiresSupport ? SUPPORT : undefined,
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
  // bands, matching the confirmed policy: free at or above it, full fee below.
  const band = fareService.computeCancellationFee({
    pickupAt: booking.pickupAt,
    now,
    fareTotal: booking.estimatedFare,
    config,
    freeCancellationMinutes: FREE_MINUTES,
    shortNoticeMinutes: FREE_MINUTES,
  });

  /*
   * An UNCONFIRMED booking cancels free, at any time.
   *
   * Every booking now waits in PENDING until an admin confirms it, and that
   * wait can run close to pickup. Until confirmation the company has promised
   * nothing, so a fee would charge the rider for a trip nobody agreed to run
   * — and when the ADMIN declines a booking by cancelling it, the rider would
   * be fined for the company's own refusal. Full refund of anything paid.
   */
  const unconfirmed = booking.status === 'PENDING';
  const fee = unconfirmed ? M.dec(0) : M.round2(band.fee);
  const advance = M.round2(booking.advancePaid || 0);

  // Keep the advance up to the fee; refund whatever is left over.
  const retained = M.min(advance, fee);
  const refund = M.sub(advance, retained);
  const outstanding = M.sub(fee, retained);

  return {
    fee: M.toStr(fee),
    band: unconfirmed ? 'UNCONFIRMED' : band.band,
    minutesToPickup: band.minutesToPickup,
    reason: unconfirmed ? 'Booking not yet confirmed — free cancellation' : band.reason,
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

  /*
   * The high-value gate, before any work is done.
   *
   * Placed after loadCancellable rather than inside it so the 404-for-someone
   * else's-booking check still runs first — otherwise the error would tell a
   * stranger that a booking exists and roughly what it is worth.
   *
   * The details block is what lets the app put a phone number on screen
   * instead of a dead end.
   */
  if (needsSupport(booking, actor)) {
    throw new ApiError(
      409,
      'CANCEL_REQUIRES_SUPPORT',
      `Bookings above Rs ${SELF_SERVICE_MAX} are cancelled by our team. ` +
        `Please call ${SUPPORT.phone} and we will take care of it.`,
      {
        bookingNumber: booking.bookingNumber,
        bookingValue: String(fareValue(booking)),
        selfServiceMaxFare: String(SELF_SERVICE_MAX),
        support: SUPPORT,
      }
    );
  }

  const config = await fareLookup.findActiveCard({
    cityId: booking.cityId,
    vehicleClass: booking.vehicleClass,
    tripType: booking.tripType,
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

    // Free the vehicle immediately — a cancelled booking must not keep holding
    // a vehicle out of the pool. No-op if it never got an allocation.
    await allocationService.releaseVehicleForBooking(tx, bookingId, 'cancelled', meta);

    // Give the promo use back. A rider who cancels and rebooks should not find
    // their code "already used" on a trip that never happened. No-op when the
    // booking had no promo. Same transaction, so a cancel that rolls back
    // does not hand out a free use.
    await discountService.release(tx, bookingId);

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
      finalFare: true,
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
      ...(SELF_SERVICE_MAX
        ? [
            `Bookings above Rs ${SELF_SERVICE_MAX} are cancelled by our team — ` +
              `call ${SUPPORT.phone} and we will arrange it.`,
          ]
        : []),
    ],
  };
}

/** Standalone policy for the terms screen, before any booking exists. */
async function getPolicy({ cityId, vehicleClass, tripType }) {
  const config = await fareLookup.findActiveCard({
    cityId: Number(cityId),
    vehicleClass,
    tripType,
  });

  if (!config) {
    throw ApiError.notFound('No fare configuration for that city and vehicle class');
  }

  return { cityId: Number(cityId), vehicleClass, tripType, ...policyText(config) };
}

module.exports = {
  CANCELLABLE,
  FREE_MINUTES,
  SELF_SERVICE_MAX,
  SUPPORT,
  needsSupport,
  fareValue,
  quoteCancellation,
  cancel,
  assess,
  policyText,
  getPolicy,
};