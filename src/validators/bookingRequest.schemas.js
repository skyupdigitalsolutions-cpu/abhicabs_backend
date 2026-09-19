'use strict';

/**
 * src/validators/bookingRequest.schemas.js
 *
 * Deliberately looser than booking.schemas.js.
 *
 * A booking has to be precise because a machine prices and dispatches it. A
 * request is read by a person who will phone the customer back, so the bar is
 * "enough to call them about", not "enough to execute". Coordinates are
 * optional for exactly that reason: an out-of-area place may never have been
 * geocoded, and demanding a lat/lng would refuse the enquiries this exists to
 * capture.
 */

const { z } = require('zod');

const uuid = z.string().uuid();

const tripType = z.enum(['ONE_WAY', 'ROUND_TRIP', 'HOURLY', 'AIRPORT']);

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

/** An ISO timestamp that is not in the past. */
const futureDate = z
  .string()
  .datetime({ offset: true })
  .refine((v) => new Date(v).getTime() > Date.now() - 60_000, {
    message: 'Pickup time cannot be in the past',
  });

const createSchema = z
  .object({
    tripType,
    vehicleClass: z.string().trim().max(24).optional(),

    pickupAddress: z.string().trim().min(3).max(500),
    pickupLat: lat.optional(),
    pickupLng: lng.optional(),
    /** Whatever the maps provider reported, so the server need not re-geocode. */
    pickupState: z.string().trim().max(64).optional(),

    dropAddress: z.string().trim().min(3).max(500),
    dropLat: lat.optional(),
    dropLng: lng.optional(),
    dropState: z.string().trim().max(64).optional(),

    pickupAt: futureDate,
    returnAt: z.string().datetime({ offset: true }).optional(),

    passengers: z.coerce.number().int().min(1).max(60).optional(),
    note: z.string().trim().max(500).optional(),

    // Override the account's details when someone books for a colleague.
    contactName: z.string().trim().min(2).max(120).optional(),
    contactPhone: z.string().trim().min(6).max(20).optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(180).optional(),

    // Staff raising a request on a customer's behalf, from a phone call.
    customerId: uuid.optional(),
  })
  .refine((v) => v.tripType !== 'ROUND_TRIP' || Boolean(v.returnAt), {
    message: 'A round trip needs a return date',
    path: ['returnAt'],
  })
  .refine(
    (v) => !v.returnAt || new Date(v.returnAt) >= new Date(v.pickupAt),
    { message: 'Return cannot be before pickup', path: ['returnAt'] },
  );

const listQuerySchema = z.object({
  status: z
    .enum(['NEW', 'REVIEWING', 'QUOTED', 'ACCEPTED', 'DECLINED', 'CANCELLED'])
    .optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

const updateStatusSchema = z
  .object({
    status: z.enum(['REVIEWING', 'QUOTED', 'ACCEPTED', 'DECLINED']).optional(),
    adminNote: z.string().trim().max(1000).optional(),
    convertedBookingId: uuid.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine((v) => v.status !== 'ACCEPTED' || Boolean(v.convertedBookingId), {
    // ACCEPTED means "this became a real trip". Without the booking id the
    // request claims a conversion nobody can trace, and the link between the
    // enquiry and the trip it produced is lost.
    message: 'Accepting a request needs the id of the booking it became',
    path: ['convertedBookingId'],
  });

const idParamSchema = z.object({ id: uuid });

module.exports = { createSchema, listQuerySchema, updateStatusSchema, idParamSchema };