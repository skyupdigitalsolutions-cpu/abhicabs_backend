'use strict';

/**
 * src/validators/vehicleCatalog.schemas.js
 */

const { z } = require('zod');

/**
 * The join key to fare_configs and vehicles.
 *
 * Forced lowercase, and restricted to a slug. `vehicleClass` is free text
 * across three tables with no foreign key holding them together, so the only
 * thing preventing "Luxury" and "luxury" becoming two classes — one browsable,
 * one priceable — is normalising it at the single point where a new one is
 * created.
 */
const key = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(24)
  .regex(/^[a-z][a-z0-9_-]*$/, 'Use lowercase letters, digits, - or _');

const fields = {
  name: z.string().trim().min(2).max(60),
  seats: z.coerce.number().int().min(1).max(60),
  blurb: z.string().trim().min(3).max(160),
  detail: z.string().trim().min(3).max(1000),
  luggage: z.string().trim().min(1).max(60),
  glyph: z.string().trim().min(1).max(8),
  transmission: z.enum(['Manual', 'Automatic']).nullable(),
  fuel: z.enum(['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid']).nullable(),
  // Decimal(3,2): 0.00–9.99. Capped at 5 because that is the scale shown.
  rating: z.coerce.number().min(0).max(5).nullable(),
  trips: z.coerce.number().int().min(0).nullable(),
  sortOrder: z.coerce.number().int().min(0).max(9999),
  isActive: z.boolean(),
};

const optional = Object.fromEntries(
  Object.entries(fields).map(([k, v]) => [k, v.optional()]),
);

const createSchema = z.object({
  key,
  name: fields.name,
  seats: fields.seats,
  blurb: fields.blurb,
  detail: fields.detail,
  luggage: fields.luggage,
  ...optional,
});

/**
 * `key` is absent on purpose. It is the identifier every fare card and vehicle
 * row points at by string; renaming it here would silently orphan all of them.
 * Retire the class and create a new one instead.
 */
const updateSchema = z
  .object(optional)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const keyParamSchema = z.object({ key });

const imageParamSchema = z.object({
  key,
  // Cloudinary public ids contain slashes, so the route declares this as a
  // wildcard segment and it arrives already joined.
  publicId: z.string().trim().min(3).max(200),
});

const imageBodySchema = z.object({
  label: z.string().trim().max(40).optional(),
  // multipart/form-data carries no JSON types — everything is a string.
  asHero: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

const listQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

module.exports = {
  createSchema,
  updateSchema,
  keyParamSchema,
  imageParamSchema,
  imageBodySchema,
  listQuerySchema,
};