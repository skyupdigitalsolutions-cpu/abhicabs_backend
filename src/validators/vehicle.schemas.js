'use strict';

/**
 * src/validators/vehicle.schemas.js
 *
 * Fleet vehicle management (list / read / create / update / soft-delete).
 * Numeric and boolean query values are coerced; unknown keys are stripped by
 * zod before any handler runs.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');
const boolFromQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

const VEHICLE_STATUSES = ['AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'MAINTENANCE', 'INACTIVE'];

const registrationNumber = z
  .string()
  .trim()
  .toUpperCase()
  .min(4, 'Registration number is too short')
  .max(16, 'Registration number is too long');

const vehicleClass = z.string().trim().min(1).max(24);
const dateOpt = z.coerce.date().optional().nullable();

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

const listVehiclesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Matches registrationNumber or makeModel.
  search: z.string().trim().max(120).optional(),
  status: z.enum(VEHICLE_STATUSES).optional(),
  vehicleClass: z.string().trim().max(24).optional(),
  cityId: z.coerce.number().int().positive().optional(),
  isActive: boolFromQuery.optional(),
  sortBy: z
    .enum(['createdAt', 'registrationNumber', 'vehicleClass', 'status', 'odometerKm'])
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const idParamSchema = z.object({ id: uuid });

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

const createVehicleSchema = z.object({
  registrationNumber,
  vehicleClass,
  makeModel: z.string().trim().max(80).optional().nullable(),
  year: z.coerce
    .number()
    .int()
    .min(1980)
    .max(new Date().getFullYear() + 1)
    .optional()
    .nullable(),
  colour: z.string().trim().max(40).optional().nullable(),
  seatingCapacity: z.coerce.number().int().min(1).max(50).default(4),
  status: z.enum(VEHICLE_STATUSES).default('AVAILABLE'),
  cityId: z.coerce.number().int().positive().optional().nullable(),
  insuranceExpiry: dateOpt,
  fitnessExpiry: dateOpt,
  permitExpiry: dateOpt,
  pucExpiry: dateOpt,
  odometerKm: z.coerce.number().int().min(0).default(0),
  documents: z.record(z.any()).optional(),
});

/* ------------------------------------------------------------------ *
 * Update  (PATCH — every field optional, but at least one required)
 * ------------------------------------------------------------------ */

const updateVehicleSchema = z
  .object({
    registrationNumber: registrationNumber.optional(),
    vehicleClass: vehicleClass.optional(),
    makeModel: z.string().trim().max(80).optional().nullable(),
    year: z.coerce
      .number()
      .int()
      .min(1980)
      .max(new Date().getFullYear() + 1)
      .optional()
      .nullable(),
    colour: z.string().trim().max(40).optional().nullable(),
    seatingCapacity: z.coerce.number().int().min(1).max(50).optional(),
    status: z.enum(VEHICLE_STATUSES).optional(),
    cityId: z.coerce.number().int().positive().optional().nullable(),
    insuranceExpiry: dateOpt,
    fitnessExpiry: dateOpt,
    permitExpiry: dateOpt,
    pucExpiry: dateOpt,
    odometerKm: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    documents: z.record(z.any()).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

module.exports = {
  VEHICLE_STATUSES,
  listVehiclesQuerySchema,
  idParamSchema,
  createVehicleSchema,
  updateVehicleSchema,
};