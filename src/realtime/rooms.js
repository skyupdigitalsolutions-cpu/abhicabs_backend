'use strict';

/**
 * src/realtime/rooms.js   — Day 10
 *
 * Room names in ONE place. A room is just a string, but if those strings are
 * built ad-hoc at call sites they drift ("driver:123" vs "drivers/123") and a
 * broadcast silently reaches nobody. Every join and every emit goes through
 * these helpers so the two sides can never disagree.
 *
 * ---------------------------------------------------------------------------
 * THE ROOM TOPOLOGY
 * ---------------------------------------------------------------------------
 *   booking:<id>     everyone watching one booking (the customer, and any ops
 *                    user who opened it). Trip status broadcasts go here.
 *   driver:<userId>  a single driver's private channel. Assignment offers are
 *                    sent here — only that driver sees the offer.
 *   dispatch         the ops console. Every dispatcher joins it and sees the
 *                    live feed: booking attempts, new bookings, allocations.
 *   admin            higher-level alerts (queued notifications, failures).
 *
 * A socket joins rooms based on WHO it is, decided in the auth handshake — a
 * customer never joins `dispatch`, a driver only joins their own `driver:<id>`.
 */

const booking = (bookingId) => `booking:${bookingId}`;
const driver = (userId) => `driver:${userId}`;

const DISPATCH = 'dispatch';
const ADMIN = 'admin';

/**
 * Which rooms a freshly-connected socket should auto-join, by role. Booking
 * rooms are joined on demand (the client asks to watch a specific booking),
 * not here — those are unbounded and per-resource.
 */
function defaultRoomsFor(user) {
  const rooms = [];
  switch (user.role) {
    case 'ADMIN':
      rooms.push(DISPATCH, ADMIN);
      break;
    case 'OPS':
      rooms.push(DISPATCH);
      break;
    case 'DRIVER':
      rooms.push(driver(user.id));
      break;
    // Regular customers auto-join nothing; they subscribe to their own
    // booking rooms explicitly after connect.
    default:
      break;
  }
  return rooms;
}

module.exports = {
  booking,
  driver,
  DISPATCH,
  ADMIN,
  defaultRoomsFor,
};