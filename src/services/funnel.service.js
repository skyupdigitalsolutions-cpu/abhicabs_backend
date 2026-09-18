'use strict';

/**
 * src/services/funnel.service.js
 *
 * Records what a signed-in rider does BEFORE a booking exists, and chases the
 * ones who stop halfway.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A NEW TABLE
 * ---------------------------------------------------------------------------
 * booking_attempts already has exactly the right shape — customerId, pickup and
 * drop addresses, tripType, an outcome that includes ABANDONED, a notifiedAt
 * column and a free-form payload. It was built for "every initiation, including
 * the ones that never became bookings"; the only thing missing was anything
 * writing to it before POST /bookings.
 *
 * Adding a second table would split one funnel across two places and force
 * every report to union them.
 *
 * ---------------------------------------------------------------------------
 * ONE OPEN ATTEMPT PER RIDER
 * ---------------------------------------------------------------------------
 * The app calls track() as the rider fills the form — pickup chosen, then drop,
 * then a vehicle class. Each call UPDATES the rider's open attempt rather than
 * inserting a new row, so a single session produces one row that fills in over
 * time, not five fragments of the same journey.
 *
 * "Open" means PENDING with no booking attached. Once a booking is created the
 * row is settled to COMPLETED by booking.service (via closeForBooking) and a
 * later session starts a fresh one.
 */

const { prisma } = require('../config/prisma');
const push = require('./push.service');
const customerService = require('./customer.service');

/**
 * How long a half-finished booking sits before it counts as abandoned.
 *
 * Thirty minutes — the standard cart-abandonment window. Long enough that a
 * rider comparing fares, taking a call, or walking to the corner is not chased
 * mid-decision; short enough that the trip is still relevant. Override with
 * FUNNEL_ABANDON_MINUTES.
 */
const ABANDON_AFTER_MINUTES = Number(process.env.FUNNEL_ABANDON_MINUTES || 30);

/**
 * How far back the sweeper looks.
 *
 * Without an upper bound, the first run after a quiet weekend would message
 * everyone who ever left a draft. A day is enough to catch a real drop-off and
 * short enough that nobody gets a notification about a trip they forgot.
 */
const ABANDON_LOOKBACK_HOURS = Number(process.env.FUNNEL_LOOKBACK_HOURS || 24);

/**
 * The stages a draft passes through, in order.
 *
 * Stored on the payload rather than as a column so the funnel can gain a step
 * without a migration — the value is read by reporting, never joined on.
 */
const STAGES = ['STARTED', 'PICKUP_SET', 'DROP_SET', 'FARES_VIEWED', 'PAYMENT_CHOSEN'];

/* ------------------------------------------------------------------ *
 * Track
 * ------------------------------------------------------------------ */

/**
 * Record progress through the booking form.
 *
 * Deliberately forgiving: every field is optional and a malformed call updates
 * what it can rather than failing. This runs on a keystroke-adjacent path, and
 * a tracking call that can break the booking form is worse than one that
 * occasionally records less than it might.
 *
 * @param {string}  customerId  the signed-in user's id
 * @param {object}  input       stage plus whatever of the trip is known so far
 * @param {object}  meta        ip / userAgent / source
 */
