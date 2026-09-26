'use strict';

/**
 * src/services/booking.service.js
 *
 * The booking engine. The most business-critical service in the platform.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF OPERATIONS — AND WHY IT IS THIS ORDER
 * ---------------------------------------------------------------------------
 *
 *   1. Claim the idempotency key      BEFORE any work, so a retry cannot duplicate
 *   2. Log the attempt                BEFORE validation, so failures are visible
 *   3. Validate the request           customer, city, trip type, timing
 *   4. Price it server-side           the client never sends an amount
 *   5. Check corporate credit         if billed to a company
 *   6. Create the booking             in one transaction, fare frozen
 *   7. Record the response            so the retry replays it
 *   8. Emit booking.attempted         Day 10 turns this into an admin alert
 *
 * Steps 1 and 2 are the ones people get wrong. Both must happen before anything
 * that can reject the request.
 */

const { prisma } = require('../config/prisma');
const tripOtp = require('./tripOtp.service');
const { ApiError, paginated } = require('../utils/helpers');
const quoteService = require('./quote.service');
const customerService = require('./customer.service');
const corporateService = require('./corporate.service');
const audit = require('./audit.service');
const funnel = require('./funnel.service');
const discountService = require('./discount.service');
const M = require('../lib/money');
const { emit, EVENTS } = require('../lib/events');
const { BOOKING_SELECT, BOOKING_LIST_SELECT } = require('../models/booking.model');

/* ------------------------------------------------------------------ *
 * Booking number
 * ------------------------------------------------------------------ */

/**
 * Human-readable reference: ABH-2026-001042
 *
 * Uses the Postgres sequence created on Day 1, NOT a row count. Two concurrent
 * bookings counting rows would both read the same number and collide; a
 * sequence is atomic and never hands out the same value twice.
 */
