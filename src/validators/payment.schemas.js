'use strict';

/**
 * src/validators/payment.schemas.js
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const idParamSchema = z.object({ id: uuid });

const bookingIdParamSchema = z.object({ bookingId: uuid });

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

module.exports = {
  idParamSchema,
  bookingIdParamSchema,
  providerParamSchema,
  createOrderSchema,
  simulateWebhookSchema,
};