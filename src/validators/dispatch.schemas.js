'use strict';

/**
 * src/validators/dispatch.schemas.js   — Day 9
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const bookingIdParamSchema = z.object({ bookingId: uuid });
const allocationIdParamSchema = z.object({ allocationId: uuid });

const boardQuerySchema = z.object({
  cityId: z.coerce.number().int().positive().optional(),
});

const availableVehiclesQuerySchema = z.object({
  cityId: z.coerce.number().int().positive().optional(),
  vehicleClass: z.enum(['hatchback', 'sedan', 'suv', 'tempo']).optional(),
});

// Manual assignment. driverId optional — a vehicle can be held before a driver
// is named, and the driver-overlap guard only applies once one is set.
const assignSchema = z.object({
  vehicleId: uuid,
  driverId: uuid.optional(),
});

module.exports = {
  bookingIdParamSchema,
  allocationIdParamSchema,
  boardQuerySchema,
  availableVehiclesQuerySchema,
  assignSchema,
};