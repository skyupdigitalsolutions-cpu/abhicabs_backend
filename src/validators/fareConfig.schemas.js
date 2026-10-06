'use strict';

/**
 * src/validators/fareConfig.schemas.js
 *
 * Validation for the admin rate-card editor (/api/v1/admin/fare-configs).
 *
 * Every money field is coerced from a string, because an HTML number input
 * hands you "450" and not 450. Coercing here means the service never has to
 * wonder which it got.
 *
 * NOTE ON THE RETIRED FIELDS — baseFare, minimumFare and returnEmptyPct are
 * all deliberately absent from this file.
 *
 * Each was retired from the product but kept as a zeroed column, because all
 * three are part of the configSnapshot frozen onto every past booking's
 * fareBasis and dropping them would break that read path. The fare engine
 * freezes literal zeroes rather than reading them.
 *
 * Since no key of those names is declared below and Zod strips unknown keys, a
 * stray value sent by an older admin build is silently dropped and the column
 * keeps its default of 0. There is no longer any way to write a base fare, a
 * rupee minimum or a return-leg percentage through the admin API, which is the
 * intent — the last of those in particular, since an admin setting
 * returnEmptyPct back to 100 would double every one-way fare from a field that
 * no longer appears anywhere on the rate card.
 *
 * What replaced them: the distance floor is `minimumKm`, and the empty return
 * is priced into the ONE_WAY `perKm` rate.
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
  perKm: money,
  perMinute: money,

  /**
   * The minimum BILLABLE DISTANCE, in kilometres. 0 = no floor.
   *
   * This replaced `minimumFare`, which is absent from this file for the same
   * reason `baseFare` is: the column survives for the frozen fareBasis on past
   * bookings, the engine no longer reads it, and since no key of that name is
   * declared here Zod strips a stray one sent by an older admin build. There
   * is no longer any way to write a rupee floor through the admin API.
   *
   * `returnEmptyPct` is gone for the same reason — the empty return is priced
   * into the ONE_WAY per-km rate now, and an admin who could still set that
   * percentage could silently double every one-way fare from a field whose
   * effect is invisible on the rate card.
   *
   * NO UPPER BOUND. This used to be capped at 500 km, justified by
   * MAX_TRIP_KM — the 1500 km router cap, which no longer exists now that a
   * trip may run as far as India allows. With the trip itself uncapped, a
   * ceiling on the floor is arbitrary: there is no length of trip the engine
   * will refuse, so there is no length of minimum that is self-evidently a
   * typo. An admin setting 800 km on an intercity-only rate card is making a
   * commercial decision, and the schema has no basis for overruling it.
   *
   * Still `.min(0)`: a negative floor is meaningless, and 0 remains the way to
   * say "no floor at all", which is the default.
   *
   * What this does NOT change is the floor's effect. billableKm is still
   * max(actualKm, minimumKm, minKmPerDay x days) in fare.service, so a large
   * value here still bills every short hop on that card as though it ran the
   * full distance. That is the point of the field; it is now simply trusted
   * rather than second-guessed.
   */
  minimumKm: z.coerce.number().min(0),

  cancellationFee: money,

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
 * perKm is the only rate a card cannot do without — it is what the distance
 * leg is priced from, and the column is NOT NULL with no default. Everything
 * else defaults to 0, which reads as "this rule is off".
 *
 * minimumKm is OPTIONAL. Omitting it means "no distance floor", which is the
 * right default for a new card — a floor is a deliberate commercial decision,
 * not something a blank form should invent.
 */
const createSchema = z
  .object({
    /*
     * ORDER MATTERS. `optionalFields` is spread FIRST, with the required keys
     * declared after it.
     *
     * Spread last, it silently won: optionalFields contains an optional
     * `perKm` too, so it overwrote the required version above it and a rate
     * card with NO per-km rate passed validation. Prisma then rejected the
     * insert, since the column is NOT NULL with no default — a 500 where a 400
     * naming the missing field belonged.
     */
    ...optionalFields,
    cityId: z.coerce.number().int().positive(),
    vehicleClass,
    tripType,
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