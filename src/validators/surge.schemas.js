'use strict';

/**
 * src/validators/surge.schemas.js
 */

const { z } = require('zod');

const tier = z.enum(['METRO', 'TALUKA', 'VILLAGE']);

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
    immediateWithinMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    immediatePct: z.coerce.number().min(0).max(100).optional(),
    standardPct: z.coerce.number().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const tierParamSchema = z.object({ tier });

/** Try a coordinate against the configured areas without creating anything. */
const classifyQuerySchema = z.object({ lat: latitude, lng: longitude });

module.exports = {
  createAreaSchema,
  updateAreaSchema,
  updateRuleSchema,
  idParamSchema,
  tierParamSchema,
  classifyQuerySchema,
  suggestQuerySchema,
};