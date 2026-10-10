'use strict';

/**
 * src/services/payment.service.js
 *
 * Money-in. Creates one gateway order per (booking, purpose), and applies
 * gateway events to advance a payment through its forward-only status machine.
 *
 * The apply path is the security- and correctness-critical one: it is called
 * by the webhook service and MUST be safe to run any number of times with the
 * same event. It is made safe by two independent guards:
 *
 *   1. The forward-only status machine (payment.model.canAdvance): an event
 *      that would not strictly advance the status changes zero rows.
 *   2. The ledger's unique `reference`: a capture writes exactly one ledger
 *      entry per gateway payment id, so even a bypass of guard 1 cannot
 *      double-credit.
 *
 * Combined with the webhook service's insert-event-first dedup, replaying a
 * webhook five times moves money exactly once.
 */

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const M = require('../lib/money');
const { emit, EVENTS } = require('../lib/events');
const audit = require('./audit.service');
const push = require('./push.service');
const paymentProvider = require('./providers/payment.provider');
const {
  PAYMENT_STATUS,
  PAYMENT_PURPOSE,
  PAYMENT_SELECT,
  mapGatewayStatus,
  canAdvance,
} = require('../models/payment.model');

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const BOOKING_FIELDS = {
  id: true,
  bookingNumber: true,
  status: true,
  paymentMode: true,
  estimatedFare: true,
  finalFare: true,
  advancePaid: true,
  balanceDue: true,
  fareBasis: true,
};

/** Total payable: the final fare once set, else the estimate. */
function bookingTotal(booking) {
  return M.round2(booking.finalFare != null ? booking.finalFare : booking.estimatedFare);
}

/**
 * The amount a given order purpose should charge, derived from the booking's
 * own frozen state so there is a single source of truth.
 *
 *   ADVANCE  — the advance portion (PARTIAL) or the whole total (FULL mode).
 *   BALANCE  — whatever is still owed right now (balanceDue).
 *   FULL     — the entire total in one shot.
 */
function amountForPurpose(booking, purpose) {
  const total = bookingTotal(booking);

  if (purpose === PAYMENT_PURPOSE.BALANCE) {
    return M.round2(booking.balanceDue);
  }

  if (purpose === PAYMENT_PURPOSE.FULL) {
    return total;
  }

  // ADVANCE
  if (booking.paymentMode === 'FULL') {
    return total;
  }
  if (booking.paymentMode === 'PARTIAL') {
    // Prefer the advance frozen onto the fare basis; fall back to config.
    const split = booking.fareBasis?.paymentSplit;
    if (split && split.advanceDue != null) return M.round2(split.advanceDue);
    return M.round2(M.pct(total, require('../config/env').payment.advancePercent));
  }
  // ZERO mode has no advance to collect.
  return M.dec(0);
}

/* ------------------------------------------------------------------ *
 * Create order
 * ------------------------------------------------------------------ */

/**
 * Creates (or returns the existing open) gateway order for a booking + purpose.
 *
 * The partial unique index uq_payment_open_per_purpose guarantees at most one
 * LIVE order per (booking, purpose). We lean on it rather than a check-then-act:
 * insert, and if it collides return the order already open. That makes a
 * double-tapped "Pay advance" button return the SAME order instead of charging
 * twice — the payment equivalent of the idempotency key.
 */
