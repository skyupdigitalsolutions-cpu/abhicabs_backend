'use strict';

/**
 * src/validators/adminPayment.schemas.js
 *
 * Business-wide payments listing, and the collection instruments an admin
 * raises by hand. The existing payment.schemas.js stays as-is (booking-scoped
 * views). `from` / `to` filter on createdAt and are inclusive of `from`,
 * exclusive of `to`.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const PAYMENT_STATUSES = ['CREATED', 'AUTHORISED', 'CAPTURED', 'PARTIALLY_PAID', 'FAILED', 'REFUNDED'];
const PAYMENT_METHODS = ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'CASH'];
const COLLECTION_TYPES = ['LINK', 'QR'];

const listPaymentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(PAYMENT_STATUSES).optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    bookingId: uuid.optional(),
    sortBy: z.enum(['createdAt', 'paidAt', 'amount']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((d) => !(d.from && d.to) || d.from <= d.to, {
    message: '`from` must be on or before `to`',
    path: ['from'],
  });

/* ------------------------------------------------------------------ *
 * Collection instruments
 *
 * NOTE WHAT `amount` IS FOR ON A BOOKING-SCOPED LINK. It is optional, and
 * omitting it is the normal case: the service derives the figure from the
 * booking's own balanceDue, so an admin cannot mistype a fare. It is accepted
 * at all because ops genuinely need a part payment sometimes — and it is
 * CAPPED at what is outstanding in the service, since an overpayment has no
 * automatic refund path to undo it.
 *
 * On a STANDALONE link it is required and uncapped, because there is no
 * booking to derive or cap it against. That is the whole difference between
 * the two schemas below.
 * ------------------------------------------------------------------ */

/** Rupees, as a string or number, max two decimal places. */
const money = z
  .union([z.string(), z.number()])
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), {
    message: 'Amount must be a positive number with at most 2 decimal places',
  });

/**
 * The same money rule with a ceiling, for the standalone case only.
 *
 * A booking-scoped amount is already bounded by the fare. A standalone one is
 * bounded by nothing, so this is the only thing standing between a slipped
 * keystroke and a customer being asked for ₹4,50,000. ₹2,00,000 is well above
 * any real fare and well below the range where a typo stops being obvious;
 * raise it when a legitimate collection actually hits it.
 */
const standaloneMoney = money.refine((v) => Number(v) <= 200000, {
  message: 'Amount above ₹2,00,000 — raise it through finance rather than a payment link',
});

/**
 * Any Indian mobile, however it is typed. Normalised to its ten digits in the
 * service (whatsapp.waNumber), not here, so the wa.me target, Razorpay's SMS
 * delivery and the stored column cannot disagree about what the number is.
 */
const phone = z
  .string()
  .trim()
  .refine((v) => /^[6-9]\d{9}$/.test(v.replace(/\D/g, '').slice(-10)), {
    message: 'Enter a valid 10-digit Indian mobile number',
  });

const collectionPurpose = z.enum(['ADVANCE', 'BALANCE', 'FULL']).default('BALANCE');

const expiryFields = {
  /** Hours from now. Ignored when `expiresAt` is given. */
  expiresInHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  /** An explicit instant, when ops wants the link dead at a known time. */
  expiresAt: z.coerce.date().optional(),
};

/**
 * Opt-in, never defaulted.
 *
 * When our WhatsApp bot is configured this actually delivers a message to a
 * real person's phone. A default of true would make that a side effect of a
 * field the admin did not set — and the deep link is returned either way, so
 * leaving it off costs them one tap, not the feature.
 */
const sendWhatsApp = z.boolean().optional();

const createLinkSchema = z.object({
  purpose: collectionPurpose,
  amount: money.optional(),
  description: z.string().trim().max(500).optional(),
  // Default true in the service, not here: an absent field must mean "send it",
  // and a zod default of true would be indistinguishable from an explicit one.
  notifyBySms: z.boolean().optional(),
  notifyByEmail: z.boolean().optional(),
  sendWhatsApp,
  ...expiryFields,
});

const createQrSchema = z.object({
  purpose: collectionPurpose,
  amount: money.optional(),
  description: z.string().trim().max(500).optional(),
  sendWhatsApp,
  ...expiryFields,
});

/* ------------------------------------------------------------------ *
 * Standalone: no booking id
 *
 * `purpose` is deliberately ABSENT. The service forces FULL, because ADVANCE
 * and BALANCE describe a position against a fare and there is no fare here for
 * either word to mean anything against. Accepting the field would let an admin
 * write a meaningless BALANCE_RECEIVED entry into the ledger.
 * ------------------------------------------------------------------ */

const standaloneBase = {
  amount: standaloneMoney,
  /** Required: Razorpay needs a contact to deliver to, and so does WhatsApp. */
  customerPhone: phone,
  customerName: z.string().trim().min(1).max(120).optional(),
  customerEmail: z.string().trim().email('Enter a valid email').max(160).optional(),
  /**
   * Strongly encouraged rather than required. A customer looking at a hosted
   * payment page with no explanation of what it is for is a customer who calls
   * support instead of paying — but an admin on the phone should not be
   * blocked from collecting because they have not typed a reason yet.
   */
  description: z.string().trim().max(500).optional(),
  sendWhatsApp,
  ...expiryFields,
};

const createStandaloneLinkSchema = z.object({
  ...standaloneBase,
  notifyBySms: z.boolean().optional(),
  notifyByEmail: z.boolean().optional(),
});

const createStandaloneQrSchema = z.object(standaloneBase);

/* ------------------------------------------------------------------ *
 * Sharing and listing
 * ------------------------------------------------------------------ */

const whatsappShareSchema = z.object({
  /**
   * Overrides the stored payer for this share only — the ordinary case of a
   * number typed wrong the first time. It is NOT written back to the payment:
   * the stored payer records who the instrument was raised for, and editing it
   * silently would destroy the evidence of the original mistake.
   */
  phone: phone.optional(),
  /** Attempt a real send through our bot. Falls back to the deep link. */
  send: z.boolean().default(false),
});

const listCollectionsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** 'standalone' is the set that is reachable from nowhere else. */
    scope: z.enum(['all', 'standalone', 'booking']).default('all'),
    collectionType: z.enum(COLLECTION_TYPES).optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    /** Partial numbers are not supported — it is matched as a full mobile. */
    phone: z.string().trim().min(4).max(20).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((d) => !(d.from && d.to) || d.from <= d.to, {
    message: '`from` must be on or before `to`',
    path: ['from'],
  });

const resendSchema = z.object({
  medium: z.enum(['sms', 'email']).default('sms'),
});

const bookingIdParamSchema = z.object({ bookingId: uuid });
const paymentIdParamSchema = z.object({ id: uuid });

module.exports = {
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  COLLECTION_TYPES,
  listPaymentsQuerySchema,
  listCollectionsQuerySchema,
  createLinkSchema,
  createQrSchema,
  createStandaloneLinkSchema,
  createStandaloneQrSchema,
  whatsappShareSchema,
  resendSchema,
  bookingIdParamSchema,
  paymentIdParamSchema,
};