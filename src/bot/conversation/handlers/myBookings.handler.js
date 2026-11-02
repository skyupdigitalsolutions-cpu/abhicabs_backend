const { fmtShortDate, fmtDateTime } = require('../../utils/format');
const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { callTool } = require('../../integrations/ai/tools');
const { logger } = require('../../config/logger');
const { toNumbered, rememberOptions } = require('../numberedMenu');

async function showMyBookings(ctx) {
  const { customer, session } = ctx;

  let bookings;
  try {
    bookings = await callTool('getBookingsForCustomer', customer._id, { limit: 5 });
  } catch (err) {
    logger.error({ err: err.message }, '[myBookings] lookup failed');
    await ctx.send.text('generic_error');
    return;
  }

  if (!bookings || bookings.length === 0) {
    await ctx.send.text('no_bookings_found');
    const { renderMainMenu } = require('./mainMenu.handler');
    await transition(session, STATES.MAIN_MENU);
    await renderMainMenu(ctx);
    return;
  }

  const rows = bookings.map((b, i) => ({
    id: `BOOKING_${b._id}`,
    number: i + 1,
    label: b.bookingNumber,
    description: `${b.pickup.address} → ${b.drop?.address || '-'} · ${fmtShortDate(b.pickupAt)} · ${b.status}`,
  }));
  const { rows: numberedRows, map } = toNumbered(rows);

  await transition(session, STATES.BOOKING_DETAILS);
  await ctx.send.list('your_bookings', 'your_bookings', [{ title: 'Bookings', rows: numberedRows }]);
  await rememberOptions(session, map);
}

async function handleBookingDetailsSelection(ctx) {
  const { message, session } = ctx;
  const id = message.interactiveId || '';

  if (id === 'MENU_INVOICE') {
    await promptBookingForInvoice(ctx);
    return;
  }
  if (id === 'MENU_TRACK_BOOKING') {
    const { promptBookingForTracking } = require('./tracking.handler');
    await promptBookingForTracking(ctx);
    return;
  }
  if (id === 'MENU_CANCEL_BOOKING') {
    const { promptBookingForCancellation } = require('./cancellation.handler');
    await promptBookingForCancellation(ctx);
    return;
  }

  const bookingId = id.replace(/^BOOKING_/, '');
  if (!bookingId) {
    await showMyBookings(ctx);
    return;
  }

  session.activeBookingId = bookingId;
  await session.save();

  const summary = await callTool('getBookingSummary', bookingId);
  if (!summary) {
    await ctx.send.text('generic_error');
    return;
  }

  const b = summary.booking;
  const body =
    `Booking: ${b.bookingNumber}\n` +
    `Status: ${b.status}\n` +
    `📍 ${b.pickup.address} → ${b.drop?.address || '-'}\n` +
    `📅 ${fmtDateTime(b.pickupAt)}\n` +
    `🚗 ${b.vehicle.name}\n` +
    `💰 ₹${b.fare.total}\n` +
    (summary.payment ? `Payment: ${summary.payment.status}\n` : '') +
    (b.driver?.name ? `Driver: ${b.driver.name} · ${b.driver.phone}\n` : '');

  const buttons = [{ id: 'MENU_INVOICE', label: t(ctx.language, 'menu_invoice') }];
  if (['CONFIRMED', 'DRIVER_ASSIGNED', 'ONGOING'].includes(b.status)) {
    buttons.push({ id: 'MENU_TRACK_BOOKING', label: t(ctx.language, 'menu_track_booking') });
  }
  if (!['CANCELLED', 'COMPLETED', 'ONGOING', 'EXPIRED'].includes(b.status)) {
    buttons.push({ id: 'MENU_CANCEL_BOOKING', label: t(ctx.language, 'menu_cancel_booking') });
  }
  const numberedButtons = buttons.slice(0, 3).map((btn, i) => ({ ...btn, number: i + 1, maxTitleLength: 20 }));
  const { rows, map } = toNumbered(numberedButtons);

  await ctx.send.buttonsRaw(body, rows.map((r) => ({ id: r.id, title: r.title })));
  await rememberOptions(session, map);
}

/** "Download Invoice" from the main menu — first ask which booking if not already selected. */
async function promptBookingForInvoice(ctx) {
  const { session } = ctx;
  const bookingId = session.activeBookingId;

  if (!bookingId) {
    await showMyBookings(ctx);
    return;
  }

  const invoiceUrl = await callTool('getInvoice', bookingId);
  if (!invoiceUrl) {
    await ctx.send.text('invoice_unavailable');
    return;
  }

  const booking = await callTool('getBooking', bookingId);
  await ctx.send.document(invoiceUrl, `${booking.bookingNumber}-invoice.pdf`, 'menu_invoice');
}

module.exports = { showMyBookings, handleBookingDetailsSelection, promptBookingForInvoice };
