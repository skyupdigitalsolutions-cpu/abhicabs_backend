'use strict';

/**
 * src/validators/driverSelf.schemas.js
 *
 * Driver SELF-SERVICE input rules — the driver app talking about its own
 * account. Mirrors the field rules in driver.schemas.js / vehicle.schemas.js so
 * a licence number or registration number is normalised identically no matter
 * which door it comes through (admin console or driver app).
 *
 * Two things are deliberately NOT accepted anywhere in this file:
 *   - `role`          the service hard-codes DRIVER; see auth.service.register
 *                     for the same reasoning on the rider side.
 *   - `kycStatus`     a driver cannot grade their own paperwork.
 * Leaving them out of the schema means zod strips them before any handler runs,
 * so a hostile payload cannot reach the service in the first place.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');

/* Same normalisation as driver.schemas.js: strip non-digits, keep last 10. */
const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, '').slice(-10))
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

const email = z.string().trim().toLowerCase().email('Enter a valid email');

const name = z.string().trim().min(2, 'Name is too short').max(120);

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

const registrationNumber = z
  .string()
  .trim()
  .toUpperCase()
  .min(4, 'Registration number is too short')
  .max(16, 'Registration number is too long');

const vehicleClass = z.string().trim().min(1).max(24);
const dateOpt = z.coerce.date().optional().nullable();

/**
 * Document slots. Driver-side documents live on drivers.documents; vehicle
 * paperwork lives on vehicles.documents. Kept as separate enums so a driver
 * cannot file an RC book against their own identity record.
 */
const DRIVER_DOC_TYPES = ['LICENCE', 'AADHAAR', 'PHOTO'];
const VEHICLE_DOC_TYPES = ['RC', 'INSURANCE', 'PUC', 'FITNESS', 'PERMIT'];

/* The client's answer to "what must be present before review": licence, RC,
 * insurance, PUC, Aadhaar and photo. Split across the two records. */
const REQUIRED_DRIVER_DOCS = ['LICENCE', 'AADHAAR', 'PHOTO'];
const REQUIRED_VEHICLE_DOCS = ['RC', 'INSURANCE', 'PUC'];

/* ------------------------------------------------------------------ *
 * Registration  (public — no token yet)
 * ------------------------------------------------------------------ */

const driverRegisterSchema = z.object({
  name,
  phone,
  // Optional: drivers are phone-first. A placeholder is generated when absent,
  // exactly as driver.service.create does for admin-onboarded drivers.
  email: email.optional(),
  licenceNumber,
  licenceExpiry: dateOpt,
});

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

const updateSelfSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
    licenceNumber: licenceNumber.optional(),
    licenceExpiry: dateOpt,
    aadhaarLast4: aadhaarLast4.optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

// multipart: the file arrives on req.file, docType as a text field.
const driverDocSchema = z.object({
  docType: z.enum(DRIVER_DOC_TYPES),
});

const vehicleDocSchema = z.object({
  docType: z.enum(VEHICLE_DOC_TYPES),
  // Lets the driver set the expiry shown on the document in the same request.
  expiry: dateOpt,
});

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

const registerVehicleSchema = z.object({
  registrationNumber,
  vehicleClass,
  makeModel: z.string().trim().max(80).optional().nullable(),
  year: z.coerce.number().int().min(1980).max(new Date().getFullYear() + 1).optional().nullable(),
  colour: z.string().trim().max(40).optional().nullable(),
  seatingCapacity: z.coerce.number().int().min(1).max(64).optional(),
  insuranceExpiry: dateOpt,
  fitnessExpiry: dateOpt,
  permitExpiry: dateOpt,
  pucExpiry: dateOpt,
});

const claimVehicleSchema = z.object({
  registrationNumber,
  note: z.string().trim().max(300).optional(),
});

const vehicleIdParamSchema = z.object({ vehicleId: uuid });

module.exports = {
  DRIVER_DOC_TYPES,
  VEHICLE_DOC_TYPES,
  REQUIRED_DRIVER_DOCS,
  REQUIRED_VEHICLE_DOCS,

  driverRegisterSchema,
  updateSelfSchema,
  driverDocSchema,
  vehicleDocSchema,
  registerVehicleSchema,
  claimVehicleSchema,
  vehicleIdParamSchema,
};