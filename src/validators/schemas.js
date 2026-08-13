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
const registerSchema = z.object({
  name,
  email,
  password,
  phone,
});

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(72),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'Refresh token is required').max(1000),
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

const createUserSchema = z.object({
  name,
  email,
  password,
  phone,
  role: z.enum(['USER', 'ADMIN']).default('USER'),
  isActive: z.boolean().default(true),
});

// Only these fields can ever be changed via the API. Anything else in the
// body is stripped — this is what prevents mass assignment.
const updateUserSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
    phone,
    role: z.enum(['USER', 'ADMIN']).optional(),
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
  role: z.enum(['USER', 'ADMIN']).optional(),
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
  updateProfileSchema,
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
  idParamSchema,
};