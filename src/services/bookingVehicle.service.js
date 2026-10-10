'use strict';

/**
 * src/services/bookingVehicle.service.js
 *
 * Changing the CAR on an existing booking — the rider picked Sedan, ops needs
 * it to be an SUV.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A ONE-COLUMN UPDATE
 * ---------------------------------------------------------------------------
 * `vehicleClass` is an input to the fare, not a label on it. Writing the new
 * class straight onto the row would leave a booking that says SUV and is
 * priced as a Sedan — and because booking.service FREEZES the breakdown into
 * `fareBasis`, that lie would survive into the invoice, the settlement and any
 * dispute six months later. So a class change is a REPRICE: re-quote the same
 * trip for the new class, re-split the payment, and re-freeze the basis.
 *
 * Four things travel with the price and are handled here:
 *
 *   1. THE PROMO. The code was already redeemed against this booking. It is
 *      NOT re-evaluated (that would fail its own per-customer limit, which
 *      this very booking consumed) — the AMOUNT is recomputed against the new
 *      gross, because 10%-off a Sedan is not 10%-off an SUV.
 *
 *   2. THE MONEY ALREADY TAKEN. `advancePaid` is untouchable — it is in the
 *      bank. The new balance is `total - advancePaid`, floored at zero, which
 *      is exactly the arithmetic payment.service applies on capture. If the
 *      new fare is LOWER than what was paid, the surplus is reported as
 *      `refundDue` and nothing is auto-refunded: a refund is a money movement
 *      and belongs to the refund path, not to an edit.
 *
 *   3. THE ALLOCATED CAR. allocation.service refuses a vehicle whose class
 *      does not match the booking's. Changing the class under an active
 *      allocation would leave a Sedan assigned to an SUV booking that nothing
 *      could then reassign. So the caller must opt in with
 *      `releaseAllocation`, and the hold is released in the same transaction.
 *
 *   4. THE SURGE. The original multiplier is passed back in as the floor, so
 *      a rider who booked during a premium window is not quietly re-priced to
 *      today's calmer rate — and cannot be pushed above it either, since
 *      resolveSurge treats a request as a floor and the rate card clamps it.
 *
 * ---------------------------------------------------------------------------
 * WHEN IT IS REFUSED
 * ---------------------------------------------------------------------------
 *   • status past ALLOCATED — the car is already moving; that is a
 *     cancel-and-rebook, not an edit.
 *   • a LIVE payment order is open — the rider is on the gateway screen right
 *     now, about to pay an amount we are in the middle of changing.
 *   • the class has no rate card for this city/trip type — getQuote says so.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const quoteService = require('./quote.service');
const corporateService = require('./corporate.service');
const discountService = require('./discount.service');
const allocationService = require('./allocation.service');
const bookingService = require('./booking.service');
const audit = require('./audit.service');
const push = require('./push.service');
const M = require('../lib/money');
const { emit, EVENTS } = require('../lib/events');
const { BOOKING_SELECT } = require('../models/booking.model');

/**
 * Up to and including ALLOCATED. EN_ROUTE is deliberately excluded: pulling a
 * car that is already driving to the pickup means the rider is waiting for a
 * vehicle nobody has assigned yet, and the booking would have to move
 * BACKWARDS through a lifecycle that is forward-only by design.
 */
const CHANGEABLE_STATUSES = Object.freeze(['PENDING', 'CONFIRMED', 'ALLOCATED']);

/** A payment order the rider could be paying against at this moment. */
const LIVE_PAYMENT_STATUSES = Object.freeze(['CREATED', 'AUTHORISED', 'PARTIALLY_PAID']);

/** Everything the reprice needs, and nothing it does not. */
const REPRICE_SELECT = {
  id: true,
  bookingNumber: true,
  status: true,
  customerId: true,
  corporateAccountId: true,
  cityId: true,
  tripType: true,
  vehicleClass: true,
  pickupAddress: true,
  pickupLat: true,
  pickupLng: true,
  dropAddress: true,
  dropLat: true,
  dropLng: true,
  stops: true,
  pickupAt: true,
  returnAt: true,
  rentalPackageId: true,
  rentalHours: true,
  distanceKm: true,
  durationMinutes: true,
  estimatedFare: true,
  advancePaid: true,
  balanceDue: true,
  paymentMode: true,
  surgeMultiplier: true,
  fareBasis: true,
};

