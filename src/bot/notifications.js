'use strict';
/**
 * The website backend already receives Razorpay webhooks and drives the booking
 * life-cycle. The bot just LISTENS to those events and tells WhatsApp customers.
 * Only bookings that were made on WhatsApp are messaged (meta.source = 'whatsapp-bot').
 */
const { bus, EVENTS } = require('../lib/events');
const { prisma } = require('../config/prisma');
const { logger } = require('./config/logger');
const { wrapSession } = require('./conversation/sessionRecord');
const { toBotBooking } = require('./adapters/bookingMapper');
const { notifyPaymentCaptured } = require('./conversation/handlers/payment.handler');
const { inr, fmtDateTime } = require('./utils/format');
const env = require('./config/env');
const { deliver } = require('./conversation/serviceWindow');

async function loadContext(bookingId) {
  const row = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!row || !row.meta || row.meta.source !== 'whatsapp-bot') return null;
  // The customer's most recent chat (one customer can have written from more than one number).
  const sessionRow = await prisma.whatsappSession.findFirst({ where: { customerId: row.customerId }, orderBy: { lastMessageAt: 'desc' } });
  if (!sessionRow) return null;
  return { row, session: wrapSession(sessionRow) };
}

function safe(name, fn) {
  return (payload) => {
    Promise.resolve()
      .then(() => fn(payload))
      .catch((err) => logger.error({ err: err.message, event: name }, '[bot-notify] could not message the customer'));
  };
}

function start() {
  bus.on(EVENTS.PAYMENT_RECEIVED, safe('payment.received', async (p) => {
    const ctx = await loadContext(p.bookingId);
    if (!ctx) return;
    const booking = await toBotBooking(ctx.row);
    const pay = await prisma.payment.findUnique({ where: { id: p.paymentId } });
    await notifyPaymentCaptured(ctx.session, booking, { _id: pay && pay.id, razorpayPaymentId: pay && pay.providerPaymentId, attempt: 1 }, Number(p.amount));
  }));

  bus.on(EVENTS.BOOKING_CONFIRMED, safe('booking.confirmed', async (p) => {
    const ctx = await loadContext(p.bookingId);
    if (!ctx) return;
    const when = fmtDateTime(p.pickupAt);
    await deliver({
      to: ctx.session.whatsappNumber,
      lastMessageAt: ctx.session.lastMessageAt,
      what: 'booking.confirmed',
      text: `✅ *Booking confirmed*\nYour booking ${p.bookingNumber} for ${when} is confirmed by our team. We will share the driver and cab details here before pickup.`,
      template: env.BOOKING_CONFIRMED_TEMPLATE,
      params: [p.bookingNumber, when],
    });
  }));

  bus.on(EVENTS.ALLOCATION_MADE, safe('allocation.made', async (p) => {
    const ctx = await loadContext(p.bookingId);
    if (!ctx) return;
    const booking = await toBotBooking(ctx.row);
    if (!booking.driver) return;
    const d = booking.driver;
    await deliver({
      to: ctx.session.whatsappNumber,
      lastMessageAt: ctx.session.lastMessageAt,
      what: 'allocation.made',
      text:
        `🚗 *Driver assigned* — ${booking.bookingNumber}\n` +
        (d.name ? `👨‍✈️ ${d.name}${d.phone ? ` (${d.phone})` : ''}\n` : '') +
        (d.vehicleNumber ? `🔢 ${d.vehicleNumber}${d.vehicleModel ? ` · ${d.vehicleModel}` : ''}\n` : '') +
        (booking.startOtp ? `🔐 Trip start code: *${booking.startOtp}* (tell the driver at pickup)` : ''),
      template: env.DRIVER_ASSIGNED_TEMPLATE,
      params: [
        booking.bookingNumber,
        d.name || 'Our driver',
        d.phone || '-',
        [d.vehicleNumber, d.vehicleModel].filter(Boolean).join(' · ') || '-',
        booking.startOtp || '-',
      ],
    });
  }));

  bus.on(EVENTS.BOOKING_CANCELLED, safe('booking.cancelled', async (p) => {
    if (p.cancelledByType === 'CUSTOMER') return; // the customer just did it in the chat and already saw the result
    const ctx = await loadContext(p.bookingId);
    if (!ctx) return;
    const refund = Number(p.refundAmount) > 0 ? `Refund: ${inr(Number(p.refundAmount))}.` : '';
    await deliver({
      to: ctx.session.whatsappNumber,
      lastMessageAt: ctx.session.lastMessageAt,
      what: 'booking.cancelled',
      text: `❌ Your booking ${p.bookingNumber} was cancelled by our team.${refund ? ` ${refund}` : ''} Reply "support" if you need help.`,
      template: env.BOOKING_CANCELLED_TEMPLATE,
      params: [p.bookingNumber, refund || 'No payment to refund.'],
    });
  }));

  logger.info('[bot-notify] listening to booking and payment events');
}

module.exports = { start };
