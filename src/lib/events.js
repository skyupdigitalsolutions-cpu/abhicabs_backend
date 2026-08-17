'use strict';

/**
 * src/lib/events.js
 *
 * A process-local event bus. Day 10 subscribes the WebSocket gateway and the
 * notification queue to these events.
 *
 * ---------------------------------------------------------------------------
 * WHY AN EVENT BUS RATHER THAN DIRECT CALLS
 * ---------------------------------------------------------------------------
 * The booking service should not know that a WebSocket exists, or that admins
 * get a WhatsApp message. Its job is to create bookings correctly. Emitting
 * "this happened" and letting other code decide what to do about it keeps the
 * transactional core free of delivery concerns — and means Day 10 can add
 * real-time alerts without touching booking logic at all.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT LIMITATION — READ BEFORE RELYING ON THIS
 * ---------------------------------------------------------------------------
 * This bus is IN-PROCESS and NOT durable. If the process dies between emitting
 * and handling, the event is gone. That is acceptable for notifications, where
 * a missed admin alert is an annoyance.
 *
 * It is NOT acceptable for anything financial. Settlement, payouts and refunds
 * must go through the BullMQ queue on Day 12, which persists jobs and retries
 * them. The rule: if losing the event would lose money, it does not belong here.
 *
 * Listeners also run SYNCHRONOUSLY in the emitting request's turn, so a slow
 * handler slows the booking response. Handlers must do nothing but enqueue.
 */

const { EventEmitter } = require('events');

class AppEvents extends EventEmitter {}

const bus = new AppEvents();

// Default is 10; several subsystems will subscribe, and the warning would be
// noise rather than a real leak signal.
bus.setMaxListeners(50);

/** Canonical event names. Strings scattered through the codebase drift. */
const EVENTS = Object.freeze({
  BOOKING_ATTEMPTED: 'booking.attempted',
  BOOKING_CREATED: 'booking.created',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_STATUS_CHANGED: 'booking.status_changed',
  PAYMENT_RECEIVED: 'payment.received',
  ALLOCATION_MADE: 'allocation.made',
});

/**
 * Emits without ever letting a listener break the caller.
 *
 * A thrown error inside a synchronous listener would propagate into the booking
 * transaction and could roll back a perfectly good booking because a
 * notification handler had a bug. Isolating them is the whole point.
 */
function emit(event, payload = {}) {
  try {
    bus.emit(event, { event, at: new Date().toISOString(), ...payload });
  } catch (err) {
    console.error(`[events] listener threw on ${event}:`, err.message);
  }
}

/** Development visibility until Day 10 attaches real handlers. */
if (process.env.NODE_ENV !== 'production' && process.env.LOG_EVENTS !== 'false') {
  Object.values(EVENTS).forEach((name) => {
    bus.on(name, (payload) => {
      const id = payload.bookingNumber || payload.bookingId || payload.attemptId || '';
      console.log(`[event] ${name} ${id}`);
    });
  });
}

module.exports = { bus, EVENTS, emit };