/* ------------------------------------------------------------------ *
 * Rebuilding the quote input from a stored booking
 * ------------------------------------------------------------------ */

/**
 * Turns a booking row back into the shape getQuote expects.
 *
 * COORDINATES, not addresses. The booking stores the formatted address the
 * geocoder produced at creation; feeding that text back in would re-geocode it
 * and could land on a slightly different point, so the trip would quietly
 * change length as a side effect of changing the car. The lat/lng are what the
 * original fare was computed against, so they are what this one uses too — the
 * address rides along only as a label for the state check.
 */
function quoteInputFor(booking, vehicleClass) {
  const stops = Array.isArray(booking.stops) ? booking.stops : [];

  return {
    cityId: booking.cityId,
    vehicleClass,
    tripType: booking.tripType,
    pickup: {
      lat: Number(booking.pickupLat),
      lng: Number(booking.pickupLng),
      address: booking.pickupAddress || undefined,
    },
    drop: {
      lat: Number(booking.dropLat),
      lng: Number(booking.dropLng),
      address: booking.dropAddress || undefined,
    },
    stops: stops
      .filter((s) => s && s.lat != null && s.lng != null)
      .map((s) => ({
        lat: Number(s.lat),
        lng: Number(s.lng),
        address: s.address || undefined,
      })),
    pickupAt: new Date(booking.pickupAt).toISOString(),
    returnAt: booking.returnAt ? new Date(booking.returnAt).toISOString() : null,
    // Waiting is not charged by the fare engine; kept explicit so the two
    // call sites read the same.
    waitingMinutes: 0,
    // A FLOOR, never a ceiling — see the header.
    surge: Number(booking.surgeMultiplier) || 1,
    rentalPackageId: booking.rentalPackageId || null,
    rentalHours: booking.rentalHours || null,
  };
}

async function loadForReprice(bookingId) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: REPRICE_SELECT,
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  return booking;
}

/* ------------------------------------------------------------------ *
 * What would each class cost?
 * ------------------------------------------------------------------ */

/**
 * Prices EVERY sellable class for this booking's exact trip, so the admin picks
 * from real numbers instead of changing the class and discovering the fare
 * afterwards.
 *
 * Reuses quoteAllClasses — the same function the rider's fare screen calls —
 * rather than looping getQuote. One distance lookup for the whole list, and the
 * two screens cannot drift apart.
 *
 * The totals here are GROSS (before this booking's promo). `currentTotal` is
 * what the booking actually stands at today, so the caller can show the
 * difference without doing the promo arithmetic itself.
 */
