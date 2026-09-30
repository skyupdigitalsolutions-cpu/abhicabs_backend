'use strict';

/**
 * src/controllers/invoice.controller.js   — Day 8
 */

const billing = require('../services/billing.service');
const bookingService = require('../services/booking.service');
const { asyncHandler, ApiError } = require('../utils/helpers');
const { buildInvoiceHtml } = require('../services/invoiceTemplate');
const gstService = require('../services/gst.service');
const env = require('../config/env');

/* ---------------- admin ---------------- */

/**
 * GET /admin/invoices — the paginated list the admin Invoices screen reads.
 *
 * Kept in the same envelope as the other admin lists so the ERP's shared
 * unwrap helper needs no special case.
 */
exports.list = asyncHandler(async (req, res) => {
  const data = await billing.listInvoices(req.validatedQuery || req.query || {});
  res.json({ success: true, data });
});

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

/**
 * The invoice as rendered HTML, for the app to turn into a PDF.
 *
 * Returned as a JSON string rather than as text/html on purpose: the app is
 * fetching markup to feed to expo-print, not navigating to a page, and every
 * other endpoint it calls speaks the same envelope. A raw HTML response would
 * need special-casing in the API client for one route.
 *
 * The SAME template the invoice email uses. That is the point of this
 * endpoint — a rider who downloads the invoice and a finance team reading the
 * emailed copy must be looking at identical documents, and two renderers would
 * drift the first time either was touched.
 */
exports.myInvoiceHtml = asyncHandler(async (req, res) => {
  const booking = await bookingService.findById(req.params.id, req.user);
  const invoice = await billing.getInvoiceForBooking(req.params.id);

  if (!invoice) {
    throw ApiError.notFound('This trip has no invoice yet', 'NO_INVOICE');
  }

  // Seller details come from the INVOICE's own snapshot first. An invoice must
  // render as it was issued, even if the registration has changed since.
  const gstConfig = await gstService.resolveConfig(invoice.placeOfSupply).catch(() => null);

  const html = buildInvoiceHtml({
    invoice,
    booking,
    customer: booking.customer?.user ?? null,
    seller: {
      address: invoice.sellerAddress || gstConfig?.address || null,
      gstin: invoice.sellerGstin || gstConfig?.gstin || null,
      supportEmail: env.mail?.replyTo || 'support@abhicabs.in',
    },
  });

  res.json({
    success: true,
    data: {
      html,
      // So the app can name the file without parsing the markup.
      fileName: `AbhiCabs-${String(invoice.invoiceNumber).replace(/\//g, '-')}.pdf`,
      invoiceNumber: invoice.invoiceNumber,
    },
  });
});