async function createOrder(bookingId, purpose, actor, meta = {}) {
  if (!Object.values(PAYMENT_PURPOSE).includes(purpose)) {
    throw ApiError.badRequest(`Unknown payment purpose "${purpose}"`, 'INVALID_PURPOSE');
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_FIELDS,
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  if (['CANCELLED', 'EXPIRED'].includes(booking.status)) {
    throw ApiError.conflict(
      `Cannot take a payment on a ${booking.status} booking`,
      'BOOKING_NOT_PAYABLE'
    );
  }

  const amount = amountForPurpose(booking, purpose);
  // chk_payment_amount_positive requires amount > 0. A zero/negative order is a
  // caller error (e.g. asking for an advance on a ZERO-mode booking, or a
  // balance order when nothing is owed), not something to send to the gateway.
  if (!M.isPositive(amount)) {
    throw ApiError.badRequest(
      `Nothing to charge for purpose ${purpose} on this booking`,
      'NOTHING_TO_CHARGE'
    );
  }

  const provider = paymentProvider.getProvider();

  // If a live order for this purpose already exists, return it rather than
  // creating a second gateway order we would then have to reconcile.
  const existingOpen = await prisma.payment.findFirst({
    where: {
      bookingId,
      purpose,
      status: {
        in: [
          PAYMENT_STATUS.CREATED,
          PAYMENT_STATUS.AUTHORISED,
          PAYMENT_STATUS.CAPTURED,
          PAYMENT_STATUS.PARTIALLY_PAID,
        ],
      },
    },
    select: PAYMENT_SELECT,
  });
  if (existingOpen) {
    return { payment: existingOpen, reused: true };
  }

  const order = await provider.createOrder({
    amount: amount.toFixed(2),
    currency: 'INR',
    bookingId,
    purpose,
    receipt: booking.bookingNumber,
  });

  try {
    const payment = await prisma.payment.create({
      data: {
        bookingId,
        provider: provider.name,
        providerOrderId: order.orderId,
        amount: amount.toFixed(2),
        currency: 'INR',
        status: PAYMENT_STATUS.CREATED,
        purpose,
        rawResponse: order.raw || {},
      },
      select: PAYMENT_SELECT,
    });

    audit.recordAsync({
      actor,
      action: 'PAYMENT_ORDER_CREATED',
      entityType: 'payment',
      entityId: payment.id,
      after: { bookingId, purpose, amount: amount.toFixed(2), provider: provider.name },
      meta,
    });

    return { payment, reused: false };
  } catch (err) {
    // Lost a race with a concurrent create for the same (booking, purpose).
    // The other request won; return its order.
    if (isUniqueViolation(err)) {
      const winner = await prisma.payment.findFirst({
        where: { bookingId, purpose },
        orderBy: { createdAt: 'desc' },
        select: PAYMENT_SELECT,
      });
      if (winner) return { payment: winner, reused: true };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Apply a gateway event  (called by the webhook service, inside a tx)
 * ------------------------------------------------------------------ */

const CAPTURE_LEDGER_TYPE = {
  [PAYMENT_PURPOSE.ADVANCE]: 'ADVANCE_RECEIVED',
  [PAYMENT_PURPOSE.FULL]: 'ADVANCE_RECEIVED',
  [PAYMENT_PURPOSE.BALANCE]: 'BALANCE_RECEIVED',
};

/**
 * Advances the payment identified by (provider, providerOrderId) to the status
 * the event carries, if and only if that is a strict forward move.
 *
 * Returns { changed, status, reason }. `changed:false` is the normal, expected
 * outcome for a duplicate or out-of-order event — NOT an error.
 *
 * Runs entirely inside the caller's transaction `tx` so the payment update, the
 * booking balance update and the ledger entry commit together or not at all.
 */
async function applyGatewayEvent(tx, parsed) {
  const nextStatus = mapGatewayStatus(parsed.status);
  if (!nextStatus) {
    return { changed: false, reason: 'unmapped_status' };
  }

  const payment = await tx.payment.findFirst({
    where: { providerOrderId: parsed.providerOrderId },
    select: { ...PAYMENT_SELECT, rawResponse: false },
  });
  if (!payment) {
    // A webhook for an order we never created. Acknowledge it (so the gateway
    // stops retrying) but touch nothing.
    return { changed: false, reason: 'no_matching_payment' };
  }

  if (!canAdvance(payment.status, nextStatus)) {
    // Stale, duplicate, or out-of-order. The forward-only guarantee: no-op.
    return { changed: false, reason: 'not_a_forward_move', from: payment.status, to: nextStatus };
  }

  const paidAt = nextStatus === PAYMENT_STATUS.CAPTURED ? new Date() : null;

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: nextStatus,
      providerPaymentId: parsed.providerPaymentId || payment.providerPaymentId,
      method: parsed.method || undefined,
      paidAt: paidAt || undefined,
      failureReason: nextStatus === PAYMENT_STATUS.FAILED ? 'gateway reported failure' : undefined,
      rawResponse: parsed.raw || {},
    },
  });

  // Money only actually moves on capture.
  let captured = null;
  if (nextStatus === PAYMENT_STATUS.CAPTURED) {
    captured = await applyCapture(tx, payment, parsed);
  }

  /*
   * `events` travels back to the caller to be published AFTER COMMIT. Empty on
   * every path that moved no money — including a duplicate capture, which
   * returns null above so a replayed webhook cannot produce a second receipt.
   */
  return {
    changed: true,
    status: nextStatus,
    paymentId: payment.id,
    events: captured ? [captured] : [],
  };
}

/**
 * Records a captured payment: one append-only ledger entry, and the booking's
 * paid/owed counters moved atomically.
 */
async function applyCapture(tx, payment, parsed) {
  const amount = M.round2(parsed.amount != null ? parsed.amount : payment.amount);

  // 1. Ledger entry — append-only, unique per gateway payment id. The unique
  //    `reference` makes a double-credit impossible even if this ran twice.
  const reference = `pay:${payment.provider}:${parsed.providerPaymentId || payment.id}`;
  try {
    await tx.ledgerEntry.create({
      data: {
        bookingId: payment.bookingId,
        entryType: CAPTURE_LEDGER_TYPE[payment.purpose] || 'ADVANCE_RECEIVED',
        direction: 'CREDIT',
        amount: amount.toFixed(2),
        currency: 'INR',
        reference,
        note: `${payment.purpose} captured via ${payment.provider}`,
        meta: { paymentId: payment.id, providerPaymentId: parsed.providerPaymentId },
      },
    });
  } catch (err) {
    // Already recorded (a replay that slipped past the status guard). The ledger
    // is the source of truth for money, so if the entry exists the capture is
    // already accounted for — stop here without touching the booking again.
    if (isUniqueViolation(err)) {
      // Already accounted for. No event, and so no second push for money that
      // was only ever received once.
      return null;
    }
    throw err;
  }

  // 2. Booking counters. advance_paid accumulates everything paid so far;
  //    balance_due is recomputed as total - paid, floored at zero so it can
  //    never violate chk_booking_amounts_non_negative or drive a paid-in-full
  //    booking negative. Single atomic statement — no read-modify-write race.
  const booking = await tx.booking.findUnique({
    where: { id: payment.bookingId },
    select: {
      estimatedFare: true, finalFare: true,
      status: true, paymentMode: true, bookingNumber: true,
      customerId: true, pickupAt: true,
      // Needed to work out what is STILL owed after this capture. The UPDATE
      // below computes the same figure in SQL, but the receipt has to carry it
      // out of the transaction and a SELECT after the write would be invisible
      // to anything reading outside it.
      advancePaid: true,
    },
  });
  const total = M.round2(booking.finalFare != null ? booking.finalFare : booking.estimatedFare);

  await tx.$executeRaw`
    UPDATE "bookings"
    SET "advance_paid" = "advance_paid" + ${amount.toFixed(2)}::numeric,
        "balance_due"  = GREATEST(
          0,
          ${total.toFixed(2)}::numeric - ("advance_paid" + ${amount.toFixed(2)}::numeric)
        ),
        "updated_at"   = NOW()
    WHERE "id" = ${payment.bookingId}::uuid
  `;

  // 3. NO auto-confirm. A capture used to move a prepaid booking PENDING ->
  //    CONFIRMED here. Confirmation is now an admin decision only (see
  //    lifecycle.confirm): being paid means the rider is committed, not that
  //    a car and driver are available. The booking stays PENDING with its
  //    payment recorded, and the admin sees it as paid-and-awaiting in the
  //    panel. If the admin declines, cancelling it runs the normal refund.

  /*
   * RETURNED, NOT EMITTED — and this is the fix that makes a payment push safe
   * to add at all.
   *
   * This function runs inside the caller's transaction. Emitting here fires
   * before COMMIT, so a transaction that then rolls back has already told the
   * world the money landed. With only a socket event that was survivable: the
   * client refetches, sees the truth and corrects itself within seconds.
   *
   * A PUSH CANNOT BE RETRACTED. "₹4,737 received" sitting in a rider's
   * notification tray for a payment that was rolled back is a support call and
   * a trust problem, and no later refetch undoes it.
   *
   * So the payload is handed back to the caller, which publishes it only once
   * the transaction has committed. See publishCaptureEvents and
   * webhook.service.process.
   */
  const balanceDue = M.max(M.sub(total, M.add(M.dec(booking.advancePaid), amount)), M.dec(0));

  return {
    bookingId: payment.bookingId,
    bookingNumber: booking.bookingNumber,
    customerId: booking.customerId,
    paymentId: payment.id,
    purpose: payment.purpose,
    amount: amount.toFixed(2),
    /*
     * Recomputed here with the same arithmetic as the UPDATE above rather than
     * re-read, because a SELECT inside this transaction would see the new row
     * but any reader outside it would not — and the value is wanted by things
     * that run after the commit.
     */
    balanceDue: M.toStr(balanceDue),
    /** How the money was asked for: CHECKOUT, LINK or QR. Null on older rows. */
    collectionType: payment.collectionType || null,
  };
}

/* ------------------------------------------------------------------ *
 * Publishing a capture — AFTER the transaction has committed
 * ------------------------------------------------------------------ */

/**
 * Tell the rider, and the rest of the system, that money landed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE STEP
 * ---------------------------------------------------------------------------
 * Everything here is OUTSIDE the database transaction, on purpose:
 *
 *   - a socket emit before COMMIT can announce a payment a rollback then
 *     erases;
 *   - a PUSH before COMMIT does the same thing permanently, since a
 *     notification cannot be withdrawn from a phone;
 *   - and the FCM call is a network round trip, which has no business holding
 *     a Postgres transaction open.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PUSH MATTERS MORE THAN IT USED TO
 * ---------------------------------------------------------------------------
 * When the only way to pay was the in-app checkout, the rider was already
 * looking at the app when their money moved; the socket event was enough and a
 * push would have been noise.
 *
 * Payment links and UPI QR codes broke that assumption. The rider pays in a
 * browser or their UPI app — somewhere else, by definition — and may not open
 * this app again for hours. Without a push, the only confirmation they get
 * that an AbhiCabs payment succeeded comes from their bank.
 *
 * Fire-and-forget throughout: the money is already committed and recorded, and
 * no notification failure may be allowed to look like a payment failure.
 */
function publishCaptureEvents(events) {
  for (const e of events || []) {
    emit(EVENTS.PAYMENT_RECEIVED, {
      bookingId: e.bookingId,
      paymentId: e.paymentId,
      purpose: e.purpose,
      amount: e.amount,
      // Carried so a client can show the new figure without a second read.
      // The rider app still refetches — the server stays the source of truth
      // for what is owed — but a socket payload that omits the balance forces
      // every listener to go and ask.
      balanceDue: e.balanceDue,
      at: new Date().toISOString(),
    });

    if (!e.customerId) continue;

    const settled = Number(e.balanceDue) <= 0;
    push
      .pushToUser(e.customerId, {
        title: 'Payment received',
        body:
          `₹${e.amount} received for ${e.bookingNumber}. ` +
          (settled ? 'Nothing further is due.' : `₹${e.balanceDue} still due.`),
        data: {
          type: 'PAYMENT_RECEIVED',
          bookingId: e.bookingId,
          paymentId: e.paymentId,
          balanceDue: e.balanceDue,
        },
      })
      .catch((err) => console.error(`[payment] receipt push failed: ${err.message}`));
  }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

async function getById(id, actor = null) {
  const payment = await prisma.payment.findUnique({ where: { id }, select: PAYMENT_SELECT });
  if (!payment) throw ApiError.notFound('Payment not found');

  // Day 14 IDOR fix: a customer may only read a payment on THEIR OWN booking.
  // Without this, any authenticated user could enumerate payment ids and read
  // anyone's payment record. Staff roles (non-USER) are allowed through for ops.
  // We return 404 (not 403) on a mismatch so the response does not confirm that
  // a payment with this id exists — same posture as booking.findById.
  if (actor && actor.role === 'USER') {
    const booking = await prisma.booking.findUnique({
      where: { id: payment.bookingId },
      select: { customerId: true },
    });
    if (!booking || booking.customerId !== actor.id) {
      throw ApiError.notFound('Payment not found');
    }
  }
  return payment;
}

async function listForBooking(bookingId) {
  return prisma.payment.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
    select: PAYMENT_SELECT,
  });
}