async function listOptions(bookingId) {
  const booking = await loadForReprice(bookingId);

  const input = quoteInputFor(booking, booking.vehicleClass);
  const fares = await quoteService.quoteAllClasses(input);

  // Names, seats and glyphs for the picker. The catalogue is what the business
  // sells; quoteAllClasses already filters to active rows, so this is a lookup,
  // not a second filter.
  const catalog = await prisma.vehicleCatalog.findMany({
    where: { key: { in: fares.options.map((o) => o.vehicleClass) } },
    select: { key: true, name: true, seats: true, luggage: true, glyph: true },
  });
  const byKey = new Map(catalog.map((c) => [c.key, c]));

  const currentTotal = M.round2(booking.estimatedFare);

  return {
    booking: {
      id: booking.id,
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      tripType: booking.tripType,
      vehicleClass: booking.vehicleClass,
      estimatedFare: M.toStr(currentTotal),
      advancePaid: M.toStr(M.round2(booking.advancePaid)),
      changeable: CHANGEABLE_STATUSES.includes(booking.status),
    },
    trip: fares.trip,
    options: fares.options.map((o) => {
      const gross = M.round2(o.total);
      const info = byKey.get(o.vehicleClass) || null;
      return {
        vehicleClass: o.vehicleClass,
        name: info?.name || o.vehicleClass,
        seats: info?.seats ?? null,
        luggage: info?.luggage ?? null,
        glyph: info?.glyph || null,
        current: o.vehicleClass === booking.vehicleClass,
        /** Rate-card total for this class, BEFORE this booking's promo. */
        total: M.toStr(gross),
        /** Signed, against the booking's current (net) total. Display only. */
        difference: M.toStr(M.sub(gross, currentTotal)),
        tax: o.tax || null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Change it
 * ------------------------------------------------------------------ */

/**
 * @param {string} bookingId
 * @param {object} payload
 * @param {string} payload.vehicleClass      the class to move to
 * @param {boolean} payload.releaseAllocation release an active hold whose
 *                                            vehicle no longer matches
 * @param {string}  payload.reason            why — goes on the audit entry
 * @param {object} actor  req.user
 * @param {object} meta   ip / userAgent / source
 */
async function changeVehicleClass(bookingId, payload, actor, meta = {}) {
  const nextClass = String(payload.vehicleClass || '').trim();
  if (!nextClass) {
    throw ApiError.badRequest('A vehicle class is required', 'VEHICLE_CLASS_REQUIRED');
  }

  const booking = await loadForReprice(bookingId);

  if (booking.vehicleClass === nextClass) {
    throw ApiError.badRequest(
      `This booking is already ${nextClass}`,
      'VEHICLE_CLASS_UNCHANGED',
    );
  }

  if (!CHANGEABLE_STATUSES.includes(booking.status)) {
    throw ApiError.conflict(
      `A ${booking.status} booking cannot change vehicle — cancel and rebook instead`,
      'BOOKING_NOT_CHANGEABLE',
    );
  }

  /*
   * A LIVE ORDER MEANS THE RIDER IS LOOKING AT AN AMOUNT RIGHT NOW.
   *
   * Repricing underneath an open gateway order would have them authorise one
   * figure against a booking that expects another, and the capture handler
   * would reconcile the difference silently. Refuse, and let the order settle
   * or lapse first.
   */
  const liveOrder = await prisma.payment.findFirst({
    where: {
      bookingId,
      status: { in: [...LIVE_PAYMENT_STATUSES] },
      purpose: { in: ['ADVANCE', 'BALANCE', 'FULL'] },
    },
    select: { id: true, purpose: true, status: true },
  });
  if (liveOrder) {
    throw ApiError.conflict(
      'A payment is in progress on this booking — let it settle before changing the vehicle',
      'PAYMENT_IN_PROGRESS',
    );
  }

  /* ---- the active hold, if any ---- */

  const allocation = await prisma.allocation.findFirst({
    where: { bookingId, status: 'ACTIVE' },
    select: {
      id: true,
      vehicleId: true,
      driverId: true,
      vehicle: { select: { id: true, registrationNumber: true, vehicleClass: true } },
    },
  });

  const allocationBlocks =
    allocation && allocation.vehicle && allocation.vehicle.vehicleClass !== nextClass;

  if (allocationBlocks && !payload.releaseAllocation) {
    throw ApiError.conflict(
      `${allocation.vehicle.registrationNumber || 'The assigned vehicle'} is ` +
        `${allocation.vehicle.vehicleClass}. Release it to change this booking to ${nextClass}.`,
      'ALLOCATED_VEHICLE_MISMATCH',
    );
  }

  /* ---- 1. reprice, SERVER SIDE, same trip, new class ---- */

  const quote = await quoteService.getQuote(quoteInputFor(booking, nextClass));

  /*
   * The same guard booking.service.create applies. A quote that answered with
   * a different PRODUCT (outstation collapsed to a local rental) must not be
   * written onto a booking the rider agreed as something else — changing the
   * car is not permission to change the trip type.
   */
  if (quote.switchedToLocal) {
    throw ApiError.conflict(
      quote.switchedToLocal.message,
      'SWITCH_TO_LOCAL_REQUIRED',
    );
  }

  const grossTotal = quote.quote.total;

  const previousBasis = booking.fareBasis && typeof booking.fareBasis === 'object'
    ? booking.fareBasis
    : {};

  const previousClass = booking.vehicleClass;
  const previousTotal = M.toStr(M.round2(booking.estimatedFare));
  const paid = M.round2(booking.advancePaid);

  /*
   * Declared out here, assigned inside the transaction.
   *
   * EVERYTHING FROM THE PROMO ONWARDS IS TRANSACTIONAL. The re-quote above is
   * the slow part — a maps lookup and a rate-card read — and holding a
   * transaction open across a network call is how connection pools die. But
   * the promo recompute WRITES (it updates the redemption row), so it cannot
   * sit outside: a transaction that then failed would leave a redemption
   * saying one amount and a fareBasis saying another, and the invoice would
   * pick whichever it happened to read. Quote outside, money inside.
   */
  let promo = null;
  let total = grossTotal;
  let balanceDue = M.dec(0);
  let refundDue = M.dec(0);

  /* ---- 2. write it, in ONE transaction ---- */

  const updated = await prisma.$transaction(async (tx) => {
    /* -- the promo, recomputed (not re-evaluated — see discount.service) -- */

    promo = await discountService.repriceRedemption(
      { bookingId, fareTotal: grossTotal },
      tx,
    );

    total = promo
      ? M.toStr(M.sub(M.dec(grossTotal), M.dec(promo.amount)))
      : grossTotal;

    const newTotal = M.round2(total);

    /*
     * advanceDue is FROZEN at what was actually paid once anything has been
     * paid. payment.service reads fareBasis.paymentSplit.advanceDue to size an
     * ADVANCE order; recomputing it upward on a booking whose advance is
     * already captured would make a second advance collectable for the same
     * trip. The whole increase belongs in the balance.
     */
    const split = M.gt(paid, M.dec(0))
      ? { advanceDue: paid, balanceDue: M.max(M.sub(newTotal, paid), M.dec(0)) }
      : bookingService.splitPayment(total, booking.paymentMode);

    /*
     * Mirrors payment.service's capture arithmetic exactly: outstanding is
     * total - paid, floored at zero. Floored because
     * chk_booking_amounts_non_negative forbids a negative, and because an
     * overpayment is a refund question, not a negative balance.
     */
    balanceDue = M.max(M.sub(newTotal, paid), M.dec(0));
    refundDue = M.max(M.sub(paid, newTotal), M.dec(0));

    /* -- corporate credit, on the INCREASE only -- */

    const increase = M.sub(newTotal, M.dec(previousTotal));
    if (booking.corporateAccountId && M.gt(increase, M.dec(0))) {
      await corporateService.assertCreditAvailable(
        booking.corporateAccountId,
        M.toStr(increase),
      );
    }

    /*
     * Released FIRST, inside the same transaction, so there is no instant at
     * which an active hold names a vehicle of the wrong class. If the write
     * below fails, the release rolls back with it and the car stays assigned.
     */
    if (allocationBlocks) {
      await allocationService.releaseVehicleForBooking(
        tx, bookingId, 'vehicle_class_changed', meta,
      );
    }

    /*
     * The status guard is in the WHERE clause, not only in the check above.
     * Between that read and this write a dispatcher may have started the trip;
     * a conditional update turns that race into zero rows instead of a
     * repriced booking that is already under way.
     */
    const moved = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: [...CHANGEABLE_STATUSES] } },
      data: {
        vehicleClass: nextClass,

        // Back to CONFIRMED when the car was let go — the booking is real and
        // agreed, it simply has no vehicle again.
        ...(allocationBlocks ? { status: 'CONFIRMED' } : {}),

        // The route itself did not change, but the re-quote is what the new
        // fare was computed from; storing its figures keeps the row and its
        // own frozen basis telling the same story.
        distanceKm: quote.trip.totalKm,
        durationMinutes: quote.trip.durationMin,

        estimatedFare: total,
        balanceDue: M.toStr(balanceDue),
        surgeMultiplier: quote.quote.meta.surgeMultiplier,

        /*
         * RE-FROZEN, with the old basis kept beside it.
         *
         * A frozen fare exists to answer "why this amount?" months later. A
         * repriced booking has two answers — what it was sold at and what it
         * became — and discarding the first would make the change itself
         * unexplainable. `repriceHistory` is append-only for that reason.
         */
        fareBasis: {
          quotedAt: new Date().toISOString(),
          total,
          components: quote.quote,
          routing: quote.routing,
          billing: previousBasis.billing || null,
          paymentSplit: {
            advanceDue: M.toStr(split.advanceDue),
            balanceDue: M.toStr(split.balanceDue),
          },
          discount: promo
            ? {
                discountId: promo.discountId,
                code: promo.code,
                description: promo.description,
                type: promo.type,
                amount: promo.amount,
                grossTotal,
              }
            : null,
          repriceHistory: [
            ...(Array.isArray(previousBasis.repriceHistory) ? previousBasis.repriceHistory : []),
            {
              at: new Date().toISOString(),
              by: actor?.id || null,
              reason: payload.reason || null,
              vehicleClass: { from: previousClass, to: nextClass },
              total: { from: previousTotal, to: total },
              previousBasis: {
                quotedAt: previousBasis.quotedAt || null,
                total: previousBasis.total || previousTotal,
                components: previousBasis.components || null,
                discount: previousBasis.discount || null,
              },
            },
          ],
        },
      },
    });

    if (moved.count === 0) {
      throw ApiError.conflict(
        'Booking changed state while the vehicle was being changed',
        'BOOKING_MOVED',
      );
    }

    await audit.record(tx, {
      actor,
      action: 'BOOKING_VEHICLE_CHANGED',
      entityType: 'booking',
      entityId: bookingId,
      before: {
        vehicleClass: previousClass,
        estimatedFare: previousTotal,
        status: booking.status,
      },
      after: {
        vehicleClass: nextClass,
        estimatedFare: total,
        status: allocationBlocks ? 'CONFIRMED' : booking.status,
        balanceDue: M.toStr(balanceDue),
        refundDue: M.toStr(refundDue),
        allocationReleased: !!allocationBlocks,
        reason: payload.reason || null,
      },
      meta,
    });

    return tx.booking.findUnique({ where: { id: bookingId }, select: BOOKING_SELECT });
  });

  /* ---- 6. tell everyone, outside the transaction ---- */

  emit(EVENTS.BOOKING_VEHICLE_CHANGED, {
    bookingId,
    bookingNumber: booking.bookingNumber,
    customerId: booking.customerId,
    from: previousClass,
    to: nextClass,
    previousTotal,
    total,
    balanceDue: M.toStr(balanceDue),
    refundDue: M.toStr(refundDue),
    allocationReleased: !!allocationBlocks,
  });

  /*
   * The rider is being charged a different amount for a car they did not pick.
   * They are told directly, not left to notice it on the payment screen.
   *
   * Fire-and-forget: a push failure must never undo a committed reprice.
   */
  push
    .pushToUser(booking.customerId, {
      title: 'Your vehicle has been changed',
      body:
        `${booking.bookingNumber}: now ${nextClass}. ` +
        `Fare is now ₹${M.toStr(M.round2(total))}` +
        (Number(balanceDue) > 0 ? `, ₹${M.toStr(balanceDue)} due.` : '.'),
      data: { type: 'BOOKING_VEHICLE_CHANGED', bookingId, vehicleClass: nextClass },
    })
    .catch((err) => console.error(`[booking] vehicle-change push failed: ${err.message}`));

  return {
    booking: updated,
    change: {
      vehicleClass: { from: previousClass, to: nextClass },
      total: { from: previousTotal, to: total, difference: M.toStr(M.sub(M.round2(total), M.dec(previousTotal))) },
      grossTotal,
      discount: promo ? { code: promo.code, amount: promo.amount } : null,
      advancePaid: M.toStr(paid),
      balanceDue: M.toStr(balanceDue),
      /**
       * Non-zero when the new fare is below what has already been collected.
       * Nothing is refunded here — this is the figure the refund path needs.
       */
      refundDue: M.toStr(refundDue),
      allocationReleased: !!allocationBlocks,
      releasedVehicle: allocationBlocks
        ? {
            vehicleId: allocation.vehicleId,
            registrationNumber: allocation.vehicle?.registrationNumber || null,
            vehicleClass: allocation.vehicle?.vehicleClass || null,
          }
        : null,
    },
  };
}

module.exports = {
  listOptions,
  changeVehicleClass,
  CHANGEABLE_STATUSES,
};