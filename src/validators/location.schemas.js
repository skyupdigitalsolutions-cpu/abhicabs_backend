'use strict';

/**
 * src/validators/location.schemas.js   — Day 11
 */

const { z } = require('zod');

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

const pingSchema = z.object({
  lat,
  lng,
  speed: z.coerce.number().min(0).max(400).optional(),
  heading: z.coerce.number().min(0).max(360).optional(),
  // Optional: if the driver is on a trip, its booking id enables the durable
  // (throttled) checkpoint alongside the live Redis position.
  bookingId: z.string().uuid().optional(),
  at: z.string().datetime().optional(),
});

const nearbyQuerySchema = z.object({
  lat,
  lng,
  radiusKm: z.coerce.number().positive().max(50).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const driverIdParamSchema = z.object({
  driverId: z.string().uuid('Invalid driverId'),
});

const bookingIdParamSchema = z.object({
  bookingId: z.string().uuid('Invalid bookingId'),
});

module.exports = {
  pingSchema,
  nearbyQuerySchema,
  driverIdParamSchema,
  bookingIdParamSchema,
};