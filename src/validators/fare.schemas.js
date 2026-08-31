'use strict';

/**
 * src/validators/fare.schemas.js
 *
 * Note what the client never sends: an amount. It supplies WHERE and WHEN; the
 * server decides WHAT IT COSTS. A client-supplied fare would be trivially
 * tampered with, so the field simply does not exist.
 */

const { z } = require('zod');

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

/**
 * Either coordinates or an address. Coordinates cost nothing; an address costs
 * a geocode (cached 30 days).
 */
const location = z
  .object({
    lat: latitude.optional(),
    lng: longitude.optional(),
    address: z.string().trim().min(3).max(500).optional(),
  })
  .refine(
    (v) => (v.lat != null && v.lng != null) || (v.address && v.address.length >= 3),
    'Provide either lat and lng, or an address'
  );

const vehicleClass = z.string().trim().min(2).max(24);

/**
 * Surge is accepted but CLAMPED server-side to the band in fare_configs
 * (MVAG caps it between 0.5x and 2x). A caller asking for 10x gets 2x, silently
 * corrected rather than trusted or rejected.
 */
const surge = z.coerce.number().min(0.1).max(10).default(1);

const baseQuote = {
  cityId: z.coerce.number().int().positive(),
  vehicleClass,
  pickup: location,
  // Optional so HOURLY (local rental) can quote with no drop. The quote service
  // defaults it to pickup for HOURLY and skips the distance leg.
  drop: location.optional().nullable(),
  pickupAt: z.string().datetime({ offset: true }).or(z.string().min(10)),
  returnAt: z.string().datetime({ offset: true }).or(z.string().min(10)).optional().nullable(),
  waitingMinutes: z.coerce.number().int().min(0).max(10080).default(0),
  surge,
  // AIRPORT
  flightNumber: z.string().trim().max(16).optional().nullable(),
  // HOURLY: a fixed package id OR a flexible hours commitment.
  rentalPackageId: z.coerce.number().int().positive().optional().nullable(),
  rentalHours: z.coerce.number().int().min(1).max(24).optional().nullable(),
};

const estimateSchema = z
  .object({
    ...baseQuote,
    tripType: z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']),
  })
  .refine(
    (v) => v.tripType !== 'ROUND_TRIP' || Boolean(v.returnAt),
    { message: 'A round trip needs a return date and time', path: ['returnAt'] }
  )
  .refine(
    (v) => v.tripType !== 'HOURLY' || Boolean(v.rentalPackageId) || Boolean(v.rentalHours),
    { message: 'An hourly rental needs a package or a number of hours', path: ['rentalHours'] }
  );

/** Prices the same trip both ways so a customer can compare. */
const compareSchema = z.object(baseQuote);

/** Every vehicle class for one trip — powers the class picker. */
const allClassesSchema = z.object({
  ...baseQuote,
  // /fares/options prices EVERY vehicle class, so a single class is not required
  // here (quoteAllClasses ignores it). Override baseQuote's required field.
  vehicleClass: vehicleClass.optional(),
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']).default('ONE_WAY'),
});

/** GET /fares/rental-packages?cityId=1&vehicleClass=sedan */
const rentalPackagesSchema = z.object({
  cityId: z.coerce.number().int().positive(),
  vehicleClass: vehicleClass.optional(),
});

const geocodeSchema = z.object({
  address: z.string().trim().min(3).max(500),
});

const reverseGeocodeSchema = z.object({
  lat: latitude,
  lng: longitude,
});

const autocompleteSchema = z.object({
  q: z.string().trim().min(3).max(120),
  lat: latitude.optional(),
  lng: longitude.optional(),
  sessionToken: z.string().trim().max(64).optional(),
});

const distanceSchema = z.object({
  origin: location,
  destination: location,
  fresh: z.coerce.boolean().default(false),
});

const cancellationSchema = z.object({
  cityId: z.coerce.number().int().positive(),
  vehicleClass,
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']).default('ONE_WAY'),
  pickupAt: z.string().min(10),
  fareTotal: z.coerce.number().min(0).optional(),
});

module.exports = {
  location,
  estimateSchema,
  compareSchema,
  allClassesSchema,
  rentalPackagesSchema,
  geocodeSchema,
  reverseGeocodeSchema,
  autocompleteSchema,
  distanceSchema,
  cancellationSchema,
};