'use strict';

/**
 * src/controllers/invoice.controller.js   — Day 8
 */

const billing = require('../services/billing.service');
const bookingService = require('../services/booking.service');
const { asyncHandler } = require('../utils/helpers');

/* ---------------- admin ---------------- */

exports.getOne = asyncHandler(async (req, res) => {
  const invoice = await billing.getInvoice(req.params.id);
  res.json({ success: true, data: { invoice } });
});

exports.getForBooking = asyncHandler(async (req, res) => {
  const invoice = await billing.getInvoiceForBooking(req.params.bookingId);
  res.json({ success: true, data: { invoice } });
});

exports.ledgerForBooking = asyncHandler(async (req, res) => {
  const [ledger, balance] = await Promise.all([
    billing.listLedgerForBooking(req.params.bookingId),
    billing.deriveBookingBalance(req.params.bookingId),
  ]);
  res.json({ success: true, data: { ledger, balance } });
});

/* ---------------- customer ---------------- */

/**
 * A customer's own invoice for one of their bookings. Ownership is enforced by
 * loading the booking through the service first — findById throws if the
 * caller is not the owner (or an admin) — so a customer cannot read someone
 * else's invoice by guessing a booking id.
 */
exports.myInvoice = asyncHandler(async (req, res) => {
  await bookingService.findById(req.params.id, req.user); // ownership gate
  const invoice = await billing.getInvoiceForBooking(req.params.id);
  res.json({ success: true, data: { invoice } });
});