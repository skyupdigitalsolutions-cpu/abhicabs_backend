'use strict';

/**
 * src/validators/temporaryDriver.schemas.js
 */

const { z } = require('zod');

/**
 * vehicleClass is REQUIRED, despite not being in the original three fields.
 *
 * Without it the vehicle cannot be dispatched: allocate() refuses a vehicle
 * whose class does not match the booking's, so a temp car with the wrong class
 * is onboarded successfully and then never assignable — which looks like a
 * dispatch bug rather than missing data.
 *
 * Free text, matching vehicles.vehicleClass elsewhere. It must equal a key the
 * fleet actually prices: 'sedan', 'innova', 'tempo-12'.
 */
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: z.string().trim().min(10).max(20),
  vehicleNumber: z.string().trim().min(6).max(20),
  vehicleClass: z.string().trim().min(2).max(24),

  // Optional, with sensible fallbacks. A hire is usually arranged in a hurry.
  seatingCapacity: z.coerce.number().int().min(1).max(60).optional(),
  cityId: z.coerce.number().int().positive().optional(),
});

const userIdParamSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  includeReleased: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

module.exports = { createSchema, userIdParamSchema, listQuerySchema };