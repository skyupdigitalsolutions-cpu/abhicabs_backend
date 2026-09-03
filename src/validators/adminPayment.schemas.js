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

module.exports = {
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  listPaymentsQuerySchema,
};