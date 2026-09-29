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
const bookingStop = require('./bookingStop.service');

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
  const [payments, activeAllocation, invoice, stops] = await Promise.all([
    payment.listForBooking(bookingId).catch(() => []),
    allocation.getForBooking(bookingId).catch(() => null),
    billing.getInvoiceForBooking(bookingId).catch(() => null),
    /*
     * The rider's own view of stop progress.
     *
     * Added to the summary rather than as a separate customer endpoint: the
     * trip screen already fetches this on a poll, so the progress arrives with
     * the driver's position and the status, and cannot disagree with them
     * across two requests landing out of order.
     *
     * Same shape the driver sees, minus nothing — where the car has been is
     * the rider's own trip, not privileged information. arrivedLat/Lng are not
     * included by listForBooking, so the driver's exact position is not leaked
     * either way.
     *
     * Caught to [] like its neighbours: a booking made before stop tracking
     * existed, or a read that fails, must still return a usable summary rather
     * than breaking the whole trip screen.
     */
    bookingStop.listForBooking(bookingId).catch(() => []),
  ]);

  // Live driver position only makes sense while the trip is in motion and a
  // driver is assigned. Skipped otherwise to avoid a pointless Redis call.
  // ARRIVED is included: the driver is at the destination but the trip is not
  // finalised, so their position is still relevant.
  let liveLocation = null;
  const driverId = activeAllocation?.driverId || null;
  const inMotion = ['ALLOCATED', 'EN_ROUTE', 'ONGOING', 'ARRIVED'].includes(bk.status);
  if (driverId && inMotion) {
    liveLocation = await location.driverLocation(driverId).catch(() => null);
  }

  // Flatten the allocation into the shape the client expects. getForBooking
  // returns nested driver.user / vehicle objects; the app reads driverName,
  // driverPhone and vehicleNumber directly, so map them here rather than
  // leaking the ORM shape to the client (and breaking the driver card).
  const allocationView = activeAllocation
    ? {
        id: activeAllocation.id,
        bookingId: activeAllocation.bookingId,
        driverId: activeAllocation.driverId,
        vehicleId: activeAllocation.vehicleId,
        status: activeAllocation.status,
        driverName: activeAllocation.driver?.user?.name ?? null,
        driverPhone: activeAllocation.driver?.user?.phone ?? null,
        vehicleNumber: activeAllocation.vehicle?.registrationNumber ?? null,
        vehicleModel: activeAllocation.vehicle?.makeModel ?? null,
      }
    : null;

  return {
    booking: bk,
    payments,
    allocation: allocationView,
    invoice,
    liveLocation,
    /**
     * Intermediate stops with progress. Empty for a trip with no stops, and
     * also for one booked before stop tracking — those are told apart by the
     * `tracked` flag on each entry rather than by the array being empty.
     */
    stops,
  };
}

module.exports = { bookingSummary };