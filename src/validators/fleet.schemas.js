'use strict';

/**
 * src/validators/fleet.schemas.js
 *
 * Read-side schemas for the fleet endpoints (vehicles + drivers). Everything
 * here is a GET, so these are query- and param-only. zod coerces the numeric
 * query values (page, limit, cityId) and strips any unknown keys.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

/**
 * Query strings arrive as "true" / "false". z.coerce.boolean() is wrong here
 * (Boolean("false") === true), so parse the two literal strings explicitly.
 */
const boolFromQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

const listVehiclesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Matches registrationNumber or makeModel.
  search: z.string().trim().max(120).optional(),
  status: z.enum(['AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'MAINTENANCE', 'INACTIVE']).optional(),
  vehicleClass: z.string().trim().max(24).optional(),
  cityId: z.coerce.number().int().positive().optional(),
  isActive: boolFromQuery.optional(),
  sortBy: z
    .enum(['createdAt', 'registrationNumber', 'vehicleClass', 'status', 'odometerKm'])
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const vehicleIdParamSchema = z.object({ id: uuid });

/* ------------------------------------------------------------------ *
 * Drivers
 * ------------------------------------------------------------------ */

const listDriversQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Matches licenceNumber, or the driver's user name / phone.
  search: z.string().trim().max(120).optional(),
  kycStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED']).optional(),
  isOnline: boolFromQuery.optional(),
  sortBy: z.enum(['createdAt', 'ratingAvg', 'licenceExpiry', 'lastPingAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// A driver's primary key is its userId, not an 'id' column.
const driverIdParamSchema = z.object({ userId: uuid });

module.exports = {
  listVehiclesQuerySchema,
  vehicleIdParamSchema,
  listDriversQuerySchema,
  driverIdParamSchema,
};