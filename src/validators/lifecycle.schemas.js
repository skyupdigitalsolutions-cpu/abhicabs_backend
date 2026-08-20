'use strict';

/**
 * src/validators/lifecycle.schemas.js
 *
 * Note what is absent: no `status` field anywhere. A client cannot ask for an
 * arbitrary status — each transition has its own endpoint, and the allowed
 * source statuses are fixed in the transition table. That removes a whole class
 * of "customer sets their own booking to COMPLETED" problems by construction.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const idParamSchema = z.object({ id: uuid });

const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional().nullable(),
  // Staff only. A customer's cancellation is always recorded as CUSTOMER
  // regardless of what they send — the service overrides it.
  cancelledByType: z.enum(['CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM']).optional(),
});

/**
 * finalFare is optional on completion. Until Day 11 measures real distance it
 * defaults to the estimate; supplying it covers the case where ops adjusts for
 * extra waiting or a route change.
 */
const completeSchema = z.object({
  finalFare: z.coerce.number().min(0).max(9999999).optional(),
  odometerKm: z.coerce.number().int().min(0).optional(),
  note: z.string().trim().max(500).optional().nullable(),
});

const transitionSchema = z.object({
  note: z.string().trim().max(500).optional().nullable(),
  // Day 9: /allocate may name a vehicle (and optionally a driver) to create a
  // real hold. Optional so other transitions using this schema are unaffected.
  vehicleId: z.string().uuid('Invalid vehicleId').optional(),
  driverId: z.string().uuid('Invalid driverId').optional(),
});

const policyQuerySchema = z.object({
  cityId: z.coerce.number().int().positive(),
  vehicleClass: z.string().trim().min(2).max(24),
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP']),
});

module.exports = {
  idParamSchema,
  cancelSchema,
  completeSchema,
  transitionSchema,
  policyQuerySchema,
};