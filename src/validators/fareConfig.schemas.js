'use strict';

/**
 * src/validators/fareConfig.schemas.js
 *
 * Validation for the admin rate-card editor (/api/v1/admin/fare-configs).
 *
 * Every money field is coerced from a string, because an HTML number input
 * hands you "450" and not 450. Coercing here means the service never has to
 * wonder which it got.
 */

const { z } = require('zod');

const TRIP_TYPES = ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'];

/** Decimal(10,2) in the schema — reject anything that would not survive the round trip. */
const money = z.coerce.number().min(0).max(9_999_999.99);

/** Decimal(5,2) percentages. Capped at 100 rather than 999.99: a 400% night
 *  uplift is a typo, and the database would happily store it. */
const percent = z.coerce.number().min(0).max(100);

/** Decimal(4,2) surge multipliers. */
const multiplier = z.coerce.number().min(0.1).max(9.99);

const hour = z.coerce.number().int().min(0).max(23);
const minute = z.coerce.number().int().min(0).max(59);

const vehicleClass = z.string().trim().min(2).max(24);
const tripType = z.enum(TRIP_TYPES);

/**
 * The editable body, shared by create and update.
 *
 * Kept as a plain shape (not a ZodObject) so create can mark some keys required
 * and update can make every key optional without duplicating the list.
 */
const fields = {
  baseFare: money,
  perKm: money,
  perMinute: money,
  minimumFare: money,
  cancellationFee: money,

  returnEmptyPct: percent,

  minKmPerDay: z.coerce.number().int().min(0).max(2000),
  waitingPerHour: money,
  freeWaitingMin: z.coerce.number().int().min(0).max(600),

  driverAllowance: money,

  nightAllowance: money,
  nightChargePct: percent,
  nightStartHour: hour,
  nightStartMinute: minute,
  nightEndHour: hour,
  nightEndMinute: minute,

  airportSurcharge: money,

  hourlyRate: money,
  hourlyKmPerHour: z.coerce.number().int().min(1).max(200),

  maxSurge: multiplier,
  minSurge: multiplier,

  // Accepts an ISO string or a Date. Defaults to now() in the database, so a
  // card saved without one is live immediately; supply a future date to stage
  // a price change in advance.
  effectiveFrom: z.coerce.date(),

  isActive: z.boolean(),
};

const optionalFields = Object.fromEntries(
  Object.entries(fields).map(([k, v]) => [k, v.optional()]),
);

/**
 * A rate card is useless without a base and a per-km, so those two are
 * required.
 *
 * minimumFare is OPTIONAL. Omitting it means "no floor enforced", which the
 * engine already supported — fare.service reads `config.minimumFare ?? 0` —
 * but this schema demanded it, so the admin form's blank field produced a
 * 400 and the Create button looked dead. Everything else defaults to 0,
 * which reads as "this rule is off".
 */
const createSchema = z
  .object({
    /*
     * ORDER MATTERS. `optionalFields` is spread FIRST, with the required keys
     * declared after it.
     *
     * Spread last, it silently won: optionalFields contains an optional
     * `baseFare` and `perKm` too, so those overwrote the required versions
     * above them and a rate card with NO base fare and NO per-km rate passed
     * validation. Prisma then rejected the insert, since both columns are NOT
     * NULL with no default — a 500 where a 400 naming the missing field
     * belonged.
     */
    ...optionalFields,
    cityId: z.coerce.number().int().positive(),
    vehicleClass,
    tripType,
    baseFare: money,
    perKm: money,
  })
  .superRefine(surgeBandIsSane);

/**
 * cityId / vehicleClass / tripType are NOT updatable. Those three plus
 * effectiveFrom are the unique key: letting an edit move a card between cities
 * would silently retire the old city's pricing. Retire the row and create a new
 * one instead.
 */
const updateSchema = z
  .object(optionalFields)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .superRefine(surgeBandIsSane);

function surgeBandIsSane(v, ctx) {
  if (v.minSurge != null && v.maxSurge != null && v.minSurge > v.maxSurge) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minSurge'],
      message: 'Minimum surge cannot be above maximum surge',
    });
  }
}

const listQuerySchema = z.object({
  cityId: z.coerce.number().int().positive().optional(),
  vehicleClass: vehicleClass.optional(),
  tripType: tripType.optional(),
  search: z.string().trim().max(64).optional(),
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sortBy: z.enum(['effectiveFrom', 'createdAt', 'vehicleClass', 'tripType']).default('effectiveFrom'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const cityIdParamSchema = z.object({ cityId: z.coerce.number().int().positive() });

/** POST /:id/clone — copy a card onto another class or city, or forward in time. */
const cloneSchema = z.object({
  cityId: z.coerce.number().int().positive().optional(),
  vehicleClass: vehicleClass.optional(),
  tripType: tripType.optional(),
  effectiveFrom: z.coerce.date().optional(),
});

module.exports = {
  TRIP_TYPES,
  createSchema,
  updateSchema,
  listQuerySchema,
  idParamSchema,
  cityIdParamSchema,
  cloneSchema,
};