'use strict';

/**
 * src/validators/payment.schemas.js
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const idParamSchema = z.object({ id: uuid });

const bookingIdParamSchema = z.object({ bookingId: uuid });

// Driver submits the final odometer reading after the trip. photoUrl optional
// (odometer-photo upload is a separate feature; when present it's a stored ref).
const odometerSubmitSchema = z.object({
  odometerKm: z.coerce.number().int().min(0).max(100000000),
  photoUrl: z.string().trim().max(500).url().optional(),
});

const providerParamSchema = z.object({
  provider: z.enum(['mock', 'razorpay']),
});

const createOrderSchema = z.object({
  bookingId: uuid,
  purpose: z.enum(['ADVANCE', 'BALANCE', 'FULL']),
});

/**
 * Body for the mock-only test helper that builds and dispatches a signed
 * webhook. eventId is what makes replay testable: send the same eventId twice
 * and the second call must be a no-op.
 */
const simulateWebhookSchema = z.object({
  eventId: z.string().min(1).max(160),
  status: z.enum(['captured', 'authorized', 'failed']).default('captured'),
  amount: z.union([z.number(), z.string()]).optional(),
});

/**
 * GET /admin/invoices query.
 *
 * Every filter is optional: the screen's first render passes nothing and
 * expects the most recent invoices back, not an error.
 */
const listInvoicesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['DRAFT', 'ISSUED', 'PAID', 'CANCELLED']).optional(),
  type: z.enum(['TAX', 'NON_TAX']).optional(),
  // Useful for isolating the DEMO series from real invoices.
  series: z.string().trim().max(8).optional(),
  customerId: z.string().uuid().optional(),
  corporateAccountId: z.string().uuid().optional(),
  search: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

module.exports = {
  listInvoicesQuerySchema,
  idParamSchema,
  bookingIdParamSchema,
  odometerSubmitSchema,
  providerParamSchema,
  createOrderSchema,
  simulateWebhookSchema,
};