'use strict';

/**
 * src/realtime/bridge.js   — Day 10
 *
 * The one-way bridge from the domain event bus to WebSocket rooms.
 *
 * ---------------------------------------------------------------------------
 * WHY A BRIDGE, AND WHY ONE-WAY
 * ---------------------------------------------------------------------------
 * Services already announce what happens via the in-process event bus (Day 5):
 * booking.attempted, booking.status_changed, allocation.made, and so on. They
 * do NOT know or care that WebSockets exist — and they must not, or every
 * service would depend on the transport.
 *
 * This bridge is the single place that listens to those events and turns each
 * into a room broadcast. Add real-time delivery for a new event by adding one
 * listener here; no service changes. The flow is strictly one-way:
 *
 *     service → emit(event) → bus → bridge → io.to(room).emit(...)
 *
 * Nothing here writes to the database or calls back into a service, so a slow
 * or failed socket emit can never affect the business transaction that caused
 * it. The event already committed before we were called.
 *
 * ---------------------------------------------------------------------------
 * THE DONE-LINE
 * ---------------------------------------------------------------------------
 * booking.attempted → the dispatch console room. Two browser tabs both joined
 * to `dispatch` therefore both receive it live. That is the Day 10 done-line,
 * and it falls out of the first listener below.
 */

const { bus, EVENTS } = require('../lib/events');
const rooms = require('./rooms');
const redis = require('../config/redis');

let wired = false;

/**
 * Subscribes to the event bus and starts forwarding to rooms.
 * @param {import('socket.io').Server} io
 */
function wire(io) {
  if (wired) return;
  wired = true;

  /* ---- booking.attempted → dispatch console + queued admin notification ---- */

  bus.on(EVENTS.BOOKING_ATTEMPTED, (payload) => {
    // Live feed to every dispatcher watching the console.
    io.to(rooms.DISPATCH).emit('booking:attempted', {
      attemptId: payload.attemptId,
      customerId: payload.customerId,
      outcome: payload.outcome,
      failureReason: payload.failureReason || null,
      pickupAddress: payload.pickupAddress,
      dropAddress: payload.dropAddress,
      tripType: payload.tripType,
      at: payload.at,
    });

    // A FAILED attempt is also an admin notification: something stopped a
    // customer from booking, and someone should look. The attempt lifecycle is
    // PENDING (in flight) -> COMPLETED (success) or FAILED (error); this event
    // fires at the PENDING stage, and a successful booking later settles to
    // COMPLETED — so ONLY an explicit FAILED outcome is alert-worthy. Checking
    // "not SUCCESS" would (wrongly) alert on every booking, since the outcome at
    // emit time is PENDING and the success terminal is COMPLETED, never SUCCESS.
    if (payload.outcome === 'FAILED') {
      queueAdminNotification({
        type: 'BOOKING_ATTEMPT_FAILED',
        attemptId: payload.attemptId,
        reason: payload.failureReason || 'unknown',
        at: payload.at,
      });
      io.to(rooms.ADMIN).emit('admin:alert', {
        kind: 'BOOKING_ATTEMPT_FAILED',
        attemptId: payload.attemptId,
        reason: payload.failureReason || 'unknown',
        at: payload.at,
      });
    }
  });

  /* ---- booking.created → dispatch feed ---- */

  bus.on(EVENTS.BOOKING_CREATED, (payload) => {
    io.to(rooms.DISPATCH).emit('booking:created', slimBooking(payload));
  });

  /* ---- booking.status_changed → the booking room + dispatch ---- */

  bus.on(EVENTS.BOOKING_STATUS_CHANGED, (payload) => {
    const body = {
      bookingId: payload.bookingId,
      bookingNumber: payload.bookingNumber,
      status: payload.status,
      at: payload.at,
    };
    // Anyone watching this specific booking (customer app, ops detail view).
    io.to(rooms.booking(payload.bookingId)).emit('trip:status', body);
    // And the console, so the board stays live.
    io.to(rooms.DISPATCH).emit('trip:status', body);
  });

  /* ---- booking.cancelled → booking room + dispatch ---- */

  bus.on(EVENTS.BOOKING_CANCELLED, (payload) => {
    const body = {
      bookingId: payload.bookingId,
      bookingNumber: payload.bookingNumber,
      status: 'CANCELLED',
      at: payload.at,
    };
    io.to(rooms.booking(payload.bookingId)).emit('trip:status', body);
    io.to(rooms.DISPATCH).emit('trip:status', body);
  });

  /* ---- allocation.made → the assigned driver + the booking room ---- */

  bus.on(EVENTS.ALLOCATION_MADE, (payload) => {
    // The offer goes to the specific driver's private room — only they see it.
    if (payload.driverId) {
      io.to(rooms.driver(payload.driverId)).emit('offer:new', {
        allocationId: payload.allocationId,
        bookingId: payload.bookingId,
        vehicleId: payload.vehicleId,
        at: payload.at,
      });
    }
    // The booking room learns a vehicle is assigned (customer sees "driver on
    // the way" state); the console sees the board change.
    const body = {
      bookingId: payload.bookingId,
      allocationId: payload.allocationId,
      vehicleId: payload.vehicleId,
      at: payload.at,
    };
    io.to(rooms.booking(payload.bookingId)).emit('booking:allocated', body);
    io.to(rooms.DISPATCH).emit('booking:allocated', body);
  });

  /* ---- payment.received → the booking room ---- */

  bus.on(EVENTS.PAYMENT_RECEIVED, (payload) => {
    io.to(rooms.booking(payload.bookingId)).emit('payment:received', {
      bookingId: payload.bookingId,
      paymentId: payload.paymentId,
      amount: payload.amount,
      purpose: payload.purpose,
      at: payload.at,
    });
  });

  console.log('[realtime] event bridge wired');
}

function slimBooking(p) {
  return {
    bookingId: p.bookingId,
    bookingNumber: p.bookingNumber,
    status: p.status || 'PENDING',
    vehicleClass: p.vehicleClass,
    at: p.at,
  };
}

/**
 * Appends an admin notification to a Redis list for a worker to drain later.
 * Fire-and-forget: a Redis outage must not break the live path, so failures are
 * swallowed (the live dispatch/admin socket emit already delivered the signal).
 */
function queueAdminNotification(note) {
  if (!redis.isQueueUp()) return;
  redis.queue
    .rpush('notifications:admin', JSON.stringify({ ...note, queuedAt: new Date().toISOString() }))
    .catch(() => {});
}

module.exports = { wire };