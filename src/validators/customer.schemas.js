'use strict';

/**
 * src/validators/customer.schemas.js
 *
 * Note what is NOT in the self-service schemas: accountType and
 * corporateAccountId. zod strips undeclared keys, so a customer sending
 * {"accountType":"CORPORATE"} to their own profile endpoint has that field
 * removed before any code sees it. The protection is structural — a developer
 * cannot forget to check for something that is already gone.
 */

const { z } = require('zod');

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/**
 * GSTIN: 15 characters.
 *   2 digit state code | 10 char PAN | 1 entity number | 'Z' | 1 checksum
 */
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .length(15, 'GSTIN must be exactly 15 characters')
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
    'Enter a valid GSTIN (e.g. 29AABCU9603R1ZM)'
  );

const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Enter a valid PAN (e.g. AABCU9603R)');

const pincode = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit pincode');

const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, '').slice(-10))
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

// Roughly 1cm precision — ample for dispatch.
const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

const uuid = z.string().uuid('Invalid id');

/* ------------------------------------------------------------------ *
 * Customer — self-service
 * ------------------------------------------------------------------ */

const updateCustomerSelfSchema = z
  .object({
    alternatePhone: phone.optional().nullable(),
    gstin: gstin.optional().nullable(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

/* ------------------------------------------------------------------ *
 * Customer — admin
 * ------------------------------------------------------------------ */

const updateCustomerAdminSchema = z
  .object({
    accountType: z.enum(['RETAIL', 'CORPORATE']).optional(),
    corporateAccountId: uuid.optional().nullable(),
    alternatePhone: phone.optional().nullable(),
    gstin: gstin.optional().nullable(),
    loyaltyPoints: z.coerce.number().int().min(0).max(1000000).optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const listCustomersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  accountType: z.enum(['RETAIL', 'CORPORATE']).optional(),
  corporateAccountId: uuid.optional(),
  sortBy: z.enum(['createdAt', 'loyaltyPoints', 'totalBookings', 'name']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/* ------------------------------------------------------------------ *
 * Corporate account
 * ------------------------------------------------------------------ */

const createCorporateSchema = z.object({
  companyName: z.string().trim().min(2).max(180),
  gstin,
  pan: pan.optional().nullable(),
  billingEmail: z.string().trim().toLowerCase().email().max(180),
  billingPhone: phone.optional().nullable(),
  billingAddress: z.string().trim().min(5).max(500),
  billingCity: z.string().trim().min(2).max(80),
  billingState: z.string().trim().min(2).max(80),
  billingPincode: pincode,
  billingCycle: z.enum(['PER_TRIP', 'WEEKLY', 'MONTHLY']).default('PER_TRIP'),
  // 0 means "no limit configured", not a hard zero.
  creditLimit: z.coerce.number().min(0).max(99999999).default(0),
});

const updateCorporateSchema = createCorporateSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const listCorporateQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  billingCycle: z.enum(['PER_TRIP', 'WEEKLY', 'MONTHLY']).optional(),
  sortBy: z.enum(['createdAt', 'companyName', 'creditLimit']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const employeeSchema = z.object({ customerId: uuid });

/* ------------------------------------------------------------------ *
 * Address
 * ------------------------------------------------------------------ */

const createAddressSchema = z.object({
  label: z.string().trim().min(1).max(40),
  line1: z.string().trim().min(3).max(255),
  line2: z.string().trim().max(255).optional().nullable(),
  landmark: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode,
  lat: latitude.optional().nullable(),
  lng: longitude.optional().nullable(),
  isDefault: z.boolean().default(false),
});

const updateAddressSchema = createAddressSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const coordinatesSchema = z.object({ lat: latitude, lng: longitude });

const idParamSchema = z.object({ id: uuid });
const customerIdParamSchema = z.object({ customerId: uuid });

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  actorId: uuid.optional(),
  entityType: z.string().trim().max(48).optional(),
  entityId: z.string().trim().max(64).optional(),
  action: z.string().trim().max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

module.exports = {
  gstin,
  pan,
  pincode,
  updateCustomerSelfSchema,
  updateCustomerAdminSchema,
  listCustomersQuerySchema,
  createCorporateSchema,
  updateCorporateSchema,
  listCorporateQuerySchema,
  employeeSchema,
  createAddressSchema,
  updateAddressSchema,
  coordinatesSchema,
  idParamSchema,
  customerIdParamSchema,
  auditQuerySchema,
};