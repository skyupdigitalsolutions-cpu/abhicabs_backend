'use strict';

/**
 * src/services/paymentCollection.service.js
 *
 * Collecting money from a customer who is NOT holding the rider app.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS FILLS
 * ---------------------------------------------------------------------------
 * payment.service.createOrder makes a gateway ORDER, which is only useful to
 * something that can open a checkout — the rider app. That leaves out most of
 * the ways this business actually takes money: a trip booked over the phone, a
 * walk-in, a corporate coordinator paying for someone else's ride, a rider
 * whose app will not open the payment sheet. Today the answer to all of those
 * is cash, which is the answer that leaves no gateway record.
 *
 * Two instruments close that gap, and the choice between them is about TIME,
 * not preference:
 *
 *   LINK  Razorpay hosts a page and sends it by SMS and email itself, with
 *         reminders. Right for "pay before tomorrow" — it survives being sent
 *         now and read later.
 *
 *   QR    A fixed-amount, single-use UPI code. Right for someone in front of
 *         you, or on WhatsApp right now. Nothing is delivered — the admin
 *         shares the image. UPI only, so no cards.
 *
 * ---------------------------------------------------------------------------
 * NEITHER GETS ITS OWN CAPTURE PATH
 * ---------------------------------------------------------------------------
 * This is the design decision worth defending. A link and a QR are just two
 * more ways to reach the SAME money, so each one is stored as an ordinary
 * `payments` row with the instrument's id in providerOrderId. When the webhook
 * lands, applyGatewayEvent matches that id, moves the row to CAPTURED, writes
 * the ledger entry and moves the booking's advancePaid/balanceDue — all code
 * that already exists and is already tested.
 *
 * The alternative — a separate table and a separate settlement path — would
 * mean two implementations of "money arrived", which is precisely the kind of
 * duplication that produces a booking marked paid in one place and owing in
 * another.
 *
 * What makes it work is one detail in razorpay.provider.js: the webhook for a
 * link or QR carries the instrument's id in its own entity, not in the payment
 * entity's order_id, so parseWebhook reads those first. Change that and the
 * money still arrives and nothing is ever attached to it.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const paymentProvider = require('./providers/payment.provider');
const audit = require('./audit.service');
const M = require('../lib/money');
const {
  PAYMENT_STATUS,
  PAYMENT_PURPOSE,
  COLLECTION_TYPE,
  PAYMENT_SELECT,
} = require('../models/payment.model');

/** Statuses where the instrument can still take money. */
const LIVE_STATUSES = Object.freeze([
  PAYMENT_STATUS.CREATED,
  PAYMENT_STATUS.AUTHORISED,
  PAYMENT_STATUS.PARTIALLY_PAID,
]);

/**
 * Razorpay rejects an expiry closer than 15 minutes out, so this is a floor
 * rather than a preference. 24 hours is the default because the common case is
 * a trip tomorrow morning and a link that dies overnight is a support call.
 */
const MIN_EXPIRY_MINUTES = 16;
const DEFAULT_LINK_HOURS = 24;
const DEFAULT_QR_HOURS = 6;

const BOOKING_FIELDS = {
  id: true,
  bookingNumber: true,
  status: true,
  paymentMode: true,
  estimatedFare: true,
  finalFare: true,
  advancePaid: true,
  balanceDue: true,
  guestName: true,
  guestPhone: true,
  customer: {
    select: {
      userId: true,
      user: { select: { name: true, email: true, phone: true } },
    },
  },
};

/* ------------------------------------------------------------------ *
 * Amounts
 * ------------------------------------------------------------------ */

function bookingTotal(booking) {
  return M.round2(booking.finalFare != null ? booking.finalFare : booking.estimatedFare);
}

/**
 * What to charge.
 *
 * An explicit `amount` is allowed, because ops genuinely need it — a part
 * payment a customer negotiated on the phone, a waiver, a top-up after a
 * detour. It is CAPPED at what is outstanding: a link for more than the
 * booking owes produces an overpayment, and this system has no automatic
 * refund path to undo one.
 */
function resolveAmount(booking, purpose, requested) {
  const outstanding =
    purpose === PAYMENT_PURPOSE.FULL
      ? bookingTotal(booking)
      : M.round2(booking.balanceDue);

  if (requested == null) return outstanding;

  const asked = M.round2(requested);
  if (!M.isPositive(asked)) {
    throw ApiError.badRequest('Amount must be greater than zero', 'INVALID_AMOUNT');
  }
  if (M.gt(asked, outstanding)) {
    throw ApiError.badRequest(
      `That is more than the ₹${M.toStr(outstanding)} outstanding on this booking`,
      'AMOUNT_EXCEEDS_OUTSTANDING',
    );
  }
  return asked;
}

function resolveExpiry(hoursFromNow, explicit, fallbackHours) {
  const at = explicit
    ? new Date(explicit)
    : new Date(Date.now() + (hoursFromNow || fallbackHours) * 3600_000);

  if (at.getTime() < Date.now() + MIN_EXPIRY_MINUTES * 60_000) {
    throw ApiError.badRequest(
      `Expiry must be at least ${MIN_EXPIRY_MINUTES} minutes from now`,
      'EXPIRY_TOO_SOON',
    );
  }
  return at;
}

async function loadBooking(bookingId) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_FIELDS,
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  if (['CANCELLED', 'EXPIRED'].includes(booking.status)) {
    throw ApiError.conflict(
      `Cannot collect payment on a ${booking.status} booking`,
      'BOOKING_NOT_PAYABLE',
    );
  }
  return booking;
}

/**
 * The payer's details, which Razorpay uses to deliver a link.
 *
 * THE GUEST WINS when there is one. A booking made for someone else should
 * chase the person travelling, not the account holder — and more to the point,
 * sending a payment link to the wrong person's phone is a privacy incident,
 * not a typo.
 */
function payerFor(booking) {
  const user = booking.customer?.user || {};
  return {
    name: booking.guestName || user.name || null,
    phone: booking.guestPhone || user.phone || null,
    // A guest has no email on the booking, so this stays the account holder's.
    // Razorpay skips email delivery when it is absent rather than failing.
    email: user.email || null,
  };
}

function requireCapability(method, label) {
  if (!paymentProvider.supports(method)) {
    const provider = paymentProvider.getProvider().name;
    throw ApiError.badRequest(
      `${label} is not available on the "${provider}" payment provider`,
      'COLLECTION_NOT_SUPPORTED',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Reuse before create
 * ------------------------------------------------------------------ */

/**
 * An unexpired, unpaid instrument of the same kind for the same amount.
 *
 * Returned instead of creating a second one, for a reason that is operational
 * rather than tidy: two live links for one booking means two ways to pay it,
 * and a customer who pays the older one leaves a captured payment the admin is
 * not watching. The admin cancels explicitly when they want a fresh one.
 *
 * Amount is part of the match because a repriced booking SHOULD get a new
 * link — the old one would collect the wrong figure.
 */
async function findReusable(bookingId, collectionType, amount) {
  const open = await prisma.payment.findFirst({
    where: {
      bookingId,
      collectionType,
      status: { in: [...LIVE_STATUSES] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
    select: PAYMENT_SELECT,
  });

  if (!open) return null;
  if (!M.round2(open.amount).equals(M.round2(amount))) return null;
  return open;
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

async function createLink(bookingId, payload = {}, actor, meta = {}) {
  requireCapability('createPaymentLink', 'Payment links');

  const booking = await loadBooking(bookingId);
  const purpose = payload.purpose || PAYMENT_PURPOSE.BALANCE;
  const amount = resolveAmount(booking, purpose, payload.amount);

  if (!M.isPositive(amount)) {
    throw ApiError.badRequest('Nothing is outstanding on this booking', 'NOTHING_TO_CHARGE');
  }

  const reuse = await findReusable(bookingId, COLLECTION_TYPE.LINK, amount);
  if (reuse) return { payment: reuse, reused: true };

  const expiresAt = resolveExpiry(payload.expiresInHours, payload.expiresAt, DEFAULT_LINK_HOURS);
  const provider = paymentProvider.getProvider();
  const payer = payerFor(booking);

  /*
   * reference_id must be unique per link across the whole Razorpay account,
   * and a booking can legitimately need a second one — the first expired, or
   * the fare changed. Suffixing with the timestamp keeps the booking number
   * searchable in their dashboard (which is the point) while never colliding.
   */
  const referenceId = `${booking.bookingNumber}-${Date.now().toString(36)}`;

  const link = await provider.createPaymentLink({
    amount: M.toStr(amount),
    currency: 'INR',
    bookingId,
    purpose,
    referenceId,
    description: payload.description || `AbhiCabs trip ${booking.bookingNumber}`,
    customer: payer,
    // Default ON. A link nobody is told about is not a collection method, and
    // Razorpay's own delivery is the only transactional channel available here.
    notifyBySms: payload.notifyBySms !== false,
    notifyByEmail: payload.notifyByEmail !== false,
    expireBy: expiresAt,
  });

  return persist({
    booking,
    provider,
    instrument: link,
    collectionType: COLLECTION_TYPE.LINK,
    purpose,
    amount,
    expiresAt,
    actor,
    meta,
    auditAction: 'PAYMENT_LINK_CREATED',
    auditExtra: { notifiedSms: payload.notifyBySms !== false, referenceId },
  });
}

async function createQr(bookingId, payload = {}, actor, meta = {}) {
  requireCapability('createQrCode', 'UPI QR codes');

  const booking = await loadBooking(bookingId);
  const purpose = payload.purpose || PAYMENT_PURPOSE.BALANCE;
  const amount = resolveAmount(booking, purpose, payload.amount);

  if (!M.isPositive(amount)) {
    throw ApiError.badRequest('Nothing is outstanding on this booking', 'NOTHING_TO_CHARGE');
  }

  const reuse = await findReusable(bookingId, COLLECTION_TYPE.QR, amount);
  if (reuse) return { payment: reuse, reused: true };

  /*
   * Shorter default than a link, on purpose. A QR is for paying now, and the
   * image ends up in a WhatsApp thread where it outlives the conversation —
   * a payment instrument with a long life and no owner watching it.
   */
  const expiresAt = resolveExpiry(payload.expiresInHours, payload.expiresAt, DEFAULT_QR_HOURS);
  const provider = paymentProvider.getProvider();

  const qr = await provider.createQrCode({
    amount: M.toStr(amount),
    bookingId,
    purpose,
    description: payload.description || `AbhiCabs trip ${booking.bookingNumber}`,
    closeBy: expiresAt,
  });

  return persist({
    booking,
    provider,
    instrument: qr,
    collectionType: COLLECTION_TYPE.QR,
    purpose,
    amount,
    expiresAt,
    actor,
    meta,
    auditAction: 'PAYMENT_QR_CREATED',
  });
}

/**
 * Writes the gateway instrument into `payments`.
 *
 * ---------------------------------------------------------------------------
 * THE ORPHAN CASE, HANDLED EXPLICITLY
 * ---------------------------------------------------------------------------
 * The gateway call has already succeeded by the time this runs. If the INSERT
 * then fails, a live, payable instrument exists at Razorpay with no row here —
 * so a customer could pay it and the webhook would find nothing to attach the
 * money to.
 *
 * It is cancelled rather than left, because an uncancelled orphan is money
 * that can arrive with nowhere to go, and that is strictly worse than an admin
 * seeing an error and clicking again.
 */
async function persist({
  booking,
  provider,
  instrument,
  collectionType,
  purpose,
  amount,
  expiresAt,
  actor,
  meta,
  auditAction,
  auditExtra = {},
}) {
  let payment;
  try {
    payment = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        provider: provider.name,
        // The INSTRUMENT's id (plink_… / qr_…), not an order id — this is what
        // the webhook matches on. See razorpay.provider.js parseWebhook.
        providerOrderId: instrument.id,
        amount: M.toStr(amount),
        currency: 'INR',
        status: PAYMENT_STATUS.CREATED,
        purpose,
        collectionType,
        shareUrl: instrument.shareUrl || null,
        expiresAt: instrument.expiresAt || expiresAt,
        rawResponse: instrument.raw || {},
      },
      select: PAYMENT_SELECT,
    });
  } catch (err) {
    await rollbackInstrument(provider, collectionType, instrument.id);
    throw err;
  }

  audit.recordAsync({
    actor,
    action: auditAction,
    entityType: 'payment',
    entityId: payment.id,
    after: {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      purpose,
      amount: M.toStr(amount),
      collectionType,
      providerOrderId: instrument.id,
      expiresAt: payment.expiresAt,
      ...auditExtra,
    },
    meta,
  });

  return { payment, reused: false };
}

async function rollbackInstrument(provider, collectionType, id) {
  try {
    if (collectionType === COLLECTION_TYPE.LINK && provider.cancelPaymentLink) {
      await provider.cancelPaymentLink(id);
    } else if (collectionType === COLLECTION_TYPE.QR && provider.closeQrCode) {
      await provider.closeQrCode(id);
    }
  } catch (err) {
    // Logged loudly and swallowed: the original failure is the one the caller
    // needs to see, but an un-cancelled live instrument has to be findable.
    console.error(
      `[payment] ORPHANED ${collectionType} ${id} — created at the gateway but not stored, ` +
        `and cancelling it also failed: ${err.message}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Read, cancel, resend
 * ------------------------------------------------------------------ */

/** Every link and QR raised against a booking, newest first. */
async function listForBooking(bookingId) {
  const items = await prisma.payment.findMany({
    where: {
      bookingId,
      collectionType: { in: [COLLECTION_TYPE.LINK, COLLECTION_TYPE.QR] },
    },
    orderBy: { createdAt: 'desc' },
    select: PAYMENT_SELECT,
  });

  const now = Date.now();
  return items.map((p) => ({
    ...p,
    /*
     * Derived, never stored. The gateway stops accepting payment the moment
     * expires_at passes, but nothing writes a row at that instant — a stored
     * "expired" flag would be wrong for however long it took a job to notice.
     */
    expired:
      !!p.expiresAt &&
      new Date(p.expiresAt).getTime() < now &&
      LIVE_STATUSES.includes(p.status),
    payable:
      LIVE_STATUSES.includes(p.status) &&
      (!p.expiresAt || new Date(p.expiresAt).getTime() > now),
  }));
}

/**
 * Stops an instrument being payable.
 *
 * Cancelled AT THE GATEWAY FIRST, and the local row is only marked once that
 * succeeds. The other order looks tidier and is wrong: a row marked cancelled
 * while the link still works at Razorpay means a customer pays something the
 * admin has been told is dead.
 */
async function cancel(paymentId, actor, meta = {}) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: PAYMENT_SELECT,
  });
  if (!payment) throw ApiError.notFound('Payment not found');

  if (!payment.collectionType || payment.collectionType === COLLECTION_TYPE.CHECKOUT) {
    throw ApiError.badRequest(
      'This is a checkout order, not a payment link or QR code',
      'NOT_A_COLLECTION_INSTRUMENT',
    );
  }
  if (!LIVE_STATUSES.includes(payment.status)) {
    throw ApiError.conflict(
      `This ${payment.collectionType === COLLECTION_TYPE.QR ? 'QR code' : 'link'} is already ${payment.status}`,
      'NOT_CANCELLABLE',
    );
  }

  const provider = paymentProvider.getProvider();
  if (payment.collectionType === COLLECTION_TYPE.LINK) {
    requireCapability('cancelPaymentLink', 'Cancelling payment links');
    await provider.cancelPaymentLink(payment.providerOrderId);
  } else {
    requireCapability('closeQrCode', 'Closing QR codes');
    await provider.closeQrCode(payment.providerOrderId);
  }

  /*
   * FAILED, not a CANCELLED status — there is no CANCELLED in PaymentStatus,
   * and adding one would be the wrong fix. FAILED means "this order resolved
   * without money", which is exactly what a cancelled link is.
   *
   * It is also the SAFE choice for the race that matters here: a customer who
   * paid in the seconds before the admin hit cancel. FAILED ranks 1 and
   * CAPTURED ranks 4, so canAdvance still lets that capture through and the
   * money is recorded against the booking. A status ranked above CAPTURED
   * would have silently discarded a real payment.
   */
  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: { status: PAYMENT_STATUS.FAILED, failureReason: 'cancelled by admin' },
    select: PAYMENT_SELECT,
  });

  audit.recordAsync({
    actor,
    action: 'PAYMENT_COLLECTION_CANCELLED',
    entityType: 'payment',
    entityId: paymentId,
    before: { status: payment.status },
    after: { status: PAYMENT_STATUS.FAILED, collectionType: payment.collectionType },
    meta,
  });

  return updated;
}

/**
 * Asks Razorpay to send an existing link again.
 *
 * A RESEND, not a new link — the customer may already have the first one open.
 * Links only; a QR is an image the admin shares themselves, and there is
 * nothing for the gateway to deliver.
 */
async function resend(paymentId, medium, actor, meta = {}) {
  requireCapability('resendPaymentLink', 'Resending payment links');

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: PAYMENT_SELECT,
  });
  if (!payment) throw ApiError.notFound('Payment not found');

  if (payment.collectionType !== COLLECTION_TYPE.LINK) {
    throw ApiError.badRequest(
      'Only payment links can be resent — share a QR code image directly',
      'NOT_A_PAYMENT_LINK',
    );
  }
  if (!LIVE_STATUSES.includes(payment.status)) {
    throw ApiError.conflict(`This link is ${payment.status}`, 'NOT_RESENDABLE');
  }
  if (payment.expiresAt && new Date(payment.expiresAt).getTime() < Date.now()) {
    throw ApiError.conflict(
      'This link has expired — create a new one',
      'LINK_EXPIRED',
    );
  }

  await paymentProvider.getProvider().resendPaymentLink(payment.providerOrderId, medium);

  audit.recordAsync({
    actor,
    action: 'PAYMENT_LINK_RESENT',
    entityType: 'payment',
    entityId: paymentId,
    after: { medium, providerOrderId: payment.providerOrderId },
    meta,
  });

  return { sent: true, medium, payment };
}

module.exports = {
  createLink,
  createQr,
  listForBooking,
  cancel,
  resend,
  LIVE_STATUSES,
};