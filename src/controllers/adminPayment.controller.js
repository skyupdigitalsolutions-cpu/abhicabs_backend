'use strict';

/**
 * src/controllers/adminPayment.controller.js
 */

const adminPaymentService = require('../services/adminPayment.service');
const collection = require('../services/paymentCollection.service');
const { asyncHandler } = require('../utils/helpers');

/** Request context carried onto every audit entry. */
function meta(req) {
  return {
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
    source: 'admin',
  };
}

exports.list = asyncHandler(async (req, res) => {
  const data = await adminPaymentService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

/* ------------------------------------------------------------------ *
 * Collecting without the app: links and QR codes
 * ------------------------------------------------------------------ */

/**
 * POST /admin/payments/bookings/:bookingId/link
 *
 * 201 for a new link, 200 when an identical live one was reused — the admin
 * needs to be able to tell "I made one" from "there already was one", because
 * the second means the customer may have already been sent it.
 */
exports.createLink = asyncHandler(async (req, res) => {
  const { payment, reused } = await collection.createLink(
    req.params.bookingId, req.body, req.user, meta(req),
  );
  res.status(reused ? 200 : 201).json({
    success: true,
    message: reused ? 'An active payment link already exists for this amount' : 'Payment link created',
    data: { payment, reused },
  });
});

/** POST /admin/payments/bookings/:bookingId/qr */
exports.createQr = asyncHandler(async (req, res) => {
  const { payment, reused } = await collection.createQr(
    req.params.bookingId, req.body, req.user, meta(req),
  );
  res.status(reused ? 200 : 201).json({
    success: true,
    message: reused ? 'An active QR code already exists for this amount' : 'QR code created',
    data: { payment, reused },
  });
});

/** GET /admin/payments/bookings/:bookingId/collections */
exports.listCollections = asyncHandler(async (req, res) => {
  const items = await collection.listForBooking(req.params.bookingId);
  res.json({ success: true, data: { items } });
});

/** POST /admin/payments/:id/cancel */
exports.cancelCollection = asyncHandler(async (req, res) => {
  const payment = await collection.cancel(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'No longer payable', data: { payment } });
});

/** POST /admin/payments/:id/resend */
exports.resendLink = asyncHandler(async (req, res) => {
  const data = await collection.resend(
    req.params.id, req.body.medium || 'sms', req.user, meta(req),
  );
  res.json({ success: true, message: `Link resent by ${data.medium}`, data });
});