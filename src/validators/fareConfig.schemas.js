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
const SCOPES = ['CITY', 'STATE'];

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
const scope = z.enum(SCOPES);
const stateName = z.string().trim().min(2).max(80);

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

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
 * SCOPE: one card prices one city, or a whole state.
 *
 * The admin form sends either:
 *   { scope: 'CITY',  cityId: 3, ... }
 *   { scope: 'STATE', state: 'Karnataka', ... }    <- the "All cities" option
 *
 * `scope` defaults to CITY so an older admin build that only ever sent cityId
 * keeps working untouched.
 *
 * The two shapes are mutually exclusive and the refinement below enforces it
 * rather than quietly ignoring the surplus field. A body carrying BOTH is not
 * a harmless extra key — it is an admin who thinks they are scoping to
 * Bengaluru and a payload that prices all of Karnataka, and the difference is
 * invisible once saved.
 */
function scopeIsCoherent(v, ctx) {
  const s = v.scope || 'CITY';

  if (s === 'STATE') {
    if (!v.state) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'Choose a state when the card applies to all cities',
      });
    }
    if (v.cityId != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cityId'],
        message: 'A statewide card cannot also name a city — remove the city, or set scope to CITY',
      });
    }
    return;
  }

  if (v.cityId == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cityId'],
      message: 'Choose a city, or set scope to STATE to price every city in a state',
    });
  }
}

function surgeBandIsSane(v, ctx) {
  if (v.minSurge != null && v.maxSurge != null && v.minSurge > v.maxSurge) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minSurge'],
      message: 'Minimum surge cannot be above maximum surge',
    });
  }
}

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
    scope: scope.optional(),
    cityId: z.coerce.number().int().positive().optional(),
    state: stateName.optional(),
    vehicleClass,
    tripType,
    perKm: money,
  })
  .superRefine(scopeIsCoherent)
  .superRefine(surgeBandIsSane);

/**
 * scope / cityId / state / vehicleClass / tripType are NOT updatable. Those
 * plus effectiveFrom are the unique key, and widening a Bengaluru card into a
 * Karnataka one in place would reprice twenty cities from a form headed
 * "Bengaluru". Clone to the new scope and retire the old card instead.
 */
const updateSchema = z
  .object(optionalFields)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .superRefine(surgeBandIsSane);

const listQuerySchema = z.object({
  cityId: z.coerce.number().int().positive().optional(),
  state: stateName.optional(),
  scope: scope.optional(),
  vehicleClass: vehicleClass.optional(),
  tripType: tripType.optional(),
  search: z.string().trim().max(64).optional(),
  includeInactive: boolish.optional(),
  /**
   * With a cityId filter, show the statewide cards that cover it as well.
   *
   * Defaults TRUE. The question an admin asks of a city filter is "what does
   * this city cost?", and on a state-priced network the honest answer includes
   * the card doing the pricing. Set false for "what does this city override?".
   */
  includeStatewide: boolish.optional().default(true),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sortBy: z.enum(['effectiveFrom', 'createdAt', 'vehicleClass', 'tripType']).default('effectiveFrom'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const cityIdParamSchema = z.object({ cityId: z.coerce.number().int().positive() });

const listCitiesQuerySchema = z.object({ includeInactive: boolish.optional() });

/**
 * DELETE /:id/permanent — `force` overrides the "this would leave cities
 * unable to quote" refusal.
 *
 * Opt-in and explicit, never a default. The service names the affected cities
 * in the 400 it throws without it, so an admin who passes force has been told
 * precisely what they are turning off.
 */
const deleteQuerySchema = z.object({ force: boolish.optional() });

/** POST /:id/clone — copy a card onto another class, city, state or date. */
const cloneSchema = z
  .object({
    scope: scope.optional(),
    cityId: z.coerce.number().int().positive().optional(),
    state: stateName.optional(),
    vehicleClass: vehicleClass.optional(),
    tripType: tripType.optional(),
    effectiveFrom: z.coerce.date().optional(),
  })
  .refine((v) => !(v.cityId != null && v.state), {
    path: ['state'],
    message: 'Clone to a city or to a state, not both',
  });

module.exports = {
  TRIP_TYPES,
  SCOPES,
  createSchema,
  updateSchema,
  listQuerySchema,
  listCitiesQuerySchema,
  deleteQuerySchema,
  idParamSchema,
  cityIdParamSchema,
  cloneSchema,
};