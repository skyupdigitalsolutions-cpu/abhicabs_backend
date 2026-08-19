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
  if (nextStatus === PAYMENT_STATUS.CAPTURED) {
    await applyCapture(tx, payment, parsed);
  }

  return { changed: true, status: nextStatus, paymentId: payment.id };
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
      return;
    }
    throw err;
  }

  // 2. Booking counters. advance_paid accumulates everything paid so far;
  //    balance_due is recomputed as total - paid, floored at zero so it can
  //    never violate chk_booking_amounts_non_negative or drive a paid-in-full
  //    booking negative. Single atomic statement — no read-modify-write race.
  const booking = await tx.booking.findUnique({
    where: { id: payment.bookingId },
    select: { estimatedFare: true, finalFare: true },
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

  // Fire-and-forget: Day 10 turns this into a customer receipt + admin alert.
  // Emitted AFTER the row change so a listener that reads the booking sees the
  // new balance. Never emitted for a duplicate (we returned above).
  emit(EVENTS.PAYMENT_RECEIVED, {
    bookingId: payment.bookingId,
    paymentId: payment.id,
    purpose: payment.purpose,
    amount: amount.toFixed(2),
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

async function getById(id) {
  const payment = await prisma.payment.findUnique({ where: { id }, select: PAYMENT_SELECT });
  if (!payment) throw ApiError.notFound('Payment not found');
  return payment;
}

async function listForBooking(bookingId) {
  return prisma.payment.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
    select: PAYMENT_SELECT,
  });
}

module.exports = {
  createOrder,
  applyGatewayEvent,
  getById,
  listForBooking,
  amountForPurpose,
  bookingTotal,
};