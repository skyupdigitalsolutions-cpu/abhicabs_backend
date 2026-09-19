'use strict';

const { z } = require('zod');

/**
 * The canonical display name. No format constraint beyond length — India has
 * states with spaces, hyphens and "and" in them ("Jammu and Kashmir",
 * "Dadra and Nagar Haveli"), and a regex here would only get in the way.
 */
const name = z.string().trim().min(2).max(64);

/**
 * Alternative spellings. Normalised on write (see the service), so the admin
 * can type them however is natural — "AP", "Andhra Pr." — and matching still
 * works.
 */
const aliases = z.array(z.string().trim().min(1).max(64)).max(20);

const createSchema = z.object({
  name,
  code: z.string().trim().min(1).max(8).optional(),
  aliases: aliases.optional(),
  isActive: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

const updateSchema = z
  .object({
    name: name.optional(),
    code: z.string().trim().max(8).nullable().optional(),
    aliases: aliases.optional(),
    isActive: z.boolean().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const listQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

module.exports = { createSchema, updateSchema, listQuerySchema, idParamSchema };