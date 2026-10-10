'use strict';

/**
 * src/validators/booking.schemas.js
 *
 * NOTE WHAT IS ABSENT from createBookingSchema: any fare, price, amount or
 * total. zod strips undeclared keys, so a client sending "estimatedFare": 1
 * has it removed before any code runs. The server prices every booking itself.
 *
 * Also absent: status, bookingNumber, customerId (for self-service). A customer
 * cannot create a booking already marked CONFIRMED, or on someone else's behalf.
 */

const { z } = require('zod');

const uuid = z.string().uuid('Invalid id');
const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

/**
 * A location is EITHER coordinates OR an address, not neither.
 *
 * Coordinates are preferred — the mobile app has them from the map picker, and
 * they need no geocoding call. An address is the fallback for typed input.
 */
const location = z
  .object({
    lat: latitude.optional(),
    lng: longitude.optional(),
    address: z.string().trim().min(3).max(500).optional(),
    addressId: uuid.optional(),
  })
  .refine(
    (v) => (v.lat !== undefined && v.lng !== undefined) || !!v.address || !!v.addressId,
    { message: 'Provide coordinates, an address, or a saved address id' }
  );

const createBookingSchema = z
  .object({
    cityId: z.coerce.number().int().positive(),
    vehicleClass: z.string().trim().min(2).max(24),
    tripType: z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']),

    pickup: location,
    // Drop is optional for HOURLY (local rentals have no fixed destination —
    // you keep the car for the package hours). Required for every other type,
    // enforced by the refine below.
    drop: location.optional().nullable(),
    stops: z.array(location).max(10).optional(),

    pickupAt: z.string().datetime({ message: 'pickupAt must be an ISO datetime' }),
    /**
     * A round trip's return DATE. The time picker was removed — nothing priced
     * off it, and an arbitrary time could move the night allowance.
     *
     * Accepts a bare `YYYY-MM-DD` as well as a full ISO timestamp, because two
     * app versions are in the field at once: a new build sends the date, an
     * older one still sends a timestamp. Either way the service normalises it
     * to a fixed hour on that calendar day in the city's timezone and prices
     * off that, so the two cannot produce different fares for the same trip.
     *
     * The ORDER of the union matters: `.datetime()` is tried first so a real
     * timestamp is validated as one, with the date form as the fallback. A
     * loose `z.string().min(10)` on its own would accept "not a date!".
     */
    returnAt: z
      .string()
      .datetime()
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'returnAt must be a date (YYYY-MM-DD)'))
      .optional()
      .nullable(),

    // HOURLY: either a fixed package id, or a flexible hours commitment.
    rentalPackageId: z.coerce.number().int().positive().optional().nullable(),
    rentalHours: z.coerce.number().int().min(1).max(24).optional().nullable(),

    // false = "book me a cab now"; true = scheduled for later.
    scheduled: z.boolean().default(true),

    paymentMode: z.enum(['ZERO', 'PARTIAL', 'FULL']),

    waitingMinutes: z.coerce.number().int().min(0).max(1440).optional(),
    specialRequests: z.string().trim().max(1000).optional().nullable(),

    /*
     * Guest contact, for a booking made without signing up.
     *
     * Carried on the BOOKING because a guest's user row deliberately has no
     * phone — see guest.service for why. The driver needs a number at the kerb
     * and the invoice needs a name, whatever happens to the account after.
     *
     * Ignored for a signed-in customer: booking.service reads the customer
     * record instead, and letting a request override it would allow one
     * customer to print another's name on an invoice.
     */
    guestName: z.string().trim().min(2).max(120).optional(),
    guestPhone: z.string().trim().min(10).max(20).optional(),
    guestEmail: z.string().trim().email().max(180).optional(),

    // Staff booking on behalf of a customer. Ignored for self-service callers —
    // the service uses actor.id unless the caller holds BOOKING_MANAGE.
    customerId: uuid.optional(),

    /*
     * A promo code, re-validated server side at create.
     *
     * The app has already shown the rider the discounted total via
     * POST /discounts/check, but that answer is advisory — the code may have
     * expired or run out in the minutes since. booking.service evaluates it
     * again against the fare it prices itself, and refuses the booking rather
     * than silently charging the undiscounted amount the rider was not shown.
     *
     * Same format as discount.schemas, uppercased here so nothing downstream
     * has to remember. Empty string is treated as absent: the app clears the
     * field to "" when the rider removes a code.
     */
    promoCode: z
      .string()
      .trim()
      .toUpperCase()
      .max(32)
      .regex(/^([A-Z0-9][A-Z0-9_-]*)?$/, 'Use letters, digits, - or _')
      .optional()
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .refine((d) => d.tripType !== 'ROUND_TRIP' || !!d.returnAt, {
    message: 'A round trip needs a return date',
    path: ['returnAt'],
  })
  .refine((d) => d.tripType !== 'HOURLY' || !!d.rentalPackageId || !!d.rentalHours, {
    message: 'An hourly rental needs a package or a number of hours',
    path: ['rentalHours'],
  })
  .refine((d) => d.tripType === 'HOURLY' || !!d.drop, {
    message: 'A drop location is required',
    path: ['drop'],
  });

/**
 * Changing the car on an existing booking.
 *
 * NOTE WHAT IS ABSENT, exactly as in createBookingSchema: any fare, total or
 * amount. The new price is re-quoted server side from the booking's own stored
 * trip. An admin chooses the CLASS; the rate card chooses the money.
 *
 * `releaseAllocation` is an explicit opt-in rather than a default, because the
 * consequence is a car being taken off a trip and a driver losing a job they
 * were already committed to. The service refuses with ALLOCATED_VEHICLE_MISMATCH
 * until the admin says so deliberately.
 */
const changeVehicleSchema = z.object({
  vehicleClass: z.string().trim().min(2).max(24),
  releaseAllocation: z.boolean().default(false),
  // Goes onto the audit entry. Optional, but the first thing anyone asks when
  // they find a fare that changed after booking is "who, and why".
  reason: z.string().trim().max(500).optional().nullable(),
});

const listBookingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(['PENDING','CONFIRMED','ALLOCATED','EN_ROUTE','ONGOING','COMPLETED','CANCELLED','EXPIRED'])
    .optional(),
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']).optional(),
  customerId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  cityId: z.coerce.number().int().positive().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().trim().max(120).optional(),
  sortBy: z.enum(['createdAt', 'pickupAt', 'estimatedFare', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const listAttemptsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  outcome: z.enum(['COMPLETED', 'PENDING', 'ABANDONED', 'FAILED']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const statsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const idParamSchema = z.object({ id: uuid });
const numberParamSchema = z.object({
  bookingNumber: z.string().trim().min(3).max(20),
});

/**
 * Progress through the booking form, before a booking exists.
 *
 * Everything is optional on purpose. This fires as the rider fills the form, so
 * a partially-filled draft is the normal case — rejecting it would mean the only
 * drafts recorded are the ones that were nearly complete anyway, which is the
 * opposite of what the funnel is for.
 */
const trackDraftSchema = z.object({
  stage: z
    .enum(['STARTED', 'PICKUP_SET', 'DROP_SET', 'FARES_VIEWED', 'PAYMENT_CHOSEN'])
    .optional(),
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP', 'HOURLY', 'AIRPORT']).optional(),
  vehicleClass: z.string().trim().max(24).optional(),
  pickupAddress: z.string().trim().max(500).optional(),
  dropAddress: z.string().trim().max(500).optional(),
  pickupAt: z.string().datetime().optional(),
  estimatedFare: z.coerce.number().min(0).max(9999999).optional(),
  pickup: z.object({ lat: z.number(), lng: z.number() }).optional(),
  drop: z.object({ lat: z.number(), lng: z.number() }).optional(),
  stops: z.array(z.object({ lat: z.number(), lng: z.number() })).max(5).optional(),
});

module.exports = {
  trackDraftSchema,
  createBookingSchema,
  changeVehicleSchema,
  listBookingsQuerySchema,
  listAttemptsQuerySchema,
  statsQuerySchema,
  idParamSchema,
  numberParamSchema,
};