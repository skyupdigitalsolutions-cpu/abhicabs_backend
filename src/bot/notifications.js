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
const { makeSender } = require('./conversation/outbound');
const { toBotBooking } = require('./adapters/bookingMapper');
const { notifyPaymentCaptured } = require('./conversation/handlers/payment.handler');
const { inr, fmtDateTime } = require('./utils/format');

async function loadContext(bookingId) {
  const row = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!row || !row.meta || row.meta.source !== 'whatsapp-bot') return null;
  const sessionRow = await prisma.whatsappSession.findFirst({ where: { customerId: row.customerId } });
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
    const send = makeSender(ctx.session.whatsappNumber, ctx.session.language || 'en');
    await send.raw(`✅ *Booking confirmed*\nYour booking ${p.bookingNumber} for ${fmtDateTime(p.pickupAt)} is confirmed by our team. We will share the driver and cab details here before pickup.`);
  }));

  bus.on(EVENTS.ALLOCATION_MADE, safe('allocation.made', async (p) => {
    const ctx = await loadContext(p.bookingId);
    if (!ctx) return;
    const booking = await toBotBooking(ctx.row);
    if (!booking.driver) return;
    const d = booking.driver;
    const send = makeSender(ctx.session.whatsappNumber, ctx.session.language || 'en');
    await send.raw(
      `🚗 *Driver assigned* — ${booking.bookingNumber}\n` +
        (d.name ? `👨‍✈️ ${d.name}${d.phone ? ` (${d.phone})` : ''}\n` : '') +
        (d.vehicleNumber ? `🔢 ${d.vehicleNumber}${d.vehicleModel ? ` · ${d.vehicleModel}` : ''}\n` : '') +
        (booking.startOtp ? `🔐 Trip start code: *${booking.startOtp}* (tell the driver at pickup)` : ''),
    );
  }));

  bus.on(EVENTS.BOOKING_CANCELLED, safe('booking.cancelled', async (p) => {
    if (p.cancelledByType === 'CUSTOMER') return; // the customer just did it in the chat and already saw the result
    const ctx = await loadContext(p.bookingId);
    if (!ctx) return;
    const send = makeSender(ctx.session.whatsappNumber, ctx.session.language || 'en');
    await send.raw(`❌ Your booking ${p.bookingNumber} was cancelled by our team.${Number(p.refundAmount) > 0 ? ` Refund: ${inr(Number(p.refundAmount))}.` : ''} Reply "support" if you need help.`);
  }));

  logger.info('[bot-notify] listening to booking and payment events');
}

module.exports = { start };
