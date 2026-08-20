'use strict';

/**
 * src/models/allocation.model.js   — Day 9
 *
 * Shared selects and the hold-window rule for allocations.
 */

/** Bookings that may receive a vehicle. */
const ASSIGNABLE_BOOKING_STATUSES = ['CONFIRMED', 'ALLOCATED'];

const ALLOCATION_SELECT = {
  id: true,
  bookingId: true,
  vehicleId: true,
  driverId: true,
  status: true,
  startsAt: true,
  endsAt: true,
  assignedById: true,
  acceptedAt: true,
  declinedAt: true,
  releasedAt: true,
  createdAt: true,
  vehicle: {
    select: { id: true, registrationNumber: true, vehicleClass: true, makeModel: true, status: true },
  },
  driver: {
    select: {
      userId: true,
      isOnline: true,
      ratingAvg: true,
      user: { select: { id: true, name: true, phone: true } },
    },
  },
};

/**
 * The window a vehicle is HELD for a booking.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WINDOW IS WIDER THAN THE TRIP
 * ---------------------------------------------------------------------------
 * A hold is not just "the minutes the passenger is aboard". The vehicle must
 * reach the pickup, and after the drop it needs wrap-up before it can honestly
 * take the next job. So a one-way hold runs from pickupAt to
 * pickupAt + tripMinutes + buffer.
 *
 * For a ROUND TRIP the vehicle is committed for the whole journey — out, wait,
 * and back — so the window runs from pickupAt to returnAt (plus buffer). This
 * is precisely what stops a round-trip vehicle being offered to an overlapping
 * booking: the hold spans the entire journey, and the EXCLUDE constraint
 * rejects anything that intersects it.
 */
function computeHoldWindow(booking, { bufferMinutes = 60, defaultTripMinutes = 120 } = {}) {
  const startsAt = new Date(booking.pickupAt);
  const bufferMs = bufferMinutes * 60000;

  let endsAt;
  if (booking.tripType === 'ROUND_TRIP' && booking.returnAt) {
    endsAt = new Date(new Date(booking.returnAt).getTime() + bufferMs);
  } else {
    const tripMin = Number(booking.durationMinutes) > 0
      ? Number(booking.durationMinutes)
      : defaultTripMinutes;
    endsAt = new Date(startsAt.getTime() + tripMin * 60000 + bufferMs);
  }

  // The DB CHECK requires ends_at > starts_at; guarantee it even for odd data.
  if (endsAt <= startsAt) {
    endsAt = new Date(startsAt.getTime() + defaultTripMinutes * 60000);
  }

  return { startsAt, endsAt };
}

module.exports = {
  ASSIGNABLE_BOOKING_STATUSES,
  ALLOCATION_SELECT,
  computeHoldWindow,
};