'use strict';

const { z } = require('zod');

const money = z.coerce.number().min(0).max(9_999_999.99);

/**
 * Codes are stored and compared UPPERCASE, and the transform happens here so
 * nothing downstream has to remember. Restricted to letters, digits, - and _:
 * a code with a space in it cannot be read out over the phone reliably.
 */
const code = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, digits, - or _');

const fields = {
  description: z.string().trim().min(3).max(200),
  type: z.enum(['PERCENT', 'FLAT']),
  value: money,
  maxDiscount: money.nullable().optional(),
  minFare: money.optional(),
  // NULL is unlimited — an empty field in the admin form.
  maxUses: z.coerce.number().int().min(1).nullable().optional(),
  maxUsesPerCustomer: z.coerce.number().int().min(1).max(100).optional(),
  appliesTo: z.enum(['ALL_BOOKINGS', 'FIRST_RIDE', 'CORPORATE', 'AIRPORT']).optional(),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
};

const optional = Object.fromEntries(
  Object.entries(fields).map(([k, v]) => [k, v.optional()]),
);

/**
 * Two rules the database cannot express, checked here.
 *
 *   A PERCENT value above 100 is a typo, not a promotion — and it would make
 *   the discount exceed the fare on every booking.
 *
 *   An expiry before the start means a code that can never be used. Better to
 *   refuse it than to let marketing print it on a poster.
 */
function sane(v, ctx) {
  if (v.type === 'PERCENT' && v.value != null && v.value > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'A percentage discount cannot exceed 100',
    });
  }
  if (v.startsAt && v.expiresAt && v.expiresAt <= v.startsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Expiry must be after the start date',
    });
  }
}

const createSchema = z
  .object({ ...optional, code, description: fields.description, type: fields.type, value: fields.value })
  .superRefine(sane);

/** `code` is absent: redemptions reference it, and renaming a live promo
 *  would orphan the ones already given out. Retire it and create a new one. */
const updateSchema = z
  .object(optional)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .superRefine(sane);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  search: z.string().trim().max(40).optional(),
});

/** What the rider's app sends to check a code against a live quote. */
const checkSchema = z.object({
  code,
  fareTotal: money,
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']).optional(),
});

module.exports = { createSchema, updateSchema, idParamSchema, listQuerySchema, checkSchema };