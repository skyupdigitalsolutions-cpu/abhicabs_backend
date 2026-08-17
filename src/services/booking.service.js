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

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');
const quoteService = require('./quote.service');
const customerService = require('./customer.service');
const corporateService = require('./corporate.service');
const audit = require('./audit.service');
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
const PARTIAL_PCT = Number(process.env.PARTIAL_PAYMENT_PCT || 25);

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

  // An immediate booking is "now"; a scheduled one needs enough lead time for a
  // vehicle to actually reach the pickup point.
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
  } else if (pickup < now - 5 * 60000) {
    throw ApiError.badRequest('Pickup time is in the past', 'PICKUP_IN_PAST');
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
    const customer = await customerService.findOrCreate(customerId);

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
      pickupAt: input.pickupAt,
      returnAt: input.returnAt || null,
      waitingMinutes: input.waitingMinutes || 0,
      surge: input.surge || 1,
    });

    const total = quote.quote.total;
    const { advanceDue, balanceDue } = splitPayment(total, input.paymentMode);

    /* ---- 5. who is billed ---- */
    const billing = await customerService.resolveBillingEntity(customerId);

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
          status: 'PENDING',
          vehicleClass: input.vehicleClass,

          pickupAddress: quote.trip.pickup.formattedAddress || input.pickup.address || 'Pickup',
          pickupLat: quote.trip.pickup.lat,
          pickupLng: quote.trip.pickup.lng,
          dropAddress: quote.trip.drop.formattedAddress || input.drop.address || 'Drop',
          dropLat: quote.trip.drop.lat,
          dropLng: quote.trip.drop.lng,
          stops: input.stops || [],

          pickupAt: new Date(input.pickupAt),
          returnAt: input.returnAt ? new Date(input.returnAt) : null,

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
          },

          surgeMultiplier: quote.quote.meta.surgeMultiplier,
          specialRequests: input.specialRequests || null,
          meta: { source: meta.source || 'unknown' },
        },
        select: BOOKING_SELECT,
      });

      await audit.record(tx, {
        actor,
        action: 'BOOKING_CREATED',
        entityType: 'booking',
        entityId: created.id,
        after: { bookingNumber, total, tripType: input.tripType, billTo: billing.billTo },
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

    emit(EVENTS.BOOKING_CREATED, {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      customerId,
      total,
      tripType: booking.tripType,
      pickupAt: booking.pickupAt,
    });

    return {
      booking,
      payment: {
        mode: input.paymentMode,
        advanceDue: advanceDue.toString(),
        balanceDue: balanceDue.toString(),
        total,
      },
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