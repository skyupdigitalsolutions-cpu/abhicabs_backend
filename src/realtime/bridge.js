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
const { prisma } = require('../config/prisma');

let wired = false;

/**
 * Persist a notification for every staff user with a given role (or all staff).
 * Fire-and-forget: failures are logged but never break the live path.
 *
 * @param {{ title: string, body?: string, type?: string, linkTo?: string, roles?: string[] }} opts
 */
async function persistNotification({ title, body, type = 'INFO', linkTo, roles }) {
  try {
    const where = { isActive: true };
    if (roles && roles.length) {
      where.role = { in: roles };
    } else {
      // All staff roles (not customers)
      where.role = { in: ['ADMIN', 'OPS', 'FINANCE', 'FLEET', 'SUPPORT'] };
    }
    const staffUsers = await prisma.user.findMany({ where, select: { id: true } });
    if (!staffUsers.length) return;

    await prisma.notification.createMany({
      data: staffUsers.map((u) => ({
        userId: u.id,
        title,
        body: body || null,
        type,
        linkTo: linkTo || null,
      })),
    });
  } catch (err) {
    console.error('[bridge] persistNotification failed:', err.message);
  }
}

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

      persistNotification({
        title: 'Booking attempt failed',
        body: `Reason: ${payload.failureReason || 'unknown'}`,
        type: 'ALERT',
        linkTo: '/admin/bookings',
        roles: ['ADMIN', 'OPS'],
      });
    }
  });

  /* ---- booking.created → dispatch feed + persist notification ---- */

  bus.on(EVENTS.BOOKING_CREATED, (payload) => {
    io.to(rooms.DISPATCH).emit('booking:created', slimBooking(payload));

    persistNotification({
      title: `New booking ${payload.bookingNumber || ''}`.trim(),
      body: `${payload.vehicleClass || 'Vehicle'} booking needs confirmation`,
      type: 'BOOKING',
      linkTo: payload.bookingId ? `/admin/bookings/${payload.bookingId}` : '/admin/bookings',
      roles: ['ADMIN', 'OPS'],
    });
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

  /* ---- booking.vehicle_changed → the booking room + dispatch ---- */

  bus.on(EVENTS.BOOKING_VEHICLE_CHANGED, (payload) => {
    /*
     * The rider's room gets the MONEY, not just the class. A screen that
     * learns the car changed but not the fare shows a stale total next to a
     * new vehicle name, which reads as a bug at the worst possible moment —
     * the rider is looking at what they owe.
     */
    const body = {
      bookingId: payload.bookingId,
      bookingNumber: payload.bookingNumber,
      vehicleClass: payload.to,
      previousVehicleClass: payload.from,
      total: payload.total,
      previousTotal: payload.previousTotal,
      balanceDue: payload.balanceDue,
      refundDue: payload.refundDue,
      at: payload.at,
    };
    io.to(rooms.booking(payload.bookingId)).emit('trip:vehicle_changed', body);

    // The console also needs to know a car was let go, or the board keeps
    // showing a vehicle that is now free.
    io.to(rooms.DISPATCH).emit('trip:vehicle_changed', {
      ...body,
      allocationReleased: !!payload.allocationReleased,
    });
  });

  /* ---- odometer.start_recorded → the booking room only ---- */

  bus.on(EVENTS.ODOMETER_START_RECORDED, (payload) => {
    /*
     * The rider's room only, not dispatch. Ops already see the reading on the
     * trip record; this exists so the customer app can put the number and the
     * photo in front of the rider while the car is still beside them.
     */
    io.to(rooms.booking(payload.bookingId)).emit('odometer:start', {
      bookingId: payload.bookingId,
      bookingNumber: payload.bookingNumber,
      odometerKm: payload.odometerKm,
      photoUrl: payload.photoUrl,
      at: payload.at,
    });
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

    persistNotification({
      title: `Booking ${payload.bookingNumber || ''} cancelled`.trim(),
      type: 'BOOKING',
      linkTo: payload.bookingId ? `/admin/bookings/${payload.bookingId}` : '/admin/bookings',
      roles: ['ADMIN', 'OPS'],
    });
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
    /*
     * A standalone collection (a link or QR raised without a booking) has no
     * booking room to broadcast into. Without this guard the emit goes to a
     * room literally named "booking:null" — harmless today, and exactly the
     * kind of thing that becomes a cross-customer leak the day someone makes
     * room names less specific.
     */
    if (!payload.bookingId) return;

    // Persist payment notification for finance staff
    persistNotification({
      title: `Payment ₹${payload.amount} received`,
      body: payload.purpose ? `Purpose: ${payload.purpose}` : null,
      type: 'PAYMENT',
      linkTo: `/admin/payments`,
      roles: ['ADMIN', 'FINANCE'],
    });

    io.to(rooms.booking(payload.bookingId)).emit('payment:received', {
      bookingId: payload.bookingId,
      paymentId: payload.paymentId,
      amount: payload.amount,
      purpose: payload.purpose,
      /*
       * What is STILL owed after this payment.
       *
       * The event used to say only how much arrived, which is the one thing
       * the rider already knows — they just paid it. Without the remaining
       * balance every listener had to go and refetch to answer the actual
       * question, and a payment link or QR paid outside the app made that
       * worse: the rider returns to a screen whose only honest move is a
       * spinner.
       */
      balanceDue: payload.balanceDue,
      at: payload.at,
    });
  });

  /* ---- booking_request.created → admin notification ---- */

  bus.on(EVENTS.BOOKING_REQUEST_CREATED, (payload) => {
    // The frontend currently polls for new requests because this event was
    // never forwarded to sockets. Now we do both: emit to dispatch so the
    // poll can stop, AND persist a notification so it's not lost on refresh.
    io.to(rooms.DISPATCH).emit('booking_request:created', {
      requestId: payload.requestId || payload.id,
      customerName: payload.customerName,
      pickup: payload.pickup,
      drop: payload.drop,
      at: payload.at,
    });

    persistNotification({
      title: 'New booking request',
      body: payload.customerName
        ? `${payload.customerName} requested a ride outside service area`
        : 'Out-of-area ride request received',
      type: 'BOOKING',
      linkTo: '/admin/booking-requests',
      roles: ['ADMIN', 'OPS'],
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