const crypto = require('crypto');

/**
 * Deterministic idempotency key for a booking-creation attempt: same
 * session + same draft content => same key, so re-sending the last
 * WhatsApp message or double-tapping "Confirm & Pay" can never create
 * two bookings. Changing any part of the draft (date, vehicle, etc.)
 * naturally produces a new key once the customer actually changes
 * something.
 */
function bookingIdempotencyKey(sessionId, draft) {
  const payload = JSON.stringify({
    tripType: draft.tripType,
    pickup: draft.pickup,
    drop: draft.drop,
    pickupAt: draft.pickupAt,
    returnAt: draft.returnAt,
    rentalHours: draft.rentalHours,
    vehicleId: draft.vehicleId,
    fareQuoteId: draft.fareQuoteId,
  });
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
  return `book:${sessionId}:${hash}`;
}

function paymentIdempotencyKey(bookingId, attempt) {
  return `pay:${bookingId}:${attempt}`;
}

module.exports = { bookingIdempotencyKey, paymentIdempotencyKey };
