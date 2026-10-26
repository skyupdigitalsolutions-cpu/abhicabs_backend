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

/**
 * The response shape every create shares.
 *
 * `whatsapp` is always present on a new instrument and always carries
 * `whatsappUrl`, whether or not the bot sent anything. The admin UI therefore
 * never branches on how delivery happened: it shows a "Send on WhatsApp"
 * button pointing at that URL, and marks it already-sent when `sent` is true.
 */
function created(res, { payment, reused, whatsapp }, label) {
  res.status(reused ? 200 : 201).json({
    success: true,
    message: reused ? `An active ${label} already exists for this amount` : `${label} created`,
    data: { payment, reused, whatsapp: whatsapp || null },
  });
}

exports.list = asyncHandler(async (req, res) => {
  const data = await adminPaymentService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

/* ------------------------------------------------------------------ *
 * Collecting against an existing booking
 * ------------------------------------------------------------------ */

/**
 * POST /admin/payments/bookings/:bookingId/link
 *
 * 201 for a new link, 200 when an identical live one was reused — the admin
 * needs to be able to tell "I made one" from "there already was one", because
 * the second means the customer may have already been sent it.
 */
exports.createLink = asyncHandler(async (req, res) => {
  const result = await collection.createLink(
    req.params.bookingId, req.body, req.user, meta(req),
  );
  created(res, result, 'Payment link');
});

/** POST /admin/payments/bookings/:bookingId/qr */
exports.createQr = asyncHandler(async (req, res) => {
  const result = await collection.createQr(
    req.params.bookingId, req.body, req.user, meta(req),
  );
  created(res, result, 'QR code');
});

/* ------------------------------------------------------------------ *
 * Collecting with NO booking
 *
 * Same instruments, same storage, same capture path — the only difference is
 * that the amount and the payer are stated rather than derived. These exist
 * because the booking is frequently the LAST thing to be created: a customer
 * calls, agrees a fare, and pays the advance before anyone has entered a trip.
 * ------------------------------------------------------------------ */

/** POST /admin/payments/links */
exports.createStandaloneLink = asyncHandler(async (req, res) => {
  const result = await collection.createStandaloneLink(req.body, req.user, meta(req));
  created(res, result, 'Payment link');
});

/** POST /admin/payments/qr */
exports.createStandaloneQr = asyncHandler(async (req, res) => {
  const result = await collection.createStandaloneQr(req.body, req.user, meta(req));
  created(res, result, 'QR code');
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** GET /admin/payments/bookings/:bookingId/collections */
exports.listCollections = asyncHandler(async (req, res) => {
  const items = await collection.listForBooking(req.params.bookingId);
  res.json({ success: true, data: { items } });
});

/** GET /admin/payments/collections — every link and QR, booking or not. */
exports.listAllCollections = asyncHandler(async (req, res) => {
  const data = await collection.listCollections(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

/* ------------------------------------------------------------------ *
 * Acting on one instrument
 * ------------------------------------------------------------------ */

/**
 * POST /admin/payments/:id/whatsapp
 *
 * Always 200 with a `whatsappUrl`, even when `sent` is false. A bot that is
 * down is not a failed request: the admin can still tap the link and send the
 * message themselves, and returning an error would hide that from them.
 */
exports.shareOnWhatsApp = asyncHandler(async (req, res) => {
  const data = await collection.shareOnWhatsApp(
    req.params.id,
    { phone: req.body.phone, send: req.body.send === true },
    req.user,
    meta(req),
  );
  res.json({
    success: true,
    message: data.sent ? 'Sent on WhatsApp' : 'WhatsApp message ready to send',
    data,
  });
});

/** POST /admin/payments/:id/cancel */
exports.cancelCollection = asyncHandler(async (req, res) => {
  const payment = await collection.cancel(req.params.id, req.user, meta(req));
  res.json({ success: true, message: 'No longer payable', data: { payment } });
});

/** POST /admin/payments/:id/resend — the GATEWAY's own SMS/email delivery. */
exports.resendLink = asyncHandler(async (req, res) => {
  const data = await collection.resend(
    req.params.id, req.body.medium || 'sms', req.user, meta(req),
  );
  res.json({ success: true, message: `Link resent by ${data.medium}`, data });
});

/* ------------------------------------------------------------------ *
 * Cash handovers
 * ------------------------------------------------------------------ */

/** GET /admin/payments/cash-handovers */
exports.listCashHandovers = asyncHandler(async (req, res) => {
  const data = await adminPaymentService.listCashHandovers(
    req.validatedQuery || req.query,
  );
  res.json({ success: true, data });
});

/** POST /admin/payments/:id/reconcile */
exports.reconcileCash = asyncHandler(async (req, res) => {
  const payment = await adminPaymentService.reconcileCash(
    req.params.id,
    req.body.note || null,
    req.user,
    meta(req),
  );
  res.json({
    success: true,
    message: 'Cash handover confirmed',
    data: { payment },
  });
});

/* ------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------ */

/** POST /admin/payments/refunds */
exports.createRefund = asyncHandler(async (req, res) => {
  const refund = await adminPaymentService.createRefund(
    req.body,
    req.user,
    meta(req),
  );
  res.status(201).json({
    success: true,
    message: `Refund of ₹${refund.amount} recorded`,
    data: { refund },
  });
});