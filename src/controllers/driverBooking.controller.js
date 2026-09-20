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
 *   POST /:id/start     REACHED   -> ONGOING (OTP checked in lifecycle.startTrip)
 *   POST /:id/complete  ARRIVED   -> COMPLETED (invoice + ledger + release vehicle)
 *   POST /:id/collect-cash / /odometer — money + record, no status change
 */

const paymentService = require('../services/payment.service');
const tripService = require('../services/trip.service');
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
 * POST /driver/bookings/:bookingId/start
 * REACHED -> ONGOING. Rider reads their code; driver types it. The OTP is
 * checked inside lifecycle.startTrip, so this route cannot bypass it.
 */
exports.startTrip = asyncHandler(async (req, res) => {
  await assertDriverOnBooking(req.params.bookingId, req.user.id);

  const booking = await lifecycleService.startTrip(req.params.bookingId, req.user, meta(req), {
    lat: req.body?.lat ?? null,
    lng: req.body?.lng ?? null,
    odometerKm: req.body?.odometerKm ?? null,
    startOtp: req.body?.startOtp ?? req.body?.otp ?? null,
  });

  res.json({ success: true, message: 'Trip started', data: { booking } });
});

/**
 * POST /driver/bookings/:bookingId/complete
 * ARRIVED -> COMPLETED. Reconciles fare (if actualKm given), finalises invoice +
 * ledger and releases the vehicle — all inside lifecycle.completeTrip.
 */
exports.complete = asyncHandler(async (req, res) => {
  await assertDriverOnBooking(req.params.bookingId, req.user.id);

  const booking = await lifecycleService.completeTrip(req.params.bookingId, req.user, meta(req), {
    finalFare: req.body?.finalFare ?? null,
    odometerKm: req.body?.odometerKm ?? null,
    actualKm: req.body?.actualKm ?? null,
    lat: req.body?.lat ?? null,
    lng: req.body?.lng ?? null,
  });

  res.json({ success: true, message: 'Trip completed', data: { booking } });
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
 * POST /driver/bookings/:bookingId/odometer
 * Final odometer reading (+ optional photo) after the trip. A record, not a
 * status change.
 */
exports.recordOdometer = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;

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
