'use strict';

/**
 * src/validators/gstConfig.schemas.js
 *
 * The admin API for `gst_config` — the table that decides which registration
 * bills a trip, at what rate, for whom.
 *
 * It had no API at all until now. The migration seeded two rows with
 * PLACEHOLDER GSTINs and nothing to edit them with, so correcting one meant a
 * psql session against production. That is why the Telangana registration the
 * client actually holds was never added: there was no door.
 */

const { z } = require('zod');

/**
 * GSTIN: 15 characters.
 *   2 digit state code | 10 char PAN | 1 entity number | 'Z' | 1 checksum
 *
 * Same pattern as customer.schemas, deliberately NOT imported from it. That
 * one validates a CUSTOMER's number; this one validates OUR registration, and
 * the two are allowed to diverge — this side may one day verify against the
 * GST portal, and the customer side will not.
 */
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .length(15, 'GSTIN must be exactly 15 characters')
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
    'Enter a valid GSTIN (e.g. 29AABCU9603R1ZM)',
  );

/**
 * Matched against `cities.state`, in JS, with casing and punctuation
 * normalised — so this only has to be recognisably the state's name.
 */
const state = z.string().trim().min(2).max(80);

const fields = {
  state,
  district: z.string().trim().max(80).nullable(),
  gstin,
  legalName: z.string().trim().min(2).max(180),
  address: z.string().trim().max(2000).nullable(),

  /*
   * 0 is allowed and MEANS SOMETHING: resolveRate treats a zero rate as "does
   * not apply", which is how a registration is kept on file (so its invoices
   * stay explainable) while tax is switched off for it.
   */
  ratePct: z.coerce.number().min(0).max(100),

  /*
   * TRUE backs the tax out of the quoted fare; FALSE adds it on top and
   * raises every corporate fare by the rate.
   *
   * A PRICING DECISION, not a tax one, which is why it is an explicit field
   * and not a default anyone can drift into. The live setting is false.
   */
  isInclusive: z.boolean(),

  applyRetail: z.boolean(),
  applyCorporate: z.boolean(),

  applyOneWay: z.boolean(),
  applyRoundTrip: z.boolean(),
  applyAirport: z.boolean(),
  applyHourly: z.boolean(),

  /*
   * CONFIRM WITH A CA BEFORE SETTING EITHER OF THESE.
   *
   * For passenger transport the place of supply is where the passenger
   * embarks, which makes the pickup state the answer and every trip
   * intra-state. Both flags move away from that, and both produce invoices an
   * audit will ask about — an IGST line under a GSTIN whose own state is the
   * place of supply.
   */
  interstateByRoute: z.boolean(),
  splitByRecipientGstin: z.boolean(),

  hsnSac: z.string().trim().min(4).max(10),
  isActive: z.boolean(),
};

const optional = Object.fromEntries(
  Object.entries(fields).map(([k, v]) => [k, v.optional()]),
);

/**
 * Creating a registration.
 *
 * state, gstin and legalName are required; everything else carries a column
 * default that matches the live Karnataka row. A second registration that
 * quietly taxed differently from the first would be a reconciliation problem
 * nobody would go looking for.
 */
const createSchema = z.object({
  state: fields.state,
  gstin: fields.gstin,
  legalName: fields.legalName,
  ...optional,
});

/**
 * `state` IS editable here, unlike most identity fields.
 *
 * It is the match key resolveConfig uses against a pickup, so a typo in it
 * silently stops a whole state being taxed — exactly the Telangana failure.
 * Making it immutable would mean retiring the row and re-entering every
 * field to fix one word. The service re-checks the GSTIN's own state code
 * against it on any change, so the two cannot drift apart.
 */
const updateSchema = z
  .object(optional)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

module.exports = {
  gstin,
  createSchema,
  updateSchema,
  idParamSchema,
  listQuerySchema,
};