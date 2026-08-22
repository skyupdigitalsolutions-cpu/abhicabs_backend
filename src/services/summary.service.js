'use strict';

/**
 * src/services/summary.service.js   — Day 14
 *
 * Per-screen aggregate reads. A mobile "trip detail" screen needs the booking,
 * its payments, the assigned vehicle/driver, the invoice, and — if the trip is
 * live — the driver's current position. Naively that is five sequential API
 * calls from the client, each a round-trip over mobile network latency.
 *
 * ---------------------------------------------------------------------------
 * WHY AGGREGATE ON THE SERVER
 * ---------------------------------------------------------------------------
 * Round-trips, not bytes, dominate perceived latency on mobile: five sequential
 * 150ms calls is 750ms of staring at spinners even if each payload is tiny.
 * Composing them into ONE endpoint collapses that to a single round-trip, and
 * lets the server run the independent reads in PARALLEL. Ownership is enforced
 * once (via booking.findById), so the aggregate is exactly as safe as its parts.
 */

const booking = require('./booking.service');
const payment = require('./payment.service');
const allocation = require('./allocation.service');
const billing = require('./billing.service');
const location = require('./location.service');

/**
 * Everything the trip-detail screen needs, in one owner-scoped call.
 *
 * @param {string} bookingId
 * @param {object} actor  req.user — enforces ownership through booking.findById
 */
async function bookingSummary(bookingId, actor) {
  // Ownership gate first. findById returns 404 for a booking the caller does not
  // own, so nothing below can leak another customer's data. Fetched alone so a
  // forbidden id fails fast without firing the other four queries.
  const bk = await booking.findById(bookingId, actor);

  // The rest are independent — run them together. Each is tolerant of "nothing
  // yet" (no payments, not allocated, no invoice, not live), so a partial trip
  // returns a partial-but-valid summary rather than erroring.
  const [payments, activeAllocation, invoice] = await Promise.all([
    payment.listForBooking(bookingId).catch(() => []),
    allocation.getForBooking(bookingId).catch(() => null),
    billing.getInvoiceForBooking(bookingId).catch(() => null),
  ]);

  // Live driver position only makes sense while the trip is in motion and a
  // driver is assigned. Skipped otherwise to avoid a pointless Redis call.
  let liveLocation = null;
  const driverId = activeAllocation?.driverId || null;
  const inMotion = ['ALLOCATED', 'EN_ROUTE', 'ONGOING'].includes(bk.status);
  if (driverId && inMotion) {
    liveLocation = await location.driverLocation(driverId).catch(() => null);
  }

  return {
    booking: bk,
    payments,
    allocation: activeAllocation,
    invoice,
    liveLocation,
  };
}

module.exports = { bookingSummary };