'use strict';

/**
 * src/validators/city.schemas.js
 *
 * Validation for the city admin endpoints (/api/v1/admin/cities).
 *
 * A city row is not just a label on a dropdown. It carries the two radii that
 * decide whether a pickup is reachable and whether a trip is "local", the
 * centre point those radii are measured from, and the state welfare levy. A
 * typo in any of them is a pricing or dispatch bug that nobody notices until a
 * rider is quoted the wrong fare — so the bounds here are deliberately tight.
 */

const { z } = require('zod');

/** cities.name / cities.state are VarChar(80). */
const name = z.string().trim().min(2).max(80);

/**
 * Coordinates. Decimal(10,7) in the schema, so seven decimal places survive —
 * roughly a centimetre, far more than a city centre needs.
 *
 * Bounded to the real world here; the India-specific sanity check (which is
 * what actually catches a swapped lat/lng) lives in the service, because it
 * depends on `country` and a cross-field rule reads better next to the data.
 */
const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

/**
 * Service REACH — how far out we will send a car from this centre.
 *
 * Capped at 500 km rather than left open. radiusKm feeds
 * quote.resolveOperatingCity, which picks the NEAREST city whose radius covers
 * the pickup; a city with a 5000 km radius would swallow every pickup in the
 * country and price all of them against this one rate card.
 */
const radiusKm = z.coerce.number().int().min(1).max(500);

/**
 * CITY LIMITS — a different question from radiusKm, and the one that is easy
 * to get wrong.
 *
 * This decides whether a drop counts as "same city", i.e. whether an outstation
 * booking gets downgraded to a local rental. The schema comment on City is
 * emphatic that it must be TIGHT: with a generous service radius doing the
 * reach job, a loose localRadiusKm makes every satellite town read as inside
 * the city. 200 is already generous for a city boundary.
 */
const localRadiusKm = z.coerce.number().int().min(1).max(200);

/**
 * Karnataka's gig-worker welfare levy, as a percentage. Decimal(4,2).
 *
 * Capped at 10 rather than the column's 99.99. The statutory band is 1-5%; a
 * number above 10 is a decimal-point slip, and this column is added to every
 * fare in the city, so the blast radius of accepting one is every quote.
 */
const welfareFeePct = z.coerce.number().min(0).max(10);

/** BCP-47-ish short codes. The column is a JSON array with a default. */
const languages = z.array(z.string().trim().min(2).max(8)).min(1).max(12);

/**
 * IANA zone name. Not an enum: India is one zone today, but the column exists
 * precisely so that is not baked in, and an enum here would have to be edited
 * to open a city anywhere else.
 */
const timezone = z.string().trim().min(3).max(48);

/** ISO 3166-1 alpha-2. Char(2) in the schema. */
const country = z.string().trim().length(2).toUpperCase();

const createSchema = z.object({
  name,
  state: name,
  district: z.string().trim().min(2).max(80).optional(),
  country: country.optional(),

  centreLat: latitude,
  centreLng: longitude,
  radiusKm: radiusKm.optional(),
  localRadiusKm: localRadiusKm.optional(),

  timezone: timezone.optional(),
  languages: languages.optional(),
  welfareFeePct: welfareFeePct.optional(),
  isActive: z.boolean().optional(),

  /**
   * Seed this city's rate cards and rental packages by copying an existing
   * city's.
   *
   * Optional, but close to essential in practice: a city with no rate cards
   * cannot quote anything, and building four trip types across every vehicle
   * class by hand is roughly twenty forms per city. See city.service.create.
   */
  copyFromCityId: z.coerce.number().int().positive().optional(),
});

const updateSchema = z
  .object({
    name: name.optional(),
    state: name.optional(),
    district: z.string().trim().min(2).max(80).nullable().optional(),
    country: country.optional(),

    centreLat: latitude.optional(),
    centreLng: longitude.optional(),
    radiusKm: radiusKm.optional(),
    localRadiusKm: localRadiusKm.optional(),

    timezone: timezone.optional(),
    languages: languages.optional(),
    welfareFeePct: welfareFeePct.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const listQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  /** Free text over name and district. */
  search: z.string().trim().min(1).max(80).optional(),
  /** Exact state filter, for "show me every Gujarat city". */
  state: z.string().trim().min(2).max(80).optional(),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

module.exports = { createSchema, updateSchema, listQuerySchema, idParamSchema };