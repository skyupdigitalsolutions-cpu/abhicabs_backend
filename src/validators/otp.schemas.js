'use strict';

/**
 * src/validators/otp.schemas.js
 *
 * Import these from src/validators/schemas.js and re-export, or require this
 * file directly in the routes.
 */

const { z } = require('zod');

/**
 * Indian mobile: 10 digits starting 6-9.
 *
 * Normalises BEFORE validating — strips non-digits and keeps the last 10 — so
 * "+91 98765 43210", "09876543210" and "9876543210" all resolve to the same
 * stored value. Without normalisation the same person could end up with several
 * accounts and never be able to log back into the right one.
 */
const indianPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, '').slice(-10))
  .refine((v) => /^[6-9]\d{9}$/.test(v), {
    message: 'Enter a valid 10-digit Indian mobile number',
  });

const otpRequestSchema = z.object({
  phone: indianPhone,
});

const otpVerifySchema = z.object({
  phone: indianPhone,
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'Enter the numeric code from your SMS'),
  // Supplied on first-time signup only; ignored for an existing account.
  // Note there is deliberately NO role field here.
  name: z.string().trim().min(2).max(120).optional(),
});

const grantPermissionSchema = z.object({
  role: z.enum(['USER', 'ADMIN', 'DRIVER', 'OPS', 'FINANCE', 'FLEET', 'SUPPORT']),
  permission: z.string().trim().min(3).max(48),
});

module.exports = { indianPhone, otpRequestSchema, otpVerifySchema, grantPermissionSchema };