async function nextBookingNumber(tx) {
  const [{ nextval }] = await tx.$queryRaw`SELECT nextval('booking_number_seq') AS nextval`;
  const year = new Date().getFullYear();
  return `ABH-${year}-${String(nextval).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Attempt logging
 * ------------------------------------------------------------------ */

/**
 * Writes the attempt row. Called BEFORE validation.
 *
 * The client asked to be notified of every booking initiation — including the
 * ones that fail. If this were written after validation, the attempts that
 * failed validation would never be recorded, and those are exactly the ones ops
 * needs to see: the customer who tried to book outside the service area, or
 * whose payment fell over.
 *
 * Never throws. A failure to log an attempt must not block a real booking.
 */
async function logAttempt(input, meta, outcome = 'PENDING', failureReason = null) {
  try {
    const attempt = await prisma.bookingAttempt.create({
      data: {
        customerId: input.customerId || null,
        tripType: input.tripType || null,
        vehicleClass: input.vehicleClass || null,
        pickupAddress: input.pickupAddress || null,
        dropAddress: input.dropAddress || null,
        pickupAt: input.pickupAt ? new Date(input.pickupAt) : null,
        estimatedFare: input.estimatedFare ?? null,
        outcome,
        failureReason: failureReason ? String(failureReason).slice(0, 255) : null,
        source: (meta.source || 'unknown').slice(0, 24),
        ip: (meta.ip || '').slice(0, 45) || null,
        userAgent: (meta.userAgent || '').slice(0, 255) || null,
        payload: input.rawPayload || {},
      },
    });

    // Day 10 turns this into a dispatch-console alert and an admin notification.
    emit(EVENTS.BOOKING_ATTEMPTED, {
      attemptId: attempt.id,
      customerId: attempt.customerId,
      outcome,
      failureReason,
      pickupAddress: attempt.pickupAddress,
      dropAddress: attempt.dropAddress,
      tripType: attempt.tripType,
    });

    return attempt;
  } catch (err) {
    console.error('[booking] failed to log attempt:', err.message);
    return null;
  }
}

/** Updates an attempt once the outcome is known. Never throws. */
async function settleAttempt(attemptId, { outcome, bookingId = null, failureReason = null, estimatedFare = null }) {
  if (!attemptId) return;
  try {
    await prisma.bookingAttempt.update({
      where: { id: attemptId },
      data: {
        outcome,
        bookingId,
        failureReason: failureReason ? String(failureReason).slice(0, 255) : null,
        ...(estimatedFare !== null ? { estimatedFare } : {}),
      },
    });
  } catch (err) {
    console.error('[booking] failed to settle attempt:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Payment split
 * ------------------------------------------------------------------ */

/**
 * Splits the fare into what is collected now and what is owed later.
 *
 *   ZERO    — pay the driver at the end (cash / pay later)
 *   PARTIAL — an advance now, the balance at or after the trip
 *   FULL    — the whole fare now
 *
 * The PARTIAL amount is a business decision ABHICABS has not settled. It reads
 * from env so it can be changed without a deploy, and the default is a
 * percentage rather than a flat figure because a flat advance makes no sense
 * across a Rs 800 local trip and a Rs 20,000 outstation booking.
 */
const PARTIAL_PCT = Number(process.env.PARTIAL_PAYMENT_PCT || 50);

function splitPayment(total, paymentMode) {
  const fare = M.dec(total);

  if (paymentMode === 'FULL') {
    return { advanceDue: M.round2(fare), balanceDue: M.dec(0) };
  }
  if (paymentMode === 'PARTIAL') {
    const advance = M.round2(M.pct(fare, PARTIAL_PCT));
    // Subtract rather than compute both, so the two parts always sum exactly
    // to the total and no rupee is created or lost to rounding.
    return { advanceDue: advance, balanceDue: M.round2(M.sub(fare, advance)) };
  }
  return { advanceDue: M.dec(0), balanceDue: M.round2(fare) }; // ZERO
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const MIN_LEAD_MINUTES = Number(process.env.BOOKING_MIN_LEAD_MINUTES || 15);
const MAX_ADVANCE_DAYS = Number(process.env.BOOKING_MAX_ADVANCE_DAYS || 90);

function validateTiming({ pickupAt, returnAt, tripType, scheduled }) {
  const now = Date.now();
  const pickup = new Date(pickupAt).getTime();

  if (!Number.isFinite(pickup)) {
    throw ApiError.badRequest('Invalid pickup time', 'INVALID_PICKUP_TIME');
  }

  // Checked FIRST, for scheduled and immediate bookings alike.
  //
  // This used to live in the `else` branch below, which meant a SCHEDULED
  // pickup dated in the past produced a hugely negative lead time and tripped
  // INSUFFICIENT_LEAD_TIME instead — telling a customer that their 2020 date
  // "needs 15 minutes' notice". A pickup in the past is a different mistake
  // from one booked with too little notice, and the client has to tell them
  // apart to route the user to the right correction.
  //
  // The 5-minute grace absorbs clock skew between a phone and the server.
  if (pickup < now - 5 * 60000) {
    throw ApiError.badRequest('Pickup time is in the past', 'PICKUP_IN_PAST');
  }

  // A scheduled pickup needs enough lead time for a vehicle to reach it.
  if (scheduled) {
    const leadMinutes = (pickup - now) / 60000;
    if (leadMinutes < MIN_LEAD_MINUTES) {
      throw ApiError.badRequest(
        `Scheduled pickups need at least ${MIN_LEAD_MINUTES} minutes' notice`,
        'INSUFFICIENT_LEAD_TIME'
      );
    }
    if (leadMinutes > MAX_ADVANCE_DAYS * 24 * 60) {
      throw ApiError.badRequest(
        `Bookings can be made at most ${MAX_ADVANCE_DAYS} days ahead`,
        'TOO_FAR_AHEAD'
      );
    }
  }

  if (tripType === 'ROUND_TRIP') {
    if (!returnAt) {
      throw ApiError.badRequest('A round trip needs a return time', 'RETURN_TIME_REQUIRED');
    }
    if (new Date(returnAt).getTime() <= pickup) {
      throw ApiError.badRequest('Return time must be after pickup', 'INVALID_RETURN_TIME');
    }
  } else if (returnAt) {
    // The database CHECK constraint enforces this too; rejecting here gives a
    // clearer message than a constraint violation would.
    throw ApiError.badRequest('A one-way trip cannot have a return time', 'UNEXPECTED_RETURN_TIME');
  }
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

/**
 * @param {object} input   validated request body
 * @param {object} actor   req.user
 * @param {object} meta    ip, userAgent, source
 */
async function create(input, actor, meta = {}) {
  const customerId = input.customerId || actor.id;

  /*
   * Guest contact is accepted ONLY for a guest customer.
   *
   * A signed-in rider's name and number come from their customer record. If a
   * request could set them, one customer could print another's name on an
   * invoice, and support would have no way to tell which was real.
   */
  const customerRow = await prisma.customer.findUnique({
    where: { userId: customerId },
    select: { isGuest: true },
  });

  const guestContact = customerRow?.isGuest
    ? {
        guestName: input.guestName ?? null,
        guestPhone: input.guestPhone ?? null,
        guestEmail: input.guestEmail ?? null,
      }
    : {};

  /*
   * A guest booking must carry a name and a number.
   *
   * Not to force a form — the website collects these on its own booking page
   * and sends them here — but because a dispatcher cannot serve a trip with
   * nobody to call. The driver reaches the pickup, the rider is not at the
   * kerb, and there is no way to resolve it: the account is a throwaway with
   * no phone on it by design.
   *
   * Checked at CREATE rather than at session start, so a visitor can browse
   * and get quotes without identifying themselves, and is asked only at the
   * point they commit.
   */
  if (customerRow?.isGuest) {
    if (!guestContact.guestName || !guestContact.guestPhone) {
      throw ApiError.badRequest(
        'A name and mobile number are needed so the driver can reach you',
        'GUEST_CONTACT_REQUIRED',
      );
    }
  }

  /**
   * A rental ALWAYS ends where it started.
   *
   * The car is hired for a block of hours and returns to the pickup point; that
   * return leg is inside the package, which is why the included km cover a round
   * journey. Where the passenger happens to step out is irrelevant to the
   * booking — they may be dropped anywhere along the way, and the car still
   * drives back.
   *
   * So the drop is OVERWRITTEN with the pickup, not merely defaulted to it when
   * absent. A supplied drop would otherwise be stored as the trip's endpoint and
   * every downstream reader — the dispatch board, the driver's app, the
   * invoice — would show the car finishing somewhere it does not finish, and
   * the km back to the pickup would look like unexplained extra distance.
   */
  if (input.tripType === 'HOURLY') {
    input = { ...input, drop: input.pickup };
  }

  /* ---- 1. attempt logged FIRST, before anything can reject ---- */
  const attempt = await logAttempt(
    {
      customerId,
      tripType: input.tripType,
      vehicleClass: input.vehicleClass,
      pickupAddress: input.pickup?.address || null,
      dropAddress: input.drop?.address || null,
      pickupAt: input.pickupAt,
      rawPayload: input,
    },
    meta
  );

  try {
    /* ---- 2. the customer must exist ---- */
    // findOrCreate rather than findById: an OTP-signup user may not have a
    // customer row yet, and a booking is a perfectly good moment to create one.
    await customerService.findOrCreate(customerId);

    /* ---- 3. timing ---- */
    validateTiming({
      pickupAt: input.pickupAt,
      returnAt: input.returnAt,
      tripType: input.tripType,
      scheduled: input.scheduled !== false,
    });

    /* ---- 4. price it — SERVER SIDE ONLY ---- */
    // The client sends coordinates and preferences, never an amount. Any fare
    // in the request body is ignored; the schema does not even accept one.
    const quote = await quoteService.getQuote({
      cityId: input.cityId,
      vehicleClass: input.vehicleClass,
      tripType: input.tripType,
      pickup: input.pickup,
      drop: input.drop,
      stops: input.stops || [],
      pickupAt: input.pickupAt,
      returnAt: input.returnAt || null,
      waitingMinutes: input.waitingMinutes || 0,
      surge: input.surge || 1,
      // HOURLY needs its package/hours to price; without these getQuote throws
      // RENTAL_TERMS_REQUIRED.
      rentalPackageId: input.rentalPackageId || null,
      rentalHours: input.rentalHours || null,
    });

    /**
     * A quote may answer an outstation request with a LOCAL ride when both
     * points are in the same city. That is the right behaviour while browsing
     * fares — but a booking must never be created as a different product from
     * the one the rider confirmed.
     *
     * So the switch is surfaced as an error here instead. The app has already
     * shown the "Switched to Local" dialog at the quote step, and the rider's
     * draft is HOURLY by the time they book; this only fires if something
     * bypassed that, which is exactly when it should.
     */
    if (quote.switchedToLocal) {
      throw ApiError.badRequest(
        quote.switchedToLocal.message,
        'SWITCH_TO_LOCAL_REQUIRED'
      );
    }

    /** What the rate card says, before any promo. Kept for fareBasis. */
    const grossTotal = quote.quote.total;

    /* ---- 5. who is billed ---- */
    const billing = await customerService.resolveBillingEntity(customerId);

    /* ---- 5a. promo code ----
     *
     * Evaluated AGAIN here, against the fare this service just priced, rather
     * than trusting the discount the app displayed. The /discounts/check call
     * the app made is advisory: minutes may have passed, the last use may have
     * gone, and the app's fareTotal is a number the client sent.
     *
     * An inapplicable code REFUSES the booking. Creating it at the full fare
     * would charge the rider an amount they were never shown, and the first
     * they would hear of it is the payment screen — or the bank statement.
     *
     * The discount comes off the TOTAL, so everything downstream of it —
     * the payment split, corporate credit, estimatedFare, and therefore the
     * settlement in lifecycle.recordTripDistance, which starts from
     * estimatedFare — sees the net amount without knowing a promo exists.
     */
    let promo = null;
    if (input.promoCode) {
      const result = await discountService.evaluate({
        code: input.promoCode,
        customerId,
        fareTotal: grossTotal,
        tripType: input.tripType,
        isCorporate: billing.billTo === 'CORPORATE',
      });
      if (!result.ok) {
        throw ApiError.badRequest(result.reason, result.code || 'DISCOUNT_INVALID');
      }
      promo = result;
    }

    const total = promo
      ? M.toStr(M.sub(M.dec(grossTotal), M.dec(promo.amount)))
      : grossTotal;

    const { advanceDue, balanceDue } = splitPayment(total, input.paymentMode);

    // A corporate booking consumes credit. Checking before creating means the
    // customer is told immediately rather than discovering it at settlement.
    if (billing.billTo === 'CORPORATE' && billing.corporateAccountId) {
      await corporateService.assertCreditAvailable(billing.corporateAccountId, total);
    }

    /* ---- 6. create, in ONE transaction ---- */
    const booking = await prisma.$transaction(async (tx) => {
      const bookingNumber = await nextBookingNumber(tx);

      const created = await tx.booking.create({
        data: {
          bookingNumber,
          customerId,
          corporateAccountId: billing.corporateAccountId,
          cityId: input.cityId,
          tripType: input.tripType,
          /*
           * EVERY booking starts PENDING, whatever the payment mode, and
           * stays there until an admin confirms it (lifecycle.confirm, via
           * PATCH /admin/bookings/:id/confirm).
           *
           * Pay-later used to confirm itself here and prepaid confirmed on
           * its first capture. Neither can know whether a car and driver are
           * actually available for that date — only ops can — so a rider was
           * being told "confirmed" for trips nobody had agreed to run.
           *
           * Payment is still accepted while PENDING; it is simply no longer
           * what confirms the trip.
           */
          status: 'PENDING',
          confirmedAt: null,
          vehicleClass: input.vehicleClass,

          pickupAddress: quote.trip.pickup.formattedAddress || input.pickup.address || 'Pickup',
          pickupLat: quote.trip.pickup.lat,
          pickupLng: quote.trip.pickup.lng,
          dropAddress: quote.trip.drop.formattedAddress || input.drop?.address || 'Drop',
          dropLat: quote.trip.drop.lat,
          dropLng: quote.trip.drop.lng,
          stops: quote.trip.stops ?? (input.stops || []),

          pickupAt: new Date(input.pickupAt),
          returnAt: input.returnAt ? new Date(input.returnAt) : null,

          // Trip-type extras. For HOURLY we store the package the quote actually
          // applied (resolved to this class), not the raw id the app sent.
          rentalPackageId: quote.rentalPackageId ?? input.rentalPackageId ?? null,
          rentalHours: quote.rentalHours ?? input.rentalHours ?? null,

          distanceKm: quote.trip.totalKm,
          durationMinutes: quote.trip.durationMin,

          estimatedFare: total,
          advancePaid: 0,
          balanceDue: input.paymentMode === 'ZERO' ? balanceDue.toString() : total,

          paymentMode: input.paymentMode,

          // THE FARE IS FROZEN HERE.
          // Six months from now a customer disputes this amount. If we
          // recomputed it from the current rate card we could not explain the
          // original figure — and if rates changed in between we would get a
          // different answer. Storing the whole breakdown makes every historic
          // fare auditable and immune to later config edits.
          fareBasis: {
            quotedAt: new Date().toISOString(),
            total,
            components: quote.quote,
            routing: quote.routing,
            billing: { billTo: billing.billTo, invoiceType: billing.invoiceType },
            paymentSplit: { advanceDue: advanceDue.toString(), balanceDue: balanceDue.toString() },
            // `total` above is NET of this. grossTotal is what the rate card
            // produced, so a dispute can be answered as "₹X, less ₹Y promo".
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
          },

          surgeMultiplier: quote.quote.meta.surgeMultiplier,
          specialRequests: input.specialRequests || null,
          // Empty for a signed-in rider — see where guestContact is built.
          ...guestContact,
          meta: { source: meta.source || 'unknown' },
        },
        select: BOOKING_SELECT,
      });

      // Inside the booking's transaction: a redemption that outlived a rolled-
      // back booking would burn a use on a trip that does not exist. The
      // unique index on booking_id makes a double-redeem impossible.
      if (promo) {
        await discountService.redeem(tx, {
          discountId: promo.discountId,
          bookingId: created.id,
          customerId,
          amount: promo.amount,
        });
      }

      await audit.record(tx, {
        actor,
        action: 'BOOKING_CREATED',
        entityType: 'booking',
        entityId: created.id,
        after: {
          bookingNumber,
          total,
          tripType: input.tripType,
          billTo: billing.billTo,
          ...(promo ? { promoCode: promo.code, discount: promo.amount, grossTotal } : {}),
        },
        meta,
      });

      return created;
    });

    /* ---- 7. attempt succeeded ---- */
    await settleAttempt(attempt?.id, {
      outcome: 'COMPLETED',
      bookingId: booking.id,
      estimatedFare: total,
    });

     await funnel.closeForBooking(customerId, booking.id);

    emit(EVENTS.BOOKING_CREATED, {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      customerId,
      total,
      tripType: booking.tripType,
      pickupAt: booking.pickupAt,
    });

  /**
   * The code the rider reads out to the driver at pickup.
   *
   * Generated and stored here, and shown only in the rider's app — it is not
   * sent by SMS or email (see tripOtp.issue). Minted at booking rather than at
   * allocation so it exists for the whole life of the booking: the rider can
   * see it the moment they book.
   *
   * Never allowed to fail the booking. If this write fails the booking still
   * stands, and ops can mint a code with tripOtp.reissue.
   */
  try {
    await tripOtp.issue(booking.id);
  } catch (err) {
    console.error(`[booking] could not issue start code for ${booking.bookingNumber}: ${err.message}`);
  }

    // No BOOKING_CONFIRMED here any more — that event now fires only from
    // lifecycle.confirm, when an admin confirms. Sending it at creation would
    // tell the rider "Booking confirmed" for a trip that is still pending.

    return {
      booking,
      payment: {
        mode: input.paymentMode,
        advanceDue: advanceDue.toString(),
        balanceDue: balanceDue.toString(),
        total,
      },
      discount: promo
        ? { code: promo.code, description: promo.description, amount: promo.amount, grossTotal }
        : null,
      billing,
    };
  } catch (err) {
    // The attempt row already exists, so a rejection is still visible to ops
    // with the reason attached.
    await settleAttempt(attempt?.id, {
      outcome: 'FAILED',
      failureReason: err.code || err.message,
    });
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

async function findById(id, actor) {
  const where = { id };

  // A customer may only fetch their own booking. Scoping in the QUERY rather
  // than checking afterwards means a mismatched id simply finds nothing —
  // the IDOR defence. 404 rather than 403, so the response does not confirm
  // that someone else's booking exists.
  if (actor.role === 'USER') where.customerId = actor.id;

  const booking = await prisma.booking.findFirst({ where, select: BOOKING_SELECT });
  if (!booking) throw ApiError.notFound('Booking not found');

  /**
   * The start code, for the OWNING CUSTOMER only.
   *
   * Fetched as a second query rather than added to BOOKING_SELECT, because
   * that select is shared with the list endpoints and with staff reads — one
   * field added there would leak the code into every one of them. The role
   * check here is the whole point: a driver reading this booking must not be
   * able to see the code they are supposed to be told.
   *
   * Dropped once the trip has started; it has done its job, and a code still
   * on screen invites a rider to read out a stale one on their next trip.
   */
  if (actor.role === 'USER' && booking.status !== 'COMPLETED' && booking.status !== 'CANCELLED') {
    const otp = await prisma.booking.findUnique({
      where: { id: booking.id },
      select: { startOtp: true, startOtpVerifiedAt: true },
    });
    if (otp && !otp.startOtpVerifiedAt) booking.startOtp = otp.startOtp;
  }

  return booking;
}

async function findByNumber(bookingNumber, actor) {
  const where = { bookingNumber };
  if (actor.role === 'USER') where.customerId = actor.id;

  const booking = await prisma.booking.findFirst({ where, select: BOOKING_SELECT });
  if (!booking) throw ApiError.notFound('Booking not found');
  return booking;
}

async function list(filters, actor) {
  const {
    page = 1, limit = 20, status, tripType, customerId, corporateAccountId,
    cityId, from, to, search, sortBy = 'createdAt', order = 'desc',
  } = filters;

  const where = {};

  // Customers see only their own, whatever they ask for.
  if (actor.role === 'USER') where.customerId = actor.id;
  else if (customerId) where.customerId = customerId;

  if (status) where.status = Array.isArray(status) ? { in: status } : status;
  if (tripType) where.tripType = tripType;
  if (corporateAccountId) where.corporateAccountId = corporateAccountId;
  if (cityId) where.cityId = Number(cityId);

  // Filters the PICKUP date, not creation date — "show me next week's trips"
  // is the question ops actually asks.
  if (from || to) {
    where.pickupAt = {};
    if (from) where.pickupAt.gte = new Date(from);
    if (to) where.pickupAt.lte = new Date(to);
  }

  if (search) {
    where.OR = [
      { bookingNumber: { contains: search, mode: 'insensitive' } },
      { pickupAddress: { contains: search, mode: 'insensitive' } },
      { dropAddress: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, items] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      select: BOOKING_LIST_SELECT,
      orderBy: { [sortBy]: order },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

/** Booking attempts, including abandoned ones. Staff only. */
async function listAttempts({ page = 1, limit = 50, outcome, from, to, notifiedOnly }) {
  const where = {};
  if (outcome) where.outcome = outcome;
  if (notifiedOnly === false) where.notifiedAt = null;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [total, items] = await Promise.all([
    prisma.bookingAttempt.count({ where }),
    prisma.bookingAttempt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        customer: { select: { userId: true, user: { select: { name: true, phone: true } } } },
        booking: { select: { id: true, bookingNumber: true, status: true } },
      },
    }),
  ]);

  return paginated(items, { page, limit, total });
}

async function stats(filters = {}) {
  const where = {};
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to) where.createdAt.lte = new Date(filters.to);
  }

  const [total, byStatus, byTripType, attempts] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.groupBy({ by: ['status'], where, _count: true }),
    prisma.booking.groupBy({ by: ['tripType'], where, _count: true }),
    prisma.bookingAttempt.groupBy({ by: ['outcome'], _count: true }),
  ]);

  const attemptCounts = attempts.reduce((a, r) => ({ ...a, [r.outcome]: r._count }), {});
  const totalAttempts = Object.values(attemptCounts).reduce((a, b) => a + b, 0);

  return {
    bookings: total,
    byStatus: byStatus.reduce((a, r) => ({ ...a, [r.status]: r._count }), {}),
    byTripType: byTripType.reduce((a, r) => ({ ...a, [r.tripType]: r._count }), {}),
    attempts: attemptCounts,
    // The number ABHICABS actually cares about: how many enquiries became trips.
    conversionRate: totalAttempts
      ? Number(((attemptCounts.COMPLETED || 0) / totalAttempts).toFixed(4))
      : null,
  };
}

module.exports = {
  create,
  findById,
  findByNumber,
  list,
  listAttempts,
  stats,
  splitPayment,
  logAttempt,
  settleAttempt,
  nextBookingNumber,
  PARTIAL_PCT,
  MIN_LEAD_MINUTES,
  MAX_ADVANCE_DAYS,
};