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
 * whose app will not open the payment sheet. Without this the answer to all of
 * those is cash, which is the answer that leaves no gateway record.
 *
 * Two instruments close that gap, and the choice between them is about TIME,
 * not preference:
 *
 *   LINK  Razorpay hosts a page and sends it by SMS and email itself, with
 *         reminders. Right for "pay before tomorrow" — it survives being sent
 *         now and read later.
 *
 *   QR    A fixed-amount, single-use UPI code. Right for someone in front of
 *         you, or on WhatsApp right now. Nothing is delivered by the gateway —
 *         the admin shares the image. UPI only, so no cards.
 *
 * ---------------------------------------------------------------------------
 * WITH A BOOKING, OR WITHOUT ONE
 * ---------------------------------------------------------------------------
 * Both instruments come in two flavours, and the difference is one question:
 * does a booking already exist?
 *
 *   BOOKING-SCOPED   the amount is DERIVED from the booking's balanceDue and
 *                    capped at it, the payer is derived from the booking, and
 *                    a capture moves advancePaid / balanceDue.
 *
 *   STANDALONE       there is no booking yet. The admin is taking an advance
 *                    over the phone before entering the trip, settling a
 *                    cancellation fee, or collecting for something that is not
 *                    a trip at all. The amount and the payer are both stated
 *                    explicitly, because there is nothing to derive them from,
 *                    and a capture writes a ledger entry with a null bookingId
 *                    and moves no counters.
 *
 * They share one code path below rather than being two features, because the
 * part that is easy to get wrong — reuse before create, orphan rollback,
 * cancel-at-the-gateway-first — is identical and must stay identical.
 *
 * ---------------------------------------------------------------------------
 * NEITHER GETS ITS OWN CAPTURE PATH
 * ---------------------------------------------------------------------------
 * This is the design decision worth defending. A link and a QR are just two
 * more ways to reach the SAME money, so each one is stored as an ordinary
 * `payments` row with the instrument's id in providerOrderId. When the webhook
 * lands, applyGatewayEvent matches that id, moves the row to CAPTURED, writes
 * the ledger entry and (when there is a booking) moves its advancePaid /
 * balanceDue — all code that already exists and is already tested.
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
const { ApiError, paginated } = require('../utils/helpers');
const paymentProvider = require('./providers/payment.provider');
const audit = require('./audit.service');
const whatsapp = require('./whatsapp.service');
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
 * What to charge against a BOOKING.
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

/**
 * What to charge with NO booking.
 *
 * Required, and uncapped — there is no outstanding figure to cap it against.
 * That makes it the one number in this file nothing can cross-check, so the
 * validator holds it to two decimals and a sane ceiling, and the audit entry
 * records who typed it. An admin asking for ₹45,000 instead of ₹4,500 is a
 * mistake only a human can catch, and the trail is what lets them.
 */
function resolveStandaloneAmount(requested) {
  if (requested == null) {
    throw ApiError.badRequest(
      'An amount is required when there is no booking to take it from',
      'AMOUNT_REQUIRED',
    );
  }
  const asked = M.round2(requested);
  if (!M.isPositive(asked)) {
    throw ApiError.badRequest('Amount must be greater than zero', 'INVALID_AMOUNT');
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

/**
 * The payer for a standalone collection: whatever the admin typed.
 *
 * The phone is MANDATORY and normalised to ten Indian digits here, not in Zod,
 * because the same normalisation has to hold for the wa.me target, Razorpay's
 * SMS delivery and the payer_phone column — three consumers that must agree on
 * what "the customer's number" is. A row whose phone is stored as typed and
 * shared as normalised is a row nobody can search for.
 */
function standalonePayer(payload) {
  const phone = whatsapp.waNumber(payload.customerPhone);
  if (!phone) {
    throw ApiError.badRequest(
      'A valid 10-digit Indian mobile number is required',
      'INVALID_PHONE',
    );
  }
  return {
    // Stored and sent without the country code, matching how every other
    // phone in this system is held (users.phone, bookings.guestPhone).
    phone: phone.slice(-10),
    name: payload.customerName?.trim() || null,
    email: payload.customerEmail?.trim() || null,
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
 * rather than tidy: two live links for the same ask means two ways to pay it,
 * and a customer who pays the older one leaves a captured payment the admin is
 * not watching. The admin cancels explicitly when they want a fresh one.
 *
 * Amount is part of the match because a repriced booking SHOULD get a new
 * link — the old one would collect the wrong figure.
 *
 * For a standalone collection the match is on the PHONE instead of a booking.
 * It is the only identifier a customer who is not in the system yet has, and
 * the double-click it defends against is the common one: an admin who did not
 * see the first link appear.
 */
async function findReusable({ bookingId, payerPhone, collectionType, amount }) {
  const open = await prisma.payment.findFirst({
    where: {
      ...(bookingId ? { bookingId } : { bookingId: null, payerPhone }),
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

/**
 * The one creation path, for all four combinations of
 * {LINK, QR} x {booking-scoped, standalone}.
 *
 * `booking` is null for a standalone collection, and everything that differs
 * follows from that single fact: where the amount came from, who the payer is,
 * what the reference and description say.
 */
async function create({
  collectionType,
  booking,
  payer,
  amount,
  purpose,
  payload,
  actor,
  meta,
}) {
  const isLink = collectionType === COLLECTION_TYPE.LINK;

  if (!M.isPositive(amount)) {
    throw ApiError.badRequest(
      booking ? 'Nothing is outstanding on this booking' : 'Amount must be greater than zero',
      booking ? 'NOTHING_TO_CHARGE' : 'INVALID_AMOUNT',
    );
  }

  const reuse = await findReusable({
    bookingId: booking?.id || null,
    payerPhone: payer.phone,
    collectionType,
    amount,
  });
  if (reuse) {
    return { payment: await decorate(reuse, booking), reused: true, whatsapp: null };
  }

  const expiresAt = resolveExpiry(
    payload.expiresInHours,
    payload.expiresAt,
    isLink ? DEFAULT_LINK_HOURS : DEFAULT_QR_HOURS,
  );
  const provider = paymentProvider.getProvider();

  /*
   * What the customer sees on the hosted page, and what goes in the WhatsApp
   * message. Resolved here rather than left to the provider's own fallback,
   * which interpolates a bookingId that does not exist on a standalone
   * collection and renders as "Trip undefined".
   */
  const description =
    payload.description?.trim() ||
    (booking ? `AbhiCabs trip ${booking.bookingNumber}` : 'AbhiCabs payment');

  let instrument;
  if (isLink) {
    /*
     * reference_id must be unique per link across the whole Razorpay account,
     * and a booking can legitimately need a second one — the first expired, or
     * the fare changed. Suffixing with the timestamp keeps the booking number
     * searchable in their dashboard (which is the point) while never
     * colliding. A standalone link has no booking number, so it carries the
     * payer's last four digits instead — the next best thing staff can search
     * for when a customer calls about "the link you sent me".
     */
    const stem = booking ? booking.bookingNumber : `ADHOC-${payer.phone.slice(-4)}`;
    const referenceId = `${stem}-${Date.now().toString(36)}`;

    instrument = await provider.createPaymentLink({
      amount: M.toStr(amount),
      currency: 'INR',
      bookingId: booking?.id || null,
      purpose,
      referenceId,
      description,
      customer: payer,
      // Default ON. A link nobody is told about is not a collection method, and
      // Razorpay's own delivery is the only transactional channel available here.
      notifyBySms: payload.notifyBySms !== false,
      notifyByEmail: payload.notifyByEmail !== false,
      expireBy: expiresAt,
    });
  } else {
    instrument = await provider.createQrCode({
      amount: M.toStr(amount),
      bookingId: booking?.id || null,
      purpose,
      description,
      closeBy: expiresAt,
    });
  }

  const { payment } = await persist({
    booking,
    payer,
    description,
    provider,
    instrument,
    collectionType,
    purpose,
    amount,
    expiresAt,
    actor,
    meta,
    auditAction: isLink ? 'PAYMENT_LINK_CREATED' : 'PAYMENT_QR_CREATED',
    auditExtra: isLink ? { notifiedSms: payload.notifyBySms !== false } : {},
  });

  /*
   * The WhatsApp share, composed in the same response that created the link.
   *
   * Two reasons it is not a second request. The admin's intent — "send this
   * person a payment link on WhatsApp" — is one act, and splitting it means a
   * created link that nobody sent whenever the second call is forgotten or
   * fails. And `sendWhatsApp` is opt-in rather than default-on, because the
   * bot path delivers a message to a real person's phone, and that must never
   * be a side effect of a field the admin did not set.
   */
  const share = await shareFor(payment, booking, { send: payload.sendWhatsApp === true });

  if (share?.sent) {
    audit.recordAsync({
      actor,
      action: 'PAYMENT_LINK_WHATSAPP_SENT',
      entityType: 'payment',
      entityId: payment.id,
      after: { to: whatsapp.maskPhone(payer.phone), collectionType, via: 'bot' },
      meta,
    });
  }

  return {
    payment: { ...(await decorate(payment, booking)) },
    reused: false,
    whatsapp: share,
  };
}

/** Booking-scoped payment link. Amount derived from the booking unless given. */
async function createLink(bookingId, payload = {}, actor, meta = {}) {
  requireCapability('createPaymentLink', 'Payment links');

  const booking = await loadBooking(bookingId);
  const purpose = payload.purpose || PAYMENT_PURPOSE.BALANCE;

  return create({
    collectionType: COLLECTION_TYPE.LINK,
    booking,
    payer: payerFor(booking),
    amount: resolveAmount(booking, purpose, payload.amount),
    purpose,
    payload,
    actor,
    meta,
  });
}

/** Booking-scoped UPI QR. */
async function createQr(bookingId, payload = {}, actor, meta = {}) {
  requireCapability('createQrCode', 'UPI QR codes');

  const booking = await loadBooking(bookingId);
  const purpose = payload.purpose || PAYMENT_PURPOSE.BALANCE;

  return create({
    collectionType: COLLECTION_TYPE.QR,
    booking,
    payer: payerFor(booking),
    amount: resolveAmount(booking, purpose, payload.amount),
    purpose,
    payload,
    actor,
    meta,
  });
}

/**
 * A payment link with NO booking behind it.
 *
 * purpose is forced to FULL and is not accepted from the caller. ADVANCE and
 * BALANCE describe a position against a fare — "part of it", "the rest of it"
 * — and there is no fare here for either word to mean anything against. A
 * standalone collection is the whole of what is being asked, and labelling it
 * BALANCE would put a meaningless BALANCE_RECEIVED row in the ledger.
 */
async function createStandaloneLink(payload = {}, actor, meta = {}) {
  requireCapability('createPaymentLink', 'Payment links');

  return create({
    collectionType: COLLECTION_TYPE.LINK,
    booking: null,
    payer: standalonePayer(payload),
    amount: resolveStandaloneAmount(payload.amount),
    purpose: PAYMENT_PURPOSE.FULL,
    payload,
    actor,
    meta,
  });
}

/** A UPI QR with no booking behind it. */
async function createStandaloneQr(payload = {}, actor, meta = {}) {
  requireCapability('createQrCode', 'UPI QR codes');

  return create({
    collectionType: COLLECTION_TYPE.QR,
    booking: null,
    payer: standalonePayer(payload),
    amount: resolveStandaloneAmount(payload.amount),
    purpose: PAYMENT_PURPOSE.FULL,
    payload,
    actor,
    meta,
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
  payer,
  description,
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
        bookingId: booking?.id || null,
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
        /*
         * Stored on BOTH kinds, not only standalone.
         *
         * A booking-scoped row could derive the payer by joining, so writing
         * it looks redundant — until the question is "which number did we
         * actually send this to?" six weeks later, after the customer updated
         * their profile. The payer is a fact about the instrument at the
         * moment it was raised, so it is recorded with it.
         */
        payerName: payer.name,
        payerPhone: payer.phone,
        payerEmail: payer.email,
        description,
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
      bookingId: booking?.id || null,
      bookingNumber: booking?.bookingNumber || null,
      standalone: !booking,
      purpose,
      amount: M.toStr(amount),
      collectionType,
      providerOrderId: instrument.id,
      expiresAt: payment.expiresAt,
      // Masked, never full. An audit log is read by more people than the
      // payments table, and a customer's number has no business being in it.
      payer: whatsapp.maskPhone(payer.phone),
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
 * Sharing on WhatsApp
 * ------------------------------------------------------------------ */

/**
 * Builds (and optionally sends) the WhatsApp message for one payment row.
 *
 * Returns null when there is no shareable instrument — a cash payment, a
 * checkout order, or a link whose gateway response carried no URL. Callers
 * treat null as "nothing to share" rather than an error, because an admin
 * looking at a row that cannot be shared is a UI question, not a failure.
 */
async function shareFor(payment, booking = null, { send = false, phoneOverride = null } = {}) {
  if (!payment.shareUrl) return null;

  const phone = phoneOverride || payment.payerPhone;
  if (!phone) return null;

  return whatsapp.sharePaymentLink({
    phone,
    payerName: payment.payerName,
    amount: M.toStr(M.round2(payment.amount)),
    description: payment.description,
    shareUrl: payment.shareUrl,
    expiresAt: payment.expiresAt,
    isQr: payment.collectionType === COLLECTION_TYPE.QR,
    bookingNumber: booking?.bookingNumber || null,
    send,
  });
}

/**
 * The explicit "send this on WhatsApp" action, for an instrument that already
 * exists.
 *
 * Distinct from `resend`, and the distinction matters: resend asks RAZORPAY to
 * deliver the link again over SMS or email, while this one goes out from us —
 * either through our own bot, or as a deep link the admin taps. A customer who
 * ignored an SMS from a shortcode will open a WhatsApp message from the number
 * they booked through.
 *
 * `phone` may override the stored payer, for the ordinary case of a number
 * typed wrong the first time. It is NOT written back to the row: the stored
 * payer records who the instrument was raised for, and quietly editing it
 * would destroy the only evidence of the original mistake. The override goes
 * in the audit entry instead.
 */
async function shareOnWhatsApp(paymentId, { phone = null, send = false } = {}, actor, meta = {}) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { ...PAYMENT_SELECT, booking: { select: { bookingNumber: true } } },
  });
  if (!payment) throw ApiError.notFound('Payment not found');

  if (!payment.shareUrl) {
    throw ApiError.badRequest(
      'This payment has no link or QR code to share',
      'NOT_SHAREABLE',
    );
  }
  if (!LIVE_STATUSES.includes(payment.status)) {
    throw ApiError.conflict(
      `This ${payment.collectionType === COLLECTION_TYPE.QR ? 'QR code' : 'link'} is ${payment.status}`,
      'NOT_SHAREABLE',
    );
  }
  if (payment.expiresAt && new Date(payment.expiresAt).getTime() < Date.now()) {
    throw ApiError.conflict('This has expired — create a new one', 'COLLECTION_EXPIRED');
  }

  const target = phone || payment.payerPhone;
  if (!whatsapp.waNumber(target)) {
    throw ApiError.badRequest(
      'No valid mobile number to share this with — pass one explicitly',
      'INVALID_PHONE',
    );
  }

  const share = await shareFor(payment, payment.booking, { send, phoneOverride: phone });

  audit.recordAsync({
    actor,
    action: share.sent ? 'PAYMENT_LINK_WHATSAPP_SENT' : 'PAYMENT_LINK_WHATSAPP_PREPARED',
    entityType: 'payment',
    entityId: paymentId,
    after: {
      to: whatsapp.maskPhone(target),
      overrode: Boolean(phone && whatsapp.waNumber(phone) !== whatsapp.waNumber(payment.payerPhone)),
      via: share.sent ? 'bot' : 'deep-link',
      reason: share.reason || null,
    },
    meta,
  });

  return {
    paymentId,
    /** Always present. The admin can tap this whether or not the bot sent it. */
    whatsappUrl: share.whatsappUrl,
    /** The exact text, so the UI can offer copy-to-clipboard as a third fallback. */
    message: share.message,
    sent: share.sent,
    reason: share.reason || null,
    canAutoSend: whatsapp.canSend(),
  };
}

/* ------------------------------------------------------------------ *
 * Read, cancel, resend
 * ------------------------------------------------------------------ */

/**
 * Adds the fields that are TRUE RIGHT NOW rather than stored.
 *
 * `expired` and `payable` are derived on every read, never written. The
 * gateway stops accepting payment the moment expires_at passes, but nothing
 * writes a row at that instant — a stored "expired" flag would be wrong for
 * however long it took a job to notice.
 */
async function decorate(payment, booking = null) {
  const now = Date.now();
  const expired =
    !!payment.expiresAt &&
    new Date(payment.expiresAt).getTime() < now &&
    LIVE_STATUSES.includes(payment.status);
  const payable =
    LIVE_STATUSES.includes(payment.status) &&
    (!payment.expiresAt || new Date(payment.expiresAt).getTime() > now);

  /*
   * The deep link is built for payable rows only, and is never SENT from here.
   * Building it is pure string work, so it costs nothing on a list; sending it
   * from a read would mean a customer receiving a WhatsApp message because an
   * admin opened a screen.
   */
  let whatsappUrl = null;
  if (payable && payment.shareUrl && payment.payerPhone) {
    const share = await shareFor(payment, booking, { send: false });
    whatsappUrl = share?.whatsappUrl || null;
  }

  return { ...payment, expired, payable, whatsappUrl, standalone: !payment.bookingId };
}

/** Every link and QR raised against a booking, newest first. */
async function listForBooking(bookingId) {
  const [booking, items] = await Promise.all([
    prisma.booking.findUnique({ where: { id: bookingId }, select: { bookingNumber: true } }),
    prisma.payment.findMany({
      where: {
        bookingId,
        collectionType: { in: [COLLECTION_TYPE.LINK, COLLECTION_TYPE.QR] },
      },
      orderBy: { createdAt: 'desc' },
      select: PAYMENT_SELECT,
    }),
  ]);

  return Promise.all(items.map((p) => decorate(p, booking)));
}

/**
 * Every collection, with a booking or without, for the admin payments screen.
 *
 * `scope` is the filter that matters: 'standalone' is the list of money asked
 * for outside the booking flow, which is exactly the set nobody can find any
 * other way — a booking-scoped link is reachable from its booking, and these
 * are reachable from nowhere else.
 */
async function listCollections({
  page = 1,
  limit = 20,
  scope = 'all',
  collectionType,
  status,
  phone,
  from,
  to,
} = {}) {
  const where = {
    collectionType: collectionType
      ? collectionType
      : { in: [COLLECTION_TYPE.LINK, COLLECTION_TYPE.QR] },
  };

  if (scope === 'standalone') where.bookingId = null;
  if (scope === 'booking') where.bookingId = { not: null };
  if (status) where.status = status;

  if (phone) {
    const normalised = whatsapp.waNumber(phone);
    /*
     * An unparseable number matches NOTHING rather than everything. Falling
     * back to "no filter" on a bad search term shows the admin the whole table
     * and lets them believe it is the result for what they typed.
     */
    where.payerPhone = normalised ? normalised.slice(-10) : '__no_match__';
  }

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lt = to;
  }

  const [total, items] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        ...PAYMENT_SELECT,
        booking: { select: { bookingNumber: true, status: true } },
      },
    }),
  ]);

  const decorated = await Promise.all(items.map((p) => decorate(p, p.booking)));

  return paginated(decorated, { page, limit, total });
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
   * money is recorded. A status ranked above CAPTURED would have silently
   * discarded a real payment.
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
 * Asks Razorpay to send an existing link again, over SMS or email.
 *
 * A RESEND, not a new link — the customer may already have the first one open.
 * Links only; a QR is an image the admin shares themselves, and there is
 * nothing for the gateway to deliver. For WhatsApp use shareOnWhatsApp: this
 * route is the gateway's own delivery, which does not speak WhatsApp at all.
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
  createStandaloneLink,
  createStandaloneQr,
  listForBooking,
  listCollections,
  shareOnWhatsApp,
  cancel,
  resend,
  LIVE_STATUSES,
};