'use strict';

/**
 * src/controllers/driverBooking.controller.js
 *
 * Driver-facing actions on a booking the driver is assigned to. Currently:
 * collecting the outstanding balance in cash after the ride.
 */

const paymentService = require('../services/payment.service');
const tripService = require('../services/trip.service');
const storageService = require('../services/storage.service');
const { prisma } = require('../config/prisma');
const { asyncHandler, ApiError } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });

exports.collectCash = asyncHandler(async (req, res) => {
  const result = await paymentService.collectCash(req.params.bookingId, req.user, meta(req));
  res.json({ success: true, message: 'Cash collected', data: result });
});

/**
 * POST /driver/bookings/:bookingId/odometer
 * The assigned driver submits the final odometer reading after the trip. Stored
 * as an `odometer` trip_event AND advances vehicles.odometer_km (forward-only).
 */
exports.recordOdometer = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;

  // Authorise: caller must be the driver on an allocation for this booking; that
  // allocation also tells us which vehicle's odometer to advance.
  const allocation = await prisma.allocation.findFirst({
    where: { bookingId, driverId: req.user.id },
    orderBy: { createdAt: 'desc' },
    select: { vehicleId: true },
  });
  if (!allocation) {
    throw ApiError.forbidden('You are not assigned to this trip', 'NOT_YOUR_TRIP');
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { status: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!['ARRIVED', 'COMPLETED'].includes(booking.status)) {
    throw ApiError.conflict('Odometer can only be submitted after the trip is completed', 'TRIP_NOT_FINISHED');
  }

  // If the driver app sent a photo file, upload it to storage (Cloudinary/mock)
  // and keep its URL + publicId. A plain photoUrl in the body still works too.
  let photoUrl = req.body.photoUrl || null;
  let photoPublicId = null;
  if (req.file) {
    const uploaded = await storageService.uploadImage(req.file.buffer, {
      folder: `odometer/${bookingId}`,
      mimetype: req.file.mimetype,
    });
    photoUrl = uploaded.url;
    photoPublicId = uploaded.publicId;
  }

  const result = await tripService.recordOdometer(bookingId, {
    odometerKm: req.body.odometerKm,
    vehicleId: allocation.vehicleId,
    photoUrl,
    photoPublicId,
    actorId: req.user.id,
  });
  res.json({ success: true, message: 'Odometer reading recorded', data: result });
});