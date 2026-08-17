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
    tripType: z.enum(['ONE_WAY', 'ROUND_TRIP']),

    pickup: location,
    drop: location,
    stops: z.array(location).max(10).optional(),

    pickupAt: z.string().datetime({ message: 'pickupAt must be an ISO datetime' }),
    returnAt: z.string().datetime().optional().nullable(),

    // false = "book me a cab now"; true = scheduled for later.
    scheduled: z.boolean().default(true),

    paymentMode: z.enum(['ZERO', 'PARTIAL', 'FULL']),

    waitingMinutes: z.coerce.number().int().min(0).max(1440).optional(),
    specialRequests: z.string().trim().max(1000).optional().nullable(),

    // Staff booking on behalf of a customer. Ignored for self-service callers —
    // the service uses actor.id unless the caller holds BOOKING_MANAGE.
    customerId: uuid.optional(),
  })
  .refine((d) => d.tripType !== 'ROUND_TRIP' || !!d.returnAt, {
    message: 'A round trip needs a return date and time',
    path: ['returnAt'],
  });

const listBookingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(['PENDING','CONFIRMED','ALLOCATED','EN_ROUTE','ONGOING','COMPLETED','CANCELLED','EXPIRED'])
    .optional(),
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP']).optional(),
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

module.exports = {
  createBookingSchema,
  listBookingsQuerySchema,
  listAttemptsQuerySchema,
  statsQuerySchema,
  idParamSchema,
  numberParamSchema,
};