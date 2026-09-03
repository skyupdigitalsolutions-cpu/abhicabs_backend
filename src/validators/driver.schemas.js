'use strict';

/**
 * src/validators/driver.schemas.js
 *
 * Driver roster management. A driver row is keyed by userId and always has a
 * linked User (name / phone / email live there). The create schema therefore
 * carries both the user-facing contact fields and the driver-specific ones;
 * the service splits them across the two tables in a transaction.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

const KYC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'];

const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, '').slice(-10))
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

const email = z.string().trim().toLowerCase().email('Enter a valid email');

const licenceNumber = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, 'Licence number is too short')
  .max(32, 'Licence number is too long');

const aadhaarLast4 = z
  .string()
  .trim()
  .regex(/^\d{4}$/, 'Aadhaar last 4 must be exactly 4 digits');

const dateOpt = z.coerce.date().optional().nullable();

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

const listDriversQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Matches licenceNumber, or the linked user's name / phone.
  search: z.string().trim().max(120).optional(),
  // Availability filter — maps to the isOnline flag.
  status: z.enum(['online', 'offline']).optional(),
  kycStatus: z.enum(KYC_STATUSES).optional(),
  sortBy: z.enum(['createdAt', 'ratingAvg', 'licenceExpiry', 'lastPingAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// The route uses :id; it is the driver's userId.
const idParamSchema = z.object({ id: uuid });

/* ------------------------------------------------------------------ *
 * Create  (onboard)
 * ------------------------------------------------------------------ */

const createDriverSchema = z.object({
  // --- linked user ---
  name: z.string().trim().min(2).max(120),
  phone,
  email: email.optional(),
  // Optional: if omitted, a random password is stored and the driver signs in by OTP.
  password: z.string().min(8).max(72).optional(),

  // --- driver ---
  licenceNumber,
  licenceExpiry: dateOpt,
  aadhaarLast4: aadhaarLast4.optional().nullable(),
  kycStatus: z.enum(KYC_STATUSES).optional(),
  assignedVehicleId: uuid.optional().nullable(),
});

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

const updateDriverSchema = z
  .object({
    // linked user fields (applied to the User row)
    name: z.string().trim().min(2).max(120).optional(),
    phone: phone.optional(),
    email: email.optional(),

    // driver fields
    licenceNumber: licenceNumber.optional(),
    licenceExpiry: dateOpt,
    aadhaarLast4: aadhaarLast4.optional().nullable(),
    kycStatus: z.enum(KYC_STATUSES).optional(),
    isOnline: z.boolean().optional(),
    assignedVehicleId: uuid.optional().nullable(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

module.exports = {
  KYC_STATUSES,
  listDriversQuerySchema,
  idParamSchema,
  createDriverSchema,
  updateDriverSchema,
};