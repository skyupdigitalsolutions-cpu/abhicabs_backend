'use strict';

/**
 * src/controllers/driverBooking.controller.js
 *
 * Driver-facing actions on a booking the driver is assigned to.
 *
 * READS (new): the Trips tab and Home need driver-scoped trip data. These never
 * go through the customer GET /bookings* routes (BOLA hole for drivers — B-4);
 * they filter by the caller's own allocations so a driver can only ever see
 * trips assigned to them.
 *   GET /driver/bookings            -> paginated trip history
 *   GET /driver/bookings/active     -> the one live trip (or null)
 *   GET /driver/bookings/:id        -> one trip the driver is on
 *
 * LIFECYCLE:
 *   POST /:id/en-route  ALLOCATED -> EN_ROUTE
 *   POST /:id/reached   EN_ROUTE  -> REACHED (issues customer OTP)
 *   POST /:id/start     REACHED   -> ONGOING (OTP + start odometer photo & reading)
 *   POST /:id/complete  ARRIVED   -> COMPLETED (end odometer required; invoice +
 *                                   ledger + release vehicle)
 *   POST /:id/odometer  ONGOING|ARRIVED — end odometer photo & reading, no status change
 *   POST /:id/collect-cash — money, no status change
 */

const paymentService = require('../services/payment.service');
const tripService = require('../services/trip.service');
const tripOtpService = require('../services/tripOtp.service');
const storageService = require('../services/storage.service');
const lifecycleService = require('../services/lifecycle.service');
const locationService = require('../services/location.service');
const { prisma } = require('../config/prisma');
const { asyncHandler, ApiError, paginated } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });

/** Non-terminal states a driver can still be actively working. */
const ACTIVE_STATUSES = ['ALLOCATED', 'EN_ROUTE', 'REACHED', 'ONGOING', 'ARRIVED'];

/**
 * Driver-safe projection of a booking. Deliberately excludes startOtp and all
 * customer PII beyond the name + phone a driver needs to make the pickup.
 */
const BOOKING_DRIVER_SELECT = {
  id: true,
  bookingNumber: true,
  status: true,
  tripType: true,
  vehicleClass: true,
  pickupAddress: true,
  pickupLat: true,
  pickupLng: true,
  dropAddress: true,
  dropLat: true,
  dropLng: true,
  stops: true,
  pickupAt: true,
  returnAt: true,
  distanceKm: true,
  durationMinutes: true,
  estimatedFare: true,
  finalFare: true,
  advancePaid: true,
  balanceDue: true,
  paymentMode: true,
  paymentMethod: true,
  specialRequests: true,
  reachedAt: true,
  startedAt: true,
  arrivedAt: true,
  completedAt: true,
  createdAt: true,
  // So the driver app can show the start reading on the end screen and knows
  // whether an end reading is already on file (then /complete needs no photo).
  startOdometerKm: true,
  endOdometerKm: true,
  endOdometerPhotoUrl: true,
  customer: { select: { user: { select: { name: true, phone: true } } } },
};

/** Shared: the caller must be the driver on an allocation for this booking. */
async function assertDriverOnBooking(bookingId, driverUserId) {
  const allocation = await prisma.allocation.findFirst({
    where: { bookingId, driverId: driverUserId },
    orderBy: { createdAt: 'desc' },
    select: { vehicleId: true },
  });
  if (!allocation) {
    throw ApiError.forbidden('You are not assigned to this trip', 'NOT_YOUR_TRIP');
  }
  return allocation;
}

/**
 * Record the END odometer from a driver request: req.file is the photo,
 * req.body.odometerKm the reading (already coerced by the route's schema).
 *
 * Shared by /odometer and /complete so the two cannot drift apart.
 *
 * Validates everything it can BEFORE uploading, so a mistyped reading or a
 * wrong-status trip does not leave a photo in Cloudinary. After the upload,
 * a failed write deletes the new photo; a successful REPLACEMENT deletes the
 * old one. Both deletions are best effort — a stray file is a storage cost,
 * never a reason to fail the driver's request.
 */
async function recordEndReading(req, bookingId, allocation) {
  if (!req.file) {
    throw ApiError.badRequest(
      'Upload a photo of the odometer to end the trip',
      'END_ODOMETER_PHOTO_REQUIRED',
    );
  }
  const odometerKm = req.body.odometerKm;
  if (odometerKm == null) {
    throw ApiError.badRequest('Enter the end odometer reading', 'END_ODOMETER_REQUIRED');
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { status: true, startOdometerKm: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  /*
   * ONGOING as well as ARRIVED. ARRIVED is set by GPS geofence or by ops —
   * the driver has no button for it — so a driver standing at the drop while
   * the geofence has not fired must still be able to record the reading.
   */
  if (booking.status === 'COMPLETED') {
    throw ApiError.conflict(
      'This trip is already completed and its odometer reading is locked. Contact support to correct it.',
      'ODOMETER_LOCKED',
    );
  }
  if (!['ONGOING', 'ARRIVED'].includes(booking.status)) {
    throw ApiError.conflict(
      `The end odometer can only be recorded on a trip in progress (this one is ${booking.status})`,
      'TRIP_NOT_IN_PROGRESS',
    );
  }
  if (booking.startOdometerKm != null && odometerKm < booking.startOdometerKm) {
    throw ApiError.conflict(
      `End reading ${odometerKm} km is below this trip's start reading (${booking.startOdometerKm} km). Check the number and try again.`,
      'ODOMETER_BELOW_START',
    );
  }

  const uploaded = await storageService.uploadImage(req.file.buffer, {
    folder: `odometer/${bookingId}/end`,
    mimetype: req.file.mimetype,
  });

  let result;
  try {
    result = await tripService.recordOdometer(bookingId, {
      odometerKm,
      vehicleId: allocation.vehicleId,
      photoUrl: uploaded.url,
      photoPublicId: uploaded.publicId,
      actorId: req.user.id,
    });
  } catch (err) {
    storageService.destroy(uploaded.publicId).catch(() => {});
    throw err;
  }

  if (result.replacedPublicId) {
    storageService.destroy(result.replacedPublicId).catch(() => {});
  }

  const { replacedPublicId: _omit, ...publicResult } = result;
  return { ...publicResult, photoUrl: uploaded.url };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * GET /driver/bookings?page=&limit=
 * Paginated history of every booking this driver has an allocation on.
 */
exports.list = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

  const where = { allocations: { some: { driverId: req.user.id } } };

  const [total, items] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      select: BOOKING_DRIVER_SELECT,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  res.json({ success: true, data: paginated(items, { page, limit, total }) });
});

/**
 * GET /driver/bookings/active
 * The single live trip: an ACTIVE allocation whose booking is still in flight.
 * Returns { booking: null } when the driver is idle (not an error).
 */
exports.active = asyncHandler(async (req, res) => {
  const booking = await prisma.booking.findFirst({
    where: {
      status: { in: ACTIVE_STATUSES },
      allocations: { some: { driverId: req.user.id, status: 'ACTIVE' } },
    },
    orderBy: { createdAt: 'desc' },
    select: BOOKING_DRIVER_SELECT,
  });

  res.json({ success: true, data: { booking: booking || null } });
});

/**
 * GET /driver/bookings/:bookingId
 * One trip — only if the caller is the allocated driver (no IDOR leakage).
 */
exports.getById = asyncHandler(async (req, res) => {
  await assertDriverOnBooking(req.params.bookingId, req.user.id);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.bookingId },
    select: BOOKING_DRIVER_SELECT,
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  res.json({ success: true, data: { booking } });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * POST /driver/bookings/:bookingId/en-route
 * ALLOCATED -> EN_ROUTE. Driver is heading to the pickup point.
 */
exports.enRoute = asyncHandler(async (req, res) => {
  await assertDriverOnBooking(req.params.bookingId, req.user.id);
  const booking = await lifecycleService.markEnRoute(req.params.bookingId, req.user, meta(req));
  res.json({ success: true, message: 'On the way to pickup', data: { booking } });
});

/**
 * POST /driver/bookings/:bookingId/reached
 * EN_ROUTE -> REACHED. Stamps reached_at and issues the customer's start OTP.
 */
exports.recordReached = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  await assertDriverOnBooking(bookingId, req.user.id);

  let lat = null;
  let lng = null;
  try {
    const pos = await locationService.driverLocation(req.user.id);
    if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
      lat = pos.lat;
      lng = pos.lng;
    }
  } catch (_e) { /* ignore */ }

  const booking = await lifecycleService.markReached(bookingId, req.user, meta(req), { lat, lng });
  res.json({
    success: true,
    message: 'Marked reached at pickup',
    data: { bookingId, status: booking.status, reachedAt: booking.reachedAt },
  });
});

/**
 * POST /driver/bookings/:bookingId/start   (multipart/form-data)
 * REACHED -> ONGOING.
 *
 * Fields: otp (or startOtp), odometerKm, lat?, lng?
 * File:   photo — the dashboard showing the odometer. REQUIRED.
 *
 * ORDER OF CHECKS — cheapest and most likely to fail first, the upload last:
 *
 *   1. driver is on this trip            no upload for someone else's trip
 *   2. photo and reading are present     instant, no I/O
 *   3. booking is in a startable status  one read
 *   4. reading >= vehicle's odometer     one read
 *   5. OTP                               a wrong code must not leave an
 *                                        orphaned photo in Cloudinary on
 *                                        every guess
 *   6. upload the photo
 *   7. lifecycle.startTrip               re-verifies the OTP (a verified code
 *                                        passes again, by design) and writes
 *                                        the reading, photo and status in ONE
 *                                        transaction
 *
 * If 7 fails after 6, the photo is destroyed rather than left behind.
 */
exports.startTrip = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const allocation = await assertDriverOnBooking(bookingId, req.user.id);

  if (!req.file) {
    throw ApiError.badRequest(
      'Upload a photo of the odometer before starting the trip',
      'START_ODOMETER_PHOTO_REQUIRED',
    );
  }
  const odometerKm = req.body.odometerKm;
  if (odometerKm == null) {
    throw ApiError.badRequest(
      'Enter the odometer reading before starting the trip',
      'START_ODOMETER_REQUIRED',
    );
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { status: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!['EN_ROUTE', 'REACHED'].includes(booking.status)) {
    throw ApiError.conflict(
      `A ${booking.status} trip cannot be started`,
      'INVALID_STATUS_TRANSITION',
    );
  }

  if (allocation.vehicleId) {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: allocation.vehicleId },
      select: { odometerKm: true },
    });
    if (vehicle && odometerKm < vehicle.odometerKm) {
      throw ApiError.conflict(
        `Reading ${odometerKm} km is below the vehicle's last recorded odometer (${vehicle.odometerKm} km). Check the number and try again.`,
        'ODOMETER_BELOW_CURRENT',
      );
    }
  }

  const startOtp = req.body.startOtp ?? req.body.otp ?? null;
  await tripOtpService.verify(bookingId, startOtp);

  const uploaded = await storageService.uploadImage(req.file.buffer, {
    folder: `odometer/${bookingId}/start`,
    mimetype: req.file.mimetype,
  });

  let started;
  try {
    started = await lifecycleService.startTrip(bookingId, req.user, meta(req), {
      lat: req.body.lat ?? null,
      lng: req.body.lng ?? null,
      odometerKm,
      startOtp,
      odometerPhotoUrl: uploaded.url,
      odometerPhotoPublicId: uploaded.publicId,
      vehicleId: allocation.vehicleId,
    });
  } catch (err) {
    // The trip did not start, so nothing references this photo. Best effort:
    // a failed cleanup is a stray file, never a reason to mask the real error.
    storageService.destroy(uploaded.publicId).catch(() => {});
    throw err;
  }

  res.json({ success: true, message: 'Trip started', data: { booking: started } });
});

/**
 * POST /driver/bookings/:bookingId/complete   (multipart/form-data)
 * ARRIVED -> COMPLETED. Reconciles fare (if actualKm given), finalises invoice +
 * ledger and releases the vehicle — all inside lifecycle.completeTrip.
 *
 * Fields: odometerKm?, actualKm?, finalFare?, lat?, lng?
 * File:   photo?
 *
 * The END odometer is REQUIRED to complete, and can arrive two ways:
 *
 *   - with this request (photo + odometerKm), or
 *   - earlier, via POST /:id/odometer — then this request needs neither.
 *
 * Both exist because completion can be REFUSED by the payment gate
 * ("Outstanding balance must be paid"). A reading sent here is recorded
 * BEFORE completion is attempted and stays recorded if completion is then
 * refused, so the retry after the rider pays needs no second photo.
 */
exports.complete = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const allocation = await assertDriverOnBooking(bookingId, req.user.id);

  // Sending one half without the other is a client bug, not a request to
  // rely on the reading already on file — refuse it rather than guess.
  const sentPhoto = !!req.file;
  const sentReading = req.body.odometerKm != null;
  if (sentPhoto !== sentReading) {
    throw ApiError.badRequest(
      sentPhoto
        ? 'Enter the end odometer reading with the photo'
        : 'Upload a photo of the odometer with the reading',
      sentPhoto ? 'END_ODOMETER_REQUIRED' : 'END_ODOMETER_PHOTO_REQUIRED',
    );
  }

  let odometer = null;
  if (sentPhoto) {
    odometer = await recordEndReading(req, bookingId, allocation);
  }

  // lifecycle.completeTrip refuses (END_ODOMETER_REQUIRED) if neither this
  // request nor an earlier /odometer call left a reading on the booking.
  const booking = await lifecycleService.completeTrip(bookingId, req.user, meta(req), {
    finalFare: req.body.finalFare ?? null,
    odometerKm: null, // read from the booking — the value recorded above or earlier
    actualKm: req.body.actualKm ?? null,
    lat: req.body.lat ?? null,
    lng: req.body.lng ?? null,
  });

  res.json({ success: true, message: 'Trip completed', data: { booking, odometer } });
});

/**
 * POST /driver/bookings/:bookingId/collect-cash
 * Collect the outstanding cash balance after the ride. Idempotent.
 */
exports.collectCash = asyncHandler(async (req, res) => {
  const result = await paymentService.collectCash(req.params.bookingId, req.user, meta(req));
  res.json({ success: true, message: 'Cash collected', data: result });
});

/**
 * POST /driver/bookings/:bookingId/odometer   (multipart/form-data)
 * The END odometer reading and its photo — both REQUIRED. No status change.
 *
 * Fields: odometerKm      File: photo
 *
 * Allowed while the trip is ONGOING or ARRIVED; refused once COMPLETED.
 * Submitting again before completion REPLACES the earlier reading and photo,
 * so a typo can be fixed at the kerb.
 *
 * Optional to call: /complete accepts the same photo and reading. This route
 * lets the driver app record the reading the moment the car stops, while the
 * rider is still paying.
 */
exports.recordOdometer = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const allocation = await assertDriverOnBooking(bookingId, req.user.id);

  const result = await recordEndReading(req, bookingId, allocation);
  res.json({
    success: true,
    message: result.replaced ? 'End odometer reading updated' : 'End odometer reading recorded',
    data: result,
  });
});