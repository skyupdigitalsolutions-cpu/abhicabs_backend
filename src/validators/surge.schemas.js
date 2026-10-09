'use strict';

/**
 * src/validators/surge.schemas.js
 */

const { z } = require('zod');

/**
 * The four tiers, most-served to least.
 *
 * Must match the AreaTier enum in schema.prisma. Adding one here without the
 * migration lets an admin save a tier the database will reject; adding it in
 * the migration without this silently refuses a tier that exists.
 */
const tier = z.enum(['METRO', 'DISTRICT', 'TALUKA', 'VILLAGE']);

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

/**
 * A named place and how far around it counts.
 *
 * radiusKm is capped at 200: a larger circle is not a place, it is a region,
 * and it would swallow every smaller area inside it. The nearest-centre
 * tie-break protects against that, but a 500 km "village" is a data-entry
 * error worth rejecting outright.
 */
const areaFields = {
  name: z.string().trim().min(2).max(80),
  tier,
  /*
   * OPTIONAL, because the map supplies them.
   *
   * An admin types "Ramanagara, Karnataka" and the backend geocodes it: the
   * centre is geography the map knows exactly, and the radius is derived from
   * the place's own boundary and then widened to cover any airport or service
   * area that would otherwise fall outside.
   *
   * Supplying either overrides the map for that field — usually because the
   * admin knows something it does not, like a depot serving past the town
   * limits.
   */
  centreLat: latitude,
  centreLng: longitude,
  radiusKm: z.coerce.number().int().min(1).max(200),
  /** Helps the geocoder disambiguate. Two states have a Ramanagara. */
  state: z.string().trim().min(2).max(80).optional(),
  note: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
};

const createAreaSchema = z.object({
  ...Object.fromEntries(Object.entries(areaFields).map(([k, v]) => [k, v.optional()])),
  // Only these two are genuinely required; everything else the map can answer.
  name: areaFields.name,
  tier: areaFields.tier,
});

/** GET /areas/suggest?name=Ramanagara&state=Karnataka */
const suggestQuerySchema = z.object({
  name: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80).optional(),
});

const updateAreaSchema = z
  .object(
    Object.fromEntries(Object.entries(areaFields).map(([k, v]) => [k, v.optional()])),
  )
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/**
 * The commercial numbers.
 *
 * Percentages are capped at 100. The engine also clamps the final multiplier
 * to each rate card's minSurge/maxSurge — MVAG limits dynamic pricing — so a
 * value accepted here can still be reduced at quote time. That is deliberate:
 * the legal ceiling belongs with the fare, not with the urgency rule.
 */
const updateRuleSchema = z
  .object({
    /*
     * The short-notice window, in minutes. 1440 = 24 hours.
     *
     * The ceiling matters: a window longer than a day would make every
     * scheduled booking "immediate" and quietly retire the standing
     * percentage, which is a surcharge nobody would be able to account for.
     * 60 in a metro, 240 (four hours) elsewhere — see surge.service.
     */
    immediateWithinMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    immediatePct: z.coerce.number().min(0).max(100).optional(),
    standardPct: z.coerce.number().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/* ------------------------------------------------------------------ *
 * Route surge — a premium on one corridor, for one window
 * ------------------------------------------------------------------ */

/**
 * An ISO timestamp, or null to leave that end of the window open.
 *
 * Coerced to a Date here so the service compares dates to dates. A string
 * comparison against a Date silently produces NaN and a window that matches
 * nothing, which would look like a rule that simply does not work.
 */
const windowEdge = z.coerce.date().nullable().optional();

const routeFields = {
  name: z.string().trim().min(2).max(80),

  originLat: latitude,
  originLng: longitude,
  /*
   * Capped at 200 km, like an area radius, and for the same reason: beyond
   * that it is not a corridor endpoint, it is half the state, and it will
   * match journeys nobody intended. Bengaluru needs about 60 to reach from
   * Whitefield to Electronic City; Mysuru needs about 20.
   */
  originRadiusKm: z.coerce.number().int().min(1).max(200),
  originLabel: z.string().trim().max(80).nullable().optional(),

  destLat: latitude,
  destLng: longitude,
  destRadiusKm: z.coerce.number().int().min(1).max(200),
  destLabel: z.string().trim().max(80).nullable().optional(),

  bidirectional: z.boolean().optional(),

  /*
   * 0–100. Capped at 100 rather than left open because this is a PERCENTAGE
   * ADDED, so 100 already means double the fare, and the rate card's maxSurge
   * (2.00 by default) would clamp anything past it anyway. A rule that cannot
   * take effect is worse than one that is refused at entry.
   */
  pct: z.coerce.number().min(0).max(100),

  startsAt: windowEdge,
  endsAt: windowEdge,
  note: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
};

/**
 * A window that ends before it starts matches nothing, so it is always a
 * mistake — usually a year typed wrong. Caught here as well as by the CHECK
 * constraint, because the admin should see "End must be after start" rather
 * than a database error.
 */
const windowOrder = (v) =>
  !v.startsAt || !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt);
const windowOrderMessage = { message: 'The end of the window must be after its start' };

const createRouteSchema = z
  .object({
    ...Object.fromEntries(Object.entries(routeFields).map(([k, v]) => [k, v.optional()])),
    // The corridor and the premium are the rule. Everything else has a
    // sensible default or is genuinely optional.
    name: routeFields.name,
    originLat: routeFields.originLat,
    originLng: routeFields.originLng,
    destLat: routeFields.destLat,
    destLng: routeFields.destLng,
    pct: routeFields.pct,
  })
  .refine(windowOrder, windowOrderMessage);

const updateRouteSchema = z
  .object(Object.fromEntries(Object.entries(routeFields).map(([k, v]) => [k, v.optional()])))
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine(windowOrder, windowOrderMessage);

/**
 * Try a real trip against the configured corridors WITHOUT quoting it.
 *
 * The admin equivalent of /areas/classify, and it exists for the same reason:
 * two circles and a date window are hard to hold in your head, and an admin
 * adding a Dussehra rule needs to confirm it catches Jayanagar to Mysuru
 * Palace on the 2nd and does not catch Jayanagar to the airport on the 20th.
 * Finding that out by booking a test trip is a poor substitute.
 */
const previewRouteQuerySchema = z.object({
  pickupLat: latitude,
  pickupLng: longitude,
  dropLat: latitude,
  dropLng: longitude,
  /** Defaults to now, which answers "would this apply to a trip today?". */
  pickupAt: z.coerce.date().optional(),
});

const listRoutesQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const tierParamSchema = z.object({ tier });

/** Try a coordinate against the configured areas without creating anything. */
const classifyQuerySchema = z.object({ lat: latitude, lng: longitude });

module.exports = {
  createRouteSchema,
  updateRouteSchema,
  previewRouteQuerySchema,
  listRoutesQuerySchema,
  createAreaSchema,
  updateAreaSchema,
  updateRuleSchema,
  idParamSchema,
  tierParamSchema,
  classifyQuerySchema,
  suggestQuerySchema,
};