/* ------------------------------------------------------------------ *
 * Driver cash collection (offline settlement)
 * ------------------------------------------------------------------ */

/**
 * The assigned driver collects the outstanding balance in cash after the ride
 * (pay-later ZERO trips, or the remaining half of a PARTIAL trip). Records a
 * CASH payment + a BALANCE_RECEIVED ledger credit and zeroes the balance — all
 * atomic, and idempotent via the unique ledger reference so a double-tap can't
 * post twice.
 *
 * Authorisation: the caller must be the driver on an allocation for this
 * booking. Allowed only at/after ARRIVED (i.e. after the trip has run).
 */
async function collectCash(bookingId, actor, meta = {}) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, status: true, paymentMode: true,
      advancePaid: true, finalFare: true, estimatedFare: true,
      bookingNumber: true, customerId: true,
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  // This driver must actually be assigned to the trip.
  const allocation = await prisma.allocation.findFirst({
    where: { bookingId, driverId: actor.id },
    select: { id: true },
  });
  if (!allocation) {
    throw ApiError.forbidden('You are not assigned to this trip', 'NOT_YOUR_TRIP');
  }

  if (!['ARRIVED', 'COMPLETED'].includes(booking.status)) {
    throw ApiError.conflict(
      'Cash can only be collected once the trip has reached the drop-off',
      'NOT_COLLECTABLE_YET'
    );
  }

  const total = M.round2(booking.finalFare != null ? booking.finalFare : booking.estimatedFare);
  const balance = M.round2(M.sub(M.dec(total), M.dec(booking.advancePaid)));
  if (Number(balance) <= 0.009) {
    throw ApiError.conflict('Nothing is due on this trip', 'NOTHING_DUE');
  }

  /*
   * AWAITED into a variable rather than returned directly: the capture event
   * must be published only once this transaction has committed, so there has
   * to be a statement after it.
   */
  const result = await prisma.$transaction(async (tx) => {
    /*
     * AN OPEN BALANCE ORDER MAY ALREADY EXIST — SETTLE IT, DO NOT ADD A SECOND.
     *
     * uq_payment_open_per_purpose forbids two live payments with the same
     * (booking_id, purpose). That constraint is right: it is what stops a
     * customer being charged twice for one balance.
     *
     * But the rider reaching for the card first is completely normal. Tapping
     * "Pay" creates a CREATED balance order; if they then abandon the sheet —
     * or it never opened — that row stays live. The driver taking cash a minute
     * later hit the constraint and saw "A record with that booking_id, purpose
     * already exists", with no way to collect at all.
     *
     * The right resolution is to CAPTURE the order that already exists rather
     * than open a rival one. The rider is paying the same balance by a
     * different method; there was only ever one debt.
     *
     * Only an unsettled row is taken over. A CAPTURED one means the balance was
     * already paid, and the guard above has already returned in that case.
     */
    const open = await tx.payment.findFirst({
      where: {
        bookingId,
        purpose: PAYMENT_PURPOSE.BALANCE,
        status: { in: [PAYMENT_STATUS.CREATED, PAYMENT_STATUS.AUTHORISED] },
      },
      select: { id: true, provider: true },
    });

    const payment = open
      ? await tx.payment.update({
          where: { id: open.id },
          data: {
            provider: 'cash',
            method: 'CASH',
            amount: balance.toFixed(2),
            status: PAYMENT_STATUS.CAPTURED,
            paidAt: new Date(),
            rawResponse: {
              offline: true,
              collectedByDriverId: actor.id,
              // Kept so the trail shows the rider started a gateway payment and
              // finished in cash, rather than looking like a cash-only trip.
              supersededProvider: open.provider,
            },
          },
          select: { id: true },
        })
      : await tx.payment.create({
          data: {
            bookingId,
            provider: 'cash',
            amount: balance.toFixed(2),
            currency: 'INR',
            method: 'CASH',
            status: PAYMENT_STATUS.CAPTURED,
            purpose: PAYMENT_PURPOSE.BALANCE,
            paidAt: new Date(),
            rawResponse: { offline: true, collectedByDriverId: actor.id },
          },
          select: { id: true },
        });

    try {
      await tx.ledgerEntry.create({
        data: {
          bookingId,
          entryType: 'BALANCE_RECEIVED',
          direction: 'CREDIT',
          amount: balance.toFixed(2),
          currency: 'INR',
          reference: `cash:${bookingId}`, // one cash settlement per booking
          note: 'Balance collected in cash by driver',
          meta: { paymentId: payment.id, driverId: actor.id },
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw ApiError.conflict('This trip has already been settled in cash', 'ALREADY_SETTLED');
      }
      throw err;
    }

    await tx.booking.update({
      where: { id: bookingId },
      data: { advancePaid: total.toFixed(2), balanceDue: '0.00' },
    });

    await audit.record(tx, {
      actor,
      action: 'CASH_COLLECTED',
      entityType: 'booking',
      entityId: bookingId,
      after: { amount: balance.toFixed(2), method: 'CASH' },
      meta,
    });

    /*
     * Deliberately NOT emitted here. Cash has the same pre-commit hazard as a
     * gateway capture: announcing it from inside the transaction means a
     * rollback leaves the rider holding a receipt for a settlement that never
     * happened. The payload rides out on the transaction's return value and is
     * published below, once it has committed.
     */

    /*
     * IS THE TRIP NOW FINISHABLE?
     *
     * Money is settled, but completion is not this function's to perform: a
     * driver cannot complete a trip without the END odometer reading and its
     * photo (see lifecycle.completeTrip), and cash collection carries neither.
     * Calling completeTrip from here would either fail for every driver who
     * has not yet submitted the reading, or force us to skip a check that
     * exists to stop disputed distances.
     *
     * So this reports whether the only remaining blocker is the odometer. The
     * driver app uses it to send the reading and call /complete immediately
     * after collecting, turning two taps into one — and when the reading was
     * already submitted at the kerb, nothing is left to do but complete.
     *
     * Read inside the transaction so it reflects the balance just cleared.
     */
    const endReading = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { endOdometerKm: true, endOdometerPhotoUrl: true, status: true },
    });

    const hasOdometer =
      endReading?.endOdometerKm != null && !!endReading?.endOdometerPhotoUrl;

    return {
      bookingId,
      bookingNumber: booking.bookingNumber,
      collected: balance.toFixed(2),
      balanceDue: '0.00',
      method: 'CASH',
      /*
       * Nothing is owed and the trip is not finished yet.
       * `readyToComplete` says the driver can call /complete right now;
       * `needsOdometer` says what is missing if not.
       */
      tripStatus: endReading?.status ?? booking.status,
      readyToComplete: endReading?.status === 'ARRIVED' && hasOdometer,
      needsOdometer: endReading?.status === 'ARRIVED' && !hasOdometer,

      /** Published after commit, then stripped from the HTTP response below. */
      __captureEvent: {
        bookingId,
        bookingNumber: booking.bookingNumber,
        customerId: booking.customerId,
        paymentId: payment.id,
        purpose: PAYMENT_PURPOSE.BALANCE,
        amount: balance.toFixed(2),
        balanceDue: '0.00',
        collectionType: null,
      },
    };
  });

  const { __captureEvent, ...response } = result;
  publishCaptureEvents([__captureEvent]);
  return response;
}

module.exports = {
  createOrder,
  applyGatewayEvent,
  publishCaptureEvents,
  getById,
  listForBooking,
  amountForPurpose,
  bookingTotal,
  collectCash,
};