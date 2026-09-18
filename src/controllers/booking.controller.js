'use strict';

/**
 * src/controllers/booking.controller.js
 */

const bookingService = require('../services/booking.service');
const funnel = require('../services/funnel.service');
const summaryService = require('../services/summary.service');
const { asyncHandler, ApiError } = require('../utils/helpers');

const meta = (req) => ({
  ip: req.ip || '',
  userAgent: req.get('user-agent') || '',
  source: req.get('x-client-source') || 'api',
});

exports.create = asyncHandler(async (req, res) => {
  const body = { ...req.body };

  // Booking for someone else requires the capability. Without this a customer
  // could pass another customerId and create bookings in their name.
  if (body.customerId && body.customerId !== req.user.id) {
    const allowed = req.permissions?.includes('BOOKING_MANAGE');
    if (!allowed) {
      throw ApiError.forbidden('You cannot book on behalf of another customer', 'NOT_PERMITTED');
    }
  }

  const result = await bookingService.create(body, req.user, meta(req));
  res.status(201).json({ success: true, message: 'Booking created', data: result });
});

exports.getOne = asyncHandler(async (req, res) => {
  const booking = await bookingService.findById(req.params.id, req.user);
  res.json({ success: true, data: { booking } });
});

// Day 14: per-screen aggregate — booking + payments + allocation + invoice +
// live location in one owner-scoped call, so the trip-detail screen is a single
// round-trip instead of five.
exports.summary = asyncHandler(async (req, res) => {
  const data = await summaryService.bookingSummary(req.params.id, req.user);
  res.json({ success: true, data });
});

exports.getByNumber = asyncHandler(async (req, res) => {
  const booking = await bookingService.findByNumber(req.params.bookingNumber, req.user);
  res.json({ success: true, data: { booking } });
});

exports.list = asyncHandler(async (req, res) => {
  const data = await bookingService.list(req.validatedQuery || req.query, req.user);
  res.json({ success: true, data });
});

exports.listAttempts = asyncHandler(async (req, res) => {
  const data = await bookingService.listAttempts(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.stats = asyncHandler(async (req, res) => {
  const data = await bookingService.stats(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

/**
 * POST /bookings/draft — record progress through the booking form.
 *
 * Fire-and-forget from the app's point of view: it returns 202 and never blocks
 * the rider. A tracking call that can fail a booking form is worse than one
 * that occasionally records nothing, so failures are swallowed rather than
 * surfaced.
 */
exports.trackDraft = asyncHandler(async (req, res) => {
  try {
    await funnel.track(req.user.id, req.body, {
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
      source: req.get('x-client') || 'api',
    });
  } catch (err) {
    console.error(`[funnel] track failed: ${err.message}`);
  }
  res.status(202).json({ success: true });
});