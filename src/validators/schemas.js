'use strict';

/**
 * src/validators/schemas.js
 *
 * All request schemas in one place.
 *
 * Note the max lengths on every string — an unbounded string field is a
 * denial-of-service vector, not just untidy.
 */

const { z } = require('zod');
const customerFields = require('./customer.schemas');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, 'Email is too short')
  .max(180, 'Email is too long')
  .email('Enter a valid email address');

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters') // bcrypt truncates past 72
  .regex(/[a-z]/, 'Include at least one lowercase letter')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/[0-9]/, 'Include at least one number');

const name = z.string().trim().min(2, 'Name is too short').max(120, 'Name is too long');

const phone = z
  .string()
  .trim()
  .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number')
  .optional()
  .nullable();

const uuid = z.string().uuid('Invalid id');

/* ---------------------------------------------------------------- *
 * Auth
 * ---------------------------------------------------------------- */

// Note: `role` is deliberately NOT accepted here. If it were, anyone could
// register themselves as an admin. Admins are created by admins, or seeded.
// Passwordless registration: name + email + mobile only. Phone is REQUIRED here
// (unlike the shared optional `phone`) because it's the number the rider will
// sign in with via OTP afterwards.
/**
 * Company details, required only when signing up as a business.
 *
 * Reuses the same field validators the admin corporate form uses, so a GSTIN
 * typed at signup is held to exactly the same standard as one typed by staff.
 */
const registerCorporateBlock = z.object({
  companyName: z.string().trim().min(2).max(180),
  gstin: customerFields.gstin,
  pan: customerFields.pan.optional().nullable(),
  billingEmail: z.string().trim().toLowerCase().email().max(180),
  billingPhone: z.string().trim().max(20).optional().nullable(),
  billingAddress: z.string().trim().min(5).max(500),
  billingCity: z.string().trim().min(2).max(80),
  billingState: z.string().trim().min(2).max(80),
  billingPincode: customerFields.pincode,
  billingCycle: z.enum(['PER_TRIP', 'WEEKLY', 'MONTHLY']).default('PER_TRIP'),
  // creditLimit is absent on purpose. A limit is a commercial term the business
  // grants, and assertCreditAvailable reads 0 as UNLIMITED — so accepting it
  // here would let an applicant write their own credit line at signup.
});

const registerSchema = z
  .object({
    name,
    email,
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number'),

    // Retail unless the person deliberately chooses otherwise. Defaulting here
    // rather than in the service means an app that sends nothing at all still
    // gets the safe answer.
    accountType: z.enum(['RETAIL', 'CORPORATE']).default('RETAIL'),

    corporate: registerCorporateBlock.optional(),
  })
  .superRefine((data, ctx) => {
    // Choosing CORPORATE without the company details would create an account
    // that claims to be a business and has nothing to bill.
    if (data.accountType === 'CORPORATE' && !data.corporate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['corporate'],
        message: 'Company details are required to register a business account',
      });
    }
    // Sending company details while asking for RETAIL is a client bug, and
    // silently dropping them would lose data the person typed.
    if (data.accountType !== 'CORPORATE' && data.corporate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountType'],
        message: 'Set accountType to CORPORATE to register company details',
      });
    }
  });

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(72),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'Refresh token is required').max(1000),
});

/* ---------------------------------------------------------------- *
 * Password reset
 * ---------------------------------------------------------------- */

const forgotPasswordSchema = z.object({
  email,
});

// The token is 32 random bytes hex-encoded, so exactly 64 chars. Pinning the
// length rejects obvious junk before it ever reaches Redis.
const resetTokenSchema = z
  .string()
  .trim()
  .length(64, 'Invalid reset token')
  .regex(/^[a-f0-9]+$/i, 'Invalid reset token');

const verifyResetTokenSchema = z.object({
  token: resetTokenSchema,
});

const resetPasswordSchema = z.object({
  token: resetTokenSchema,
  // Same rules as every other password in the system — a reset must not be a
  // way to set a weaker password than register would allow.
  newPassword: password,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(72),
  newPassword: password,
});

/* ---------------------------------------------------------------- *
 * User (self-service)
 * ---------------------------------------------------------------- */

const updateProfileSchema = z
  .object({
    name: name.optional(),
    phone,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

/* ---------------------------------------------------------------- *
 * Admin
 * ---------------------------------------------------------------- */

/**
 * Roles an admin may hand out through /admin/users.
 *
 * DRIVER is deliberately absent. A driver is created by driver.service, which
 * writes the users row AND the drivers extension (licence, KYC, documents) in
 * one transaction. A bare DRIVER user made here would authenticate and then
 * fail everywhere the driver profile is read, because no drivers row exists.
 */
const ASSIGNABLE_ROLES = ['USER', 'ADMIN', 'OPS', 'FINANCE', 'FLEET', 'SUPPORT'];

/**
 * Roles that carry staff access. Creating one of these is a privilege grant,
 * not a sign-up, so user.service guards it independently of route permissions.
 */
const PRIVILEGED_ROLES = ['ADMIN', 'OPS', 'FINANCE', 'FLEET', 'SUPPORT'];

/** Filtering the list is read-only, so every role is fair game here. */
const FILTERABLE_ROLES = [...ASSIGNABLE_ROLES, 'DRIVER'];

const createUserSchema = z.object({
  name,
  email,
  password,
  phone,
  role: z.enum(ASSIGNABLE_ROLES).default('USER'),
  isActive: z.boolean().default(true),
});

// Only these fields can ever be changed via the API. Anything else in the
// body is stripped — this is what prevents mass assignment.
const updateUserSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
    phone,
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    isActive: z.boolean().optional(),
    password: password.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  role: z.enum(FILTERABLE_ROLES).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sortBy: z.enum(['createdAt', 'name', 'email']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const idParamSchema = z.object({ id: uuid });

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  verifyResetTokenSchema,
  resetPasswordSchema,
  updateProfileSchema,
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
  idParamSchema,
  ASSIGNABLE_ROLES,
  PRIVILEGED_ROLES,
  FILTERABLE_ROLES,
};