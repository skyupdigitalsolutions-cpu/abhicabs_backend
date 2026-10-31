'use strict';
/** The website's own cancellation policy, fee and refund — not a copy of it. */
const { prisma } = require('../../config/prisma');
const cancellation = require('../../services/cancellation.service');
const { toBotBooking } = require('./bookingMapper');
const { actorForBooking } = require('./actor');

async function getAvailableActions(bookingId) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
  if (!b) return [];
  const actions = ['VIEW_DETAILS', 'INVOICE'];
  if (['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE'].includes(b.status)) actions.push('CANCEL');
  if (['ALLOCATED', 'EN_ROUTE', 'REACHED', 'ARRIVED', 'ONGOING'].includes(b.status)) actions.push('TRACK');
  return actions;
}

async function getCancellationQuote(bookingId) {
  const q = await cancellation.quoteCancellation(bookingId, await actorForBooking(bookingId));
  if (!q.cancellable) throw new Error('BOOKING_NOT_CANCELLABLE');
  return { bookingId, fee: Number(q.fee), refundAmount: Number(q.refundAmount), feePercent: null, band: q.band || null, policy: q.policy, currency: 'INR' };
}

async function cancelBooking(bookingId, { reason } = {}) {
  const actor = await actorForBooking(bookingId);
  try {
    await cancellation.cancel(bookingId, actor, { reason });
  } catch (err) {
    if (err && (err.code === 'INVALID_STATUS_TRANSITION' || err.statusCode === 409)) throw new Error('BOOKING_NOT_CANCELLABLE');
    throw err;
  }
  return toBotBooking(await prisma.booking.findUnique({ where: { id: bookingId } }));
}

module.exports = { getAvailableActions, getCancellationQuote, cancelBooking };
