'use strict';

/**
 * src/validators/payment.schemas.js
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const idParamSchema = z.object({ id: uuid });

const bookingIdParamSchema = z.object({ bookingId: uuid });

/** An empty multipart field is ABSENT, not zero. */
const blankToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/**
 * A whole-km odometer reading, from a multipart string.
 *
 * The blank-to-undefined step matters: z.coerce turns "" into 0, so a driver
 * app posting an empty field would otherwise record a reading of 0 km.
 */
const odometerReading = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({
      required_error: 'Enter the odometer reading',
      invalid_type_error: 'Odometer reading must be a number',
    })
    .int('Odometer reading must be a whole number of km')
    .min(0)
    .max(100000000),
);

/*
 * Driver submits the END odometer reading. Multipart: the photo arrives as
 * `photo` on req.file and is required — checked in the controller, since
 * multer does not put files on req.body.
 *
 * `photoUrl` is no longer accepted. A URL in the body is any image from
 * anywhere; the point of the photo is that the driver took it, of this
 * dashboard, now — which only an upload through this route shows.
 */
const odometerSubmitSchema = z.object({
  odometerKm: odometerReading,
});

/*
 * Driver completes the trip. Multipart (optional photo), so every field is a
 * string on the wire — coerced here. odometerKm is optional because the end
 * reading may already be on file from /odometer; the controller enforces
 * "photo and reading together, or neither".
 */
const optionalNumber = (inner) => z.preprocess(blankToUndefined, inner.optional());

const completeTripSchema = z.object({
  odometerKm: z.preprocess(blankToUndefined, odometerReading.optional()),
  actualKm: optionalNumber(z.coerce.number().min(0).max(100000)),
  finalFare: optionalNumber(z.coerce.number().min(0).max(9999999)),
  lat: optionalNumber(z.coerce.number().min(-90).max(90)),
  lng: optionalNumber(z.coerce.number().min(-180).max(180)),
});

/*
 * Driver starts the trip. Arrives as multipart/form-data (the odometer photo
 * travels as `photo`), so every field is a STRING on the wire — hence
 * z.coerce throughout. The photo itself is checked in the controller:
 * multer puts it on req.file, not req.body.
 */
const startTripSchema = z
  .object({
    otp: z.string().trim().max(8).optional(),
    startOtp: z.string().trim().max(8).optional(),
    odometerKm: odometerReading,
    // optionalNumber, not z.coerce.number().optional(): coerce turns a blank
    // multipart field into 0, which would record the start at 0°N 0°E.
    lat: optionalNumber(z.coerce.number().min(-90).max(90)),
    lng: optionalNumber(z.coerce.number().min(-180).max(180)),
  })
  .refine((v) => !!(v.otp || v.startOtp), {
    message: 'Enter the start code from the rider',
    path: ['otp'],
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
  startTripSchema,
  completeTripSchema,
  listInvoicesQuerySchema,
  idParamSchema,
  bookingIdParamSchema,
  odometerSubmitSchema,
  providerParamSchema,
  createOrderSchema,
  simulateWebhookSchema,
};