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

  /*
   * VARIANT GROUPING. Two classes sharing a groupKey are drawn by the app as
   * one card with a toggle between them — the sedan's Petrol and CNG rows.
   *
   * `groupKey` is validated with the SAME slug rule as `key` and nothing
   * weaker, because it is compared against keys. A groupKey of 'Swift-Dzire'
   * matches no key, so the variant silently becomes its own card and the
   * toggle the admin was trying to create never appears.
   *
   * Free text, not an enum of known cars: the grouping is a property of the
   * fleet, which changes without a deploy.
   */
  groupKey: key.nullable(),
  variantLabel: z.string().trim().min(1).max(24).nullable(),

  /*
   * WHICH TRIP TYPES THIS CLASS MAY BE BOOKED FOR. Empty = all.
   *
   * An ENUM, not free text, and this is the only gate on the column: it is
   * JSONB, so Postgres cannot check it against the TripType enum the way it
   * would a real column. A typo'd "ONEWAY" stored here would restrict the
   * class to a trip type that never arrives, taking the vehicle off every
   * screen with nothing to explain why.
   *
   * Uppercased before the check so an admin tool sending "one_way" is
   * accepted rather than being told a value it will consider correct is
   * invalid.
   *
   * Deduplicated, because ["AIRPORT","AIRPORT"] is the same rule written
   * twice and the admin screen should read it back the way it means it.
   */
  tripTypes: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .pipe(z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'])),
    )
    .max(4)
    .transform((list) => [...new Set(list)]),
  sortOrder: z.coerce.number().int().min(0).max(9999),
  isActive: z.boolean(),

  /*
   * THE BOOKING SWITCH, accepted on create and on the general update too.
   *
   * It also has a dedicated endpoint (PATCH /:key/booking) and that is the one
   * the admin toggle should call, because only that one records WHY and WHEN.
   * Accepting it here as well is for the bulk-edit form: an admin fixing six
   * fields at once should not have to make two calls, and silently dropping a
   * field the form sent is worse than taking it.
   */
  bookingEnabled: z.boolean(),
  bookingDisabledReason: z.string().trim().max(200).nullable(),
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

  /*
   * Narrow the catalogue to the classes bookable for one trip type.
   *
   * So the app's Airport tab can ask for exactly what it may show, instead of
   * fetching everything and re-implementing the empty-means-all rule in the
   * client — where it would drift from the server's copy the first time
   * either changed.
   */
  tripType: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']))
    .optional(),

  /*
   * Drop the classes that are switched off for booking.
   *
   * OPT-IN, not the default, and the default has to stay "everything": the
   * admin panel reads this same endpoint, and an admin cannot re-enable a
   * vehicle that the list has filtered out from under them. The rider app's
   * browse screen also wants them all, so it can grey the card out and say
   * why rather than have a car silently disappear from the fleet page.
   *
   * When the GLOBAL switch is on this returns an empty list, because nothing
   * is bookable.
   */
  bookableOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

/**
 * The per-class booking toggle.
 *
 * `enabled` is REQUIRED rather than a toggle-what-it-is-now default, and that
 * is deliberate for an idempotency reason that bites in practice: an admin
 * double-taps, or the app retries a request it never saw the response to. A
 * flip-the-current-value endpoint turns the second call into an undo of the
 * first and the switch ends up back where it started, with the admin looking
 * at a green toggle they are sure they turned red. Sending the DESIRED state
 * makes the call safe to repeat.
 *
 * `reason` is optional and only meaningful when switching OFF — it is shown to
 * a rider who reaches the class through a stale screen. Required reasons are
 * how a field that needs filling in a hurry ends up holding "asdf".
 */
const bookingToggleSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(200).optional().nullable(),
});

/**
 * The global switch. Same shape, same reasoning — but note what is NOT here:
 * there is no `keys: []` to disable a subset. A subset is what the per-class
 * endpoint is for, and offering both would leave two ways to express the same
 * state that can disagree with each other.
 */
const bookingToggleAllSchema = bookingToggleSchema;

module.exports = {
  createSchema,
  updateSchema,
  keyParamSchema,
  imageParamSchema,
  imageBodySchema,
  listQuerySchema,
  bookingToggleSchema,
  bookingToggleAllSchema,
};