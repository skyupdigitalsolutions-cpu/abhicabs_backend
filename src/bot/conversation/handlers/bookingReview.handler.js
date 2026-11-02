const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { bookingIdempotencyKey } = require('../../utils/idempotency');
const { logger } = require('../../config/logger');
const env = require('../../config/env');
const { fmtDate, fmtTime, fmtDateTime, inr } = require('../../utils/format');
const { toNumbered, rememberOptions } = require('../numberedMenu');

// ── Passenger details: name, then number of passengers (asked in booking.handler.js) ──

async function handleBookingCustomerName(ctx) {
  const { message, session, customer } = ctx;
  const name = (message.text || '').trim();

  if (!name || name.length < 2 || name.length > 60) {
    await ctx.send.text('ask_name');
    return;
  }

  session.draft.passengerName = name;
  customer.name = name;
  await customer.save();
  await session.save();

  await transition(session, STATES.BOOKING_PASSENGERS);
  await ctx.send.text('ask_passenger_count');
}

// ── Booking summary ─────────────────────────────────────────────────

/** A Google Maps link that shows the whole route (pickup, stops, drop), or '' when a place has no map position. */
function googleRouteLink(d) {
  const pt = (p) => (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? `${p.latitude},${p.longitude}` : null);
  const from = pt(d.pickup);
  const to = pt(d.drop);
  if (!from || !to) return '';
  const stops = (d.drop?.stops || []).map(pt);
  if (stops.some((x) => !x)) return '';
  return `https://www.google.com/maps/dir/?api=1&origin=${from}&destination=${to}${stops.length ? `&waypoints=${stops.join('%7C')}` : ''}&travelmode=driving`;
}

async function showBookingReview(ctx) {
  const { session } = ctx;
  const d = session.draft;

  await transition(session, STATES.BOOKING_REVIEW);

  const body =
    `${t(ctx.language, 'booking_summary_title')}\n\n` +
    `👤 ${d.passengerName}\n` +
    `📱 ${session.whatsappNumber}\n` +
    `👥 ${d.passengerCount} passenger${d.passengerCount > 1 ? 's' : ''}\n\n` +
    `📍 Pickup: ${d.pickup.address}\n` +
    (d.drop?.stops || []).map((st, i) => `➕ Stop ${i + 1}: ${st.address}\n`).join('') +
    (d.drop?.address ? `🏁 Drop: ${d.drop.address}\n` : '') +
    (d.distanceKm ? `📏 Distance: ${d.distanceKm} km${d.tripType === 'ROUND_TRIP' ? ' one way' : ''}\n` : '') +
    // The rate per km, so the customer sees how the fare is made up (not for Local trips, which are priced by package).
    (d.ratePerKm && d.tripType !== 'HOURLY' ? `💵 Rate: ${inr(d.ratePerKm)}/km\n` : '') +
    (env.SUMMARY_MAP_LINK && googleRouteLink(d) ? `🗺️ Route: ${googleRouteLink(d)}\n` : '') +
    `📅 ${fmtDate(d.pickupAt)}\n` +
    `⏰ ${fmtTime(d.pickupAt)}\n` +
    (d.returnAt ? `↩️ Return: ${fmtDateTime(d.returnAt)}\n` : '') +
    (d.rentalHours ? `🕒 ${d.rentalHours} hours\n` : '') +
    `🚗 ${d.vehicleName || d.vehicleClass}\n\n` +
    // A breakdown only when there is something besides the distance charge to explain.
    (d.fare.driverAllowance > 0 || d.fare.tax > 0
      ? `🧾 Fare: ${inr(d.fare.baseFare)}\n` +
        (d.fare.driverAllowance > 0 ? `🧑‍✈️ Driver allowance: ${inr(d.fare.driverAllowance)}\n` : '') +
        (d.fare.tax > 0 ? `📑 Tax: ${inr(d.fare.tax)}\n` : '')
      : '') +
    `💰 Total fare: ${inr(d.fare.total)}`;

  const buttons = [
    { id: 'REVIEW_CONFIRM', number: 1, label: t(ctx.language, 'confirm_booking'), maxTitleLength: 20 },
    { id: 'REVIEW_MODIFY', number: 2, label: t(ctx.language, 'modify'), maxTitleLength: 20 },
    { id: 'REVIEW_CANCEL', number: 3, label: t(ctx.language, 'cancel'), maxTitleLength: 20 },
  ];
  const { rows, map } = toNumbered(buttons);

  await ctx.send.buttonsRaw(body, rows.map((r) => ({ id: r.id, title: r.title })));
  await rememberOptions(session, map);
}

async function handleBookingReview(ctx) {
  const { message, session } = ctx;
  const typed = (message.text || '').trim();

  if (message.interactiveId === 'REVIEW_MODIFY' || /^(modify|change|edit)$/i.test(typed)) {
    const { startBooking } = require('./booking.handler');
    await startBooking(ctx);
    return;
  }

  if (message.interactiveId === 'REVIEW_CANCEL') {
    session.resetDraft();
    await ctx.send.text('booking_cancelled');
    const { renderMainMenu } = require('./mainMenu.handler');
    await transition(session, STATES.MAIN_MENU);
    await renderMainMenu(ctx);
    return;
  }

  // Only an explicit Confirm creates a booking — stray text never does.
  if (message.interactiveId === 'REVIEW_CONFIRM' || /^(confirm|yes|ok|y)$/i.test(typed)) {
    await createBookingAndShowPaymentOptions(ctx);
    return;
  }

  await showBookingReview(ctx);
}

// ── Confirm Booking → save it → Select Payment Option ───────────────

async function createBookingAndShowPaymentOptions(ctx) {
  // The website backend needs the payment mode when a booking is created, so the booking is created in
  // payment.handler right after the customer picks Pay Later / Partial / Full. Until then the review is a draft.
  const { session } = ctx;
  const d = session.draft;
  session.activeBookingId = null;
  session.pendingIdempotencyKey = bookingIdempotencyKey(String(session._id), d);
  await session.save();

  const { showPaymentOptions, draftAsBooking } = require('./payment.handler');
  await showPaymentOptions(ctx, draftAsBooking(session));
}

module.exports = {
  handleBookingCustomerName,
  showBookingReview,
  handleBookingReview,
  createBookingAndShowPaymentOptions,
  createBookingAndStartPayment: createBookingAndShowPaymentOptions, // old name, kept for compatibility
};
