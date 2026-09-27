'use strict';

/**
 * src/queues/producers.js   — Day 12
 *
 * Bridges the in-process event bus to durable queue jobs. Same shape as the
 * Day 10 realtime bridge, but where that fans events out to WebSocket rooms
 * (ephemeral), this enqueues DURABLE background work.
 *
 *   booking.confirmed  -> notifications: booking confirmed to the customer
 *   allocation.made    -> notifications: driver assigned
 *   booking.cancelled  -> notifications: cancellation (+ refund line)
 *   payment.received   -> payments: post-capture side-effects
 *
 * One-way and fire-and-forget: an enqueue failure is logged, never thrown, so a
 * background-work hiccup cannot break the booking/payment path that emitted the
 * event. Wired once, from the API process, at boot.
 */

const { bus, EVENTS } = require('../lib/events');
const { QUEUE, enqueue } = require('./index');

let wired = false;

function wire() {
  if (wired) return;
  wired = true;

  /*
   * "We've received your booking" — sent the moment a booking is created.
   *
   * Bookings used to confirm themselves at creation, so the BOOKING_CONFIRMED
   * push below fired on every booking and the rider always heard something.
   * Now every booking waits for an admin to confirm it, BOOKING_CONFIRMED only
   * fires then, and a rider who had just booked heard NOTHING — which read as
   * "notifications are broken". This fills that gap with honest wording: the
   * booking is received, not yet confirmed.
   */
  bus.on(EVENTS.BOOKING_CREATED, (p) => {
    add(QUEUE.NOTIFICATIONS, 'booking-received', {
      type: 'BOOKING_RECEIVED',
      bookingId: p.bookingId,
      to: null,
    });
  });

  bus.on(EVENTS.BOOKING_CONFIRMED, (p) => {
    add(QUEUE.NOTIFICATIONS, 'booking-confirmed', {
      type: 'BOOKING_CONFIRMED',
      bookingId: p.bookingId,
      to: p.customerPhone || null,
    });
  });

  bus.on(EVENTS.ALLOCATION_MADE, (p) => {
    add(QUEUE.NOTIFICATIONS, 'driver-assigned', {
      type: 'DRIVER_ASSIGNED',
      bookingId: p.bookingId,
      to: p.customerPhone || null,
      extra: { vehicle: p.vehicleId || '' },
    });
  });

  bus.on(EVENTS.BOOKING_CANCELLED, (p) => {
    add(QUEUE.NOTIFICATIONS, 'booking-cancelled', {
      type: 'BOOKING_CANCELLED',
      bookingId: p.bookingId,
      to: p.customerPhone || null,
      extra: { refund: p.refundAmount || '0.00' },
    });
  });

  bus.on(EVENTS.PAYMENT_RECEIVED, (p) => {
    add(QUEUE.PAYMENTS, 'post-capture', {
      paymentId: p.paymentId,
      bookingId: p.bookingId,
      purpose: p.purpose,
      amount: p.amount,
    });
  });

  console.log('[queues] producers wired to event bus');
}

function add(queueName, jobName, data) {
  // Fire-and-forget. A failed enqueue must not break the emitting request.
  enqueue(queueName, jobName, data).catch((err) => {
    console.error(`[queues] enqueue ${queueName}:${jobName} failed: ${err.message}`);
  });
}

module.exports = { wire };