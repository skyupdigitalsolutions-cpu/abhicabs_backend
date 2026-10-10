'use strict';

/**
 * src/validators/adminPayment.schemas.js
 *
 * Business-wide payments listing. The existing payment.schemas.js stays as-is
 * (booking-scoped views); this adds only the admin list query. from / to filter
 * on createdAt and are inclusive of `from`, exclusive of `to`.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const PAYMENT_STATUSES = ['CREATED', 'AUTHORISED', 'CAPTURED', 'PARTIALLY_PAID', 'FAILED', 'REFUNDED'];
const PAYMENT_METHODS = ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'CASH'];

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
 * NOTE WHAT `amount` IS FOR. It is optional, and omitting it is the normal
 * case: the service derives the figure from the booking's own balanceDue, so
 * an admin cannot mistype a fare. It is accepted at all because ops genuinely
 * need a part payment sometimes — and it is CAPPED at what is outstanding in
 * the service, since an overpayment has no automatic refund path to undo it.
 * ------------------------------------------------------------------ */

/** Rupees, as a string or number, max two decimal places. */
const money = z
  .union([z.string(), z.number()])
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), {
    message: 'Amount must be a positive number with at most 2 decimal places',
  });

const collectionPurpose = z.enum(['ADVANCE', 'BALANCE', 'FULL']).default('BALANCE');

const expiryFields = {
  /** Hours from now. Ignored when `expiresAt` is given. */
  expiresInHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  /** An explicit instant, when ops wants the link dead at a known time. */
  expiresAt: z.coerce.date().optional(),
};

const createLinkSchema = z.object({
  purpose: collectionPurpose,
  amount: money.optional(),
  description: z.string().trim().max(500).optional(),
  // Default true in the service, not here: an absent field must mean "send it",
  // and a zod default of true would be indistinguishable from an explicit one.
  notifyBySms: z.boolean().optional(),
  notifyByEmail: z.boolean().optional(),
  ...expiryFields,
});

const createQrSchema = z.object({
  purpose: collectionPurpose,
  amount: money.optional(),
  description: z.string().trim().max(500).optional(),
  ...expiryFields,
});

const resendSchema = z.object({
  medium: z.enum(['sms', 'email']).default('sms'),
});

const bookingIdParamSchema = z.object({ bookingId: uuid });
const paymentIdParamSchema = z.object({ id: uuid });

module.exports = {
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  listPaymentsQuerySchema,
  createLinkSchema,
  createQrSchema,
  resendSchema,
  bookingIdParamSchema,
  paymentIdParamSchema,
};