'use strict';
/**
 * Payments go through the website's own payment collection (Razorpay payment
 * links stored in `payments`). Capture is handled by the backend's existing
 * /api/v1/webhooks route; the bot hears about it through notifications.js.
 */
const { prisma } = require('../../config/prisma');
const paymentCollection = require('../../services/paymentCollection.service');
const { actorForBooking } = require('./actor');

const withId = (r) => (r ? { ...r, _id: r.id } : r);

async function createPaymentLink({ bookingId, amountInRupees, mode }) {
  const actor = await actorForBooking(bookingId);
  const result = await paymentCollection.createLink(
    bookingId,
    { purpose: mode === 'FULL' ? 'FULL' : 'ADVANCE', amount: String(amountInRupees) },
    actor,
    { source: 'whatsapp-bot' },
  );
  const p = result.payment;
  return { payment: withId({ ...p, attempt: 1 }), paymentUrl: p.shareUrl };
}

/** Pay later needs nothing here: the booking was created with payment mode ZERO. */
async function markBookingPayLater(bookingId) {
  const { getBookingById } = require('./bookingAdapter');
  return getBookingById(bookingId);
}

const BOT_STATUS = { CREATED: 'CREATED', AUTHORISED: 'PENDING', CAPTURED: 'CAPTURED', PARTIALLY_PAID: 'CAPTURED', FAILED: 'FAILED', REFUNDED: 'CAPTURED' };
async function getPaymentStatus(paymentId) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) throw new Error('PAYMENT_NOT_FOUND');
  const expired = p.expiresAt && new Date(p.expiresAt) < new Date() && p.status === 'CREATED';
  return withId({ ...p, status: expired ? 'TIMEOUT' : BOT_STATUS[p.status] || p.status });
}

const countPaymentAttemptsForBooking = (bookingId) => prisma.payment.count({ where: { bookingId } });

module.exports = { createPaymentLink, markBookingPayLater, getPaymentStatus, countPaymentAttemptsForBooking };
