const { callTool } = require('../../integrations/ai/tools');
const { t } = require('../../utils/i18n');
const { logger } = require('../../config/logger');

/**
 * "Track My Cab" — only ever shows liveLocation if the backend actually
 * has one recorded. Never interpolates or guesses a position (spec
 * section 26).
 */
async function promptBookingForTracking(ctx) {
  const { session } = ctx;
  const bookingId = session.activeBookingId;

  if (!bookingId) {
    const { showMyBookings } = require('./myBookings.handler');
    await showMyBookings(ctx);
    return;
  }

  let summary;
  try {
    summary = await callTool('getBookingSummary', bookingId);
  } catch (err) {
    logger.error({ err: err.message }, '[tracking] summary lookup failed');
    await ctx.send.text('generic_error');
    return;
  }

  if (!summary) {
    await ctx.send.text('generic_error');
    return;
  }

  const { booking, liveLocation } = summary;

  if (!liveLocation) {
    await ctx.send.text('tracking_unavailable');
    return;
  }

  await ctx.send.raw(
    `🚕 ${booking.bookingNumber}\n` +
      `Driver: ${booking.driver?.name || 'Assigned'}\n` +
      `Last updated: ${new Date(liveLocation.updatedAt).toLocaleTimeString('en-IN')}\n\n` +
      `📍 https://www.google.com/maps?q=${liveLocation.latitude},${liveLocation.longitude}`
  );
}

module.exports = { promptBookingForTracking };