async function track(customerId, input = {}, meta = {}) {
  // customer_id is a FK to customers.user_id; an OTP-signup rider may have a
  // users row but no customers row yet. Create it first, exactly as
  // booking.service.create does — otherwise the insert below violates
  // booking_attempts_customer_id_fkey.
  await customerService.findOrCreate(customerId);

  const cutoff = new Date(Date.now() - ABANDON_LOOKBACK_HOURS * 3600 * 1000);

  const open = await prisma.bookingAttempt.findFirst({
    where: {
      customerId,
      outcome: 'PENDING',
      bookingId: null,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  });

  // Only overwrite what the caller actually sent. A later call that knows the
  // drop but not the pickup must not erase the pickup recorded a minute ago.
  const data = {
    ...(input.tripType !== undefined ? { tripType: input.tripType } : {}),
    ...(input.vehicleClass !== undefined ? { vehicleClass: input.vehicleClass } : {}),
    ...(input.pickupAddress !== undefined ? { pickupAddress: input.pickupAddress } : {}),
    ...(input.dropAddress !== undefined ? { dropAddress: input.dropAddress } : {}),
    ...(input.pickupAt ? { pickupAt: new Date(input.pickupAt) } : {}),
    ...(input.estimatedFare !== undefined ? { estimatedFare: input.estimatedFare } : {}),
  };

  const payload = {
    ...(open?.payload && typeof open.payload === 'object' ? open.payload : {}),
    stage: STAGES.includes(input.stage) ? input.stage : open?.payload?.stage || 'STARTED',
    lastSeenAt: new Date().toISOString(),
    ...(input.pickup ? { pickup: input.pickup } : {}),
    ...(input.drop ? { drop: input.drop } : {}),
    ...(input.stops ? { stops: input.stops } : {}),
  };

  if (open) {
    return prisma.bookingAttempt.update({
      where: { id: open.id },
      data: { ...data, payload },
      select: { id: true },
    });
  }

  return prisma.bookingAttempt.create({
    data: {
      customerId,
      outcome: 'PENDING',
      source: meta.source || 'api',
      ip: meta.ip || null,
      userAgent: meta.userAgent || null,
      ...data,
      payload,
    },
    select: { id: true },
  });
}

/* ------------------------------------------------------------------ *
 * Close on booking
 * ------------------------------------------------------------------ */

/**
 * Close the rider's open draft(s) the moment they actually book, so a completed
 * booking is never chased by the sweeper.
 *
 * Called by booking.service after a successful create. Scoped to still-open rows
 * (PENDING, no bookingId), so it only ever touches the funnel draft — the
 * per-submit attempt row is already COMPLETED (it has a bookingId) by the time
 * this runs. Best-effort: a failure here must not fail the booking.
 */
async function closeForBooking(customerId, bookingId) {
  if (!customerId) return;
  try {
    await prisma.bookingAttempt.updateMany({
      where: { customerId, outcome: 'PENDING', bookingId: null },
      data: { outcome: 'COMPLETED', bookingId },
    });
  } catch (err) {
    console.error('[funnel] closeForBooking failed:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Sweep
 * ------------------------------------------------------------------ */

/**
 * Human-readable reason for the nudge, built from how far the rider got.
 *
 * A message that names the actual destination converts far better than "you
 * left something behind", and it also proves to the rider that this is their
 * draft and not a broadcast.
 */
function nudgeFor(attempt) {
  const drop = attempt.dropAddress;
  const pickup = attempt.pickupAddress;

  if (drop) {
    // Addresses are long; the first comma-separated part is the recognisable bit.
    const place = String(drop).split(',')[0].trim();
    return {
      title: 'Still heading out?',
      body: `Your trip to ${place} is ready to book — tap to see fares.`,
    };
  }
  if (pickup) {
    const place = String(pickup).split(',')[0].trim();
    return {
      title: 'Finish your booking',
      body: `We saved your pickup at ${place}. Add a destination to see fares.`,
    };
  }
  return {
    title: 'Finish your booking',
    body: 'You started a trip but did not finish. Tap to pick up where you left off.',
  };
}

/**
 * Mark stale drafts ABANDONED and notify the rider once.
 *
 * `notifiedAt` is what makes "once" true: the sweeper runs every few minutes,
 * and without it the same rider would be messaged on every pass. It is set in
 * the same update that changes the outcome, BEFORE the push is attempted — a
 * notification that fails to send is a missed nudge, while one that sends twice
 * is a reason to uninstall.
 *
 * Only drafts that reached PICKUP_SET are chased. Someone who opened the app
 * and did nothing has not abandoned a booking; they have used the app.
 */
async function sweepAbandoned() {
  const staleBefore = new Date(Date.now() - ABANDON_AFTER_MINUTES * 60 * 1000);
  const lookbackAfter = new Date(Date.now() - ABANDON_LOOKBACK_HOURS * 3600 * 1000);

  const stale = await prisma.bookingAttempt.findMany({
    where: {
      outcome: 'PENDING',
      bookingId: null,
      notifiedAt: null,
      customerId: { not: null },
      createdAt: { lt: staleBefore, gte: lookbackAfter },
      // Something was actually chosen. A bare "opened the app" row is noise.
      pickupAddress: { not: null },
    },
    select: {
      id: true, customerId: true,
      pickupAddress: true, dropAddress: true, payload: true,
    },
    take: 200,
  });

  let notified = 0;

  for (const attempt of stale) {
    // Claim it first. If two workers run the sweeper at once, only the one whose
    // update matches a still-unnotified row proceeds.
    const claimed = await prisma.bookingAttempt.updateMany({
      where: { id: attempt.id, notifiedAt: null },
      data: { outcome: 'ABANDONED', notifiedAt: new Date() },
    });
    if (claimed.count === 0) continue;

    const { title, body } = nudgeFor(attempt);

    // Never throw out of the loop: one rider with a dead device token must not
    // stop the other 199 from being swept.
    try {
      await push.pushToUser(attempt.customerId, {
        title,
        body,
        data: {
          type: 'BOOKING_ABANDONED',
          attemptId: attempt.id,
          // Lets the app reopen the draft rather than dumping the rider on Home.
          pickup: attempt.pickupAddress || '',
          drop: attempt.dropAddress || '',
        },
      });
      notified += 1;
    } catch (err) {
      console.error(`[funnel] push failed for attempt ${attempt.id}: ${err.message}`);
    }
  }

  return { scanned: stale.length, notified };
}

module.exports = {
  track,
  sweepAbandoned,
  closeForBooking,
  STAGES,
  ABANDON_AFTER_MINUTES,
};