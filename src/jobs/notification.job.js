'use strict';

/**
 * src/jobs/notification.job.js   — Day 12
 *
 * Handles the notifications queue: WhatsApp/SMS for booking confirmed, driver
 * assigned, and cancellation, the FCM push, and — for BOOKING_CONFIRMED — the
 * confirmation email carrying the fare.
 *
 * Idempotent via runOnce: the DURABLE record ("this notification was issued")
 * is written exactly once, keyed by (type, bookingId). The actual send is fired
 * after that record commits — at-least-once, which for an SMS is the right
 * trade (a rare duplicate text beats a silently dropped confirmation). Killing
 * the worker mid-job and letting BullMQ redeliver therefore produces exactly
 * one notification record, not two.
 */

const { prisma } = require('../config/prisma');
const { runOnce } = require('./runOnce');
const notifyProvider = require('../services/providers/notify.provider');
const pushService = require('../services/push.service');
const emailService = require('../services/email.service');

/** Message templates by notification type. Params fill the template. */
/* ---------------- formatting for reminder copy ---------------- */

/** "5:04 pm" in India time. The worker runs in UTC on Railway. */
function istTime(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** "SKYUP Digital Solutions LLP, Dasarahalli Main Road, ..." -> "SKYUP Digital Solutions LLP" */
function placeName(address) {
  if (!address) return null;
  const head = String(address).split(',')[0].trim();
  return head.length > 1 ? head : String(address);
}

const TEMPLATES = {
  // Sent ~1 hour before pickup by the trip-reminder sweeper (jobs/scheduled).
  // Push-only today — the sweeper sends no phone number.
  TRIP_REMINDER: {
    channel: 'whatsapp',
    template: 'trip_reminder',
    render: (b) => ({
      bookingNumber: b.bookingNumber,
      time: istTime(b.pickupAt),
      pickup: placeName(b.pickupAddress),
      // A local rental has no destination — its "drop" is the pickup again.
      drop: b.tripType === 'HOURLY' ? null : placeName(b.dropAddress),
    }),
  },

  // Push-only today: the producer sends no phone number, so the WhatsApp/SMS
  // leg is skipped. The template name is here for when that channel goes live.
  BOOKING_RECEIVED: {
    channel: 'whatsapp',
    template: 'booking_received',
    render: (b) => ({ bookingNumber: b.bookingNumber, pickup: b.pickupAddress }),
  },
  BOOKING_CONFIRMED: {
    channel: 'whatsapp',
    template: 'booking_confirmed',
    // `amount` is pre-formatted here rather than in the push/WhatsApp copy so
    // the two channels can never quote the rider different numbers.
    render: (b) => ({
      bookingNumber: b.bookingNumber,
      pickup: b.pickupAddress,
      amount: emailService.formatAmount(b.finalFare ?? b.estimatedFare),
    }),
  },
  DRIVER_ASSIGNED: {
    channel: 'whatsapp',
    template: 'driver_assigned',
    render: (b) => ({ bookingNumber: b.bookingNumber, vehicle: b.vehicle || '' }),
  },
  BOOKING_CANCELLED: {
    channel: 'sms',
    template: 'booking_cancelled',
    render: (b) => ({ bookingNumber: b.bookingNumber, refund: b.refund || '0.00' }),
  },
};

/** Push (FCM) copy by notification type — title/body shown in the tray. */
const PUSH = {
  // "In an hour you have a trip from here to here."
  TRIP_REMINDER: (b) => {
    const p = b.params || {};
    const route = p.drop ? `from ${p.pickup} to ${p.drop}` : `from ${p.pickup}`;
    return {
      title: 'Your trip is in an hour',
      body: p.time
        ? `Pickup at ${p.time} ${route}. Please be ready at the pickup point.`
        : `Your trip ${route} starts in about an hour.`,
    };
  },
  // Honest about where the booking stands: received, awaiting the admin's
  // confirmation — which arrives as its own "Booking confirmed" push.
  BOOKING_RECEIVED: (b) => ({
    title: 'Booking received',
    body: `We've received your booking ${b.bookingNumber}. We'll notify you as soon as it's confirmed.`,
  }),
  BOOKING_CONFIRMED: (b) => {
    const amount = b.params?.amount || null;
    return {
      title: 'Booking confirmed',
      // The fare in the tray, so the rider sees the number without opening
      // anything. A booking with no readable fare still gets the old copy
      // rather than a push that trails off.
      body: amount
        ? `Your booking ${b.bookingNumber} is confirmed. Estimated fare ${amount}. Details sent to your email.`
        : `Your booking ${b.bookingNumber} is confirmed.`,
    };
  },
  DRIVER_ASSIGNED: (b) => ({
    title: 'Driver assigned',
    body: `A driver has been assigned to booking ${b.bookingNumber}.`,
  }),
  BOOKING_CANCELLED: (b) => ({
    title: 'Booking cancelled',
    body: `Booking ${b.bookingNumber} was cancelled.`,
  }),
};

/** Types that also get an email. Keyed so adding one is a line, not a branch. */
const EMAIL_TYPES = new Set(['BOOKING_CONFIRMED']);

/**
 * The confirmation email.
 *
 * A SECOND QUERY, DELIBERATELY. The runOnce transaction selects only what the
 * SMS/push templates need, and widening it would make every notification type
 * pay for columns one of them uses. This runs outside the transaction — a mail
 * round trip must not hold a database lock, exactly as the invoice email at
 * COMPLETED does not.
 *
 * Never throws: sendBookingConfirmedEmail swallows provider errors, and the
 * catch here covers the query. A failed email must not fail the job, because a
 * BullMQ retry would find the runOnce record already written, skip to this
 * point, and re-send a push the rider has already seen.
 */
async function sendConfirmationEmail(bookingId) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        bookingNumber: true,
        tripType: true,
        vehicleClass: true,
        pickupAddress: true,
        dropAddress: true,
        pickupAt: true,
        returnAt: true,
        distanceKm: true,
        estimatedFare: true,
        finalFare: true,
        advancePaid: true,
        balanceDue: true,
        paymentMode: true,
        fareBasis: true,
        guestName: true,
        customer: { select: { user: { select: { name: true, email: true } } } },
      },
    });
    if (!booking) return null;

    return await emailService.sendBookingConfirmedEmail({
      to: booking.customer?.user?.email ?? null,
      name: booking.customer?.user?.name ?? null,
      booking,
    });
  } catch (err) {
    console.error(`[notification] confirmation email failed for ${bookingId}: ${err.message}`);
    return { failed: true, error: err.message };
  }
}

/**
 * @param {import('bullmq').Job} job  data: { type, bookingId, to, extra }
 */
async function handle(job) {
  const { type, bookingId, to, extra = {} } = job.data;
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`[notification] unknown type "${type}"`);

  // Dedupe key: one notification of a given type per booking. A redelivered job
  // with the same key is a no-op.
  const key = `notif:${type}:${bookingId}`;

  const outcome = await runOnce(
    key,
    'notifications',
    async (tx) => {
      // The durable effect: read the booking (for template params) and record
      // the intent inside the transaction. We do not send here — the send is a
      // non-transactional external call fired after commit.
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        // dropAddress / pickupAt / tripType: the trip reminder names the
        // route and the pickup time.
        // estimatedFare / finalFare: BOOKING_CONFIRMED quotes the amount in
        // the push and the WhatsApp params.
        select: {
          bookingNumber: true,
          pickupAddress: true,
          dropAddress: true,
          pickupAt: true,
          tripType: true,
          estimatedFare: true,
          finalFare: true,
          customerId: true,
        },
      });
      if (!booking) throw new Error(`[notification] booking ${bookingId} not found`);

      return {
        bookingNumber: booking.bookingNumber,
        customerId: booking.customerId, // == User.id — the push target
        to: to || null,
        channel: tpl.channel,
        template: tpl.template,
        params: tpl.render({ ...booking, ...extra }),
        recordedAt: new Date().toISOString(),
      };
    },
    job.data
  );

  if (outcome.skipped) {
    // Already recorded (and, on the happy path, already sent) by a prior
    // delivery. Do nothing — this is the "one effect, not two" branch.
    console.log(`[notification] ${type} for booking …${String(bookingId).slice(-6)} already sent — skipped`);
    return { skipped: true };
  }

  // Fire the actual send AFTER the record committed. If this throws, the job
  // fails and BullMQ retries — but the record already exists, so the retry's
  // runOnce SKIPS the effect and (below) we still attempt the send. A rare
  // double-send is acceptable; a dropped confirmation is not.
  const rec = outcome.result;

  // 1) WhatsApp/SMS. Only when a phone number is present.
  //
  //    CAUGHT. This used to be a bare await, so a provider failure threw
  //    before the push below ever ran — and on retry runOnce reports the
  //    record as done and the handler returns early, so the push was lost for
  //    good, not merely delayed. The msg91 provider is a stub that ALWAYS
  //    throws, so NOTIFY_PROVIDER=msg91 plus an auth key (now set for login
  //    SMS) would have silently killed every push. A failure here is logged
  //    and the push still goes out.
  if (rec.to) {
    try {
      const provider = notifyProvider.getProvider();
      await provider.send({ to: rec.to, channel: rec.channel, template: rec.template, params: rec.params });
    } catch (err) {
      console.error(`[notification] ${rec.channel} failed for ${type} ${bookingId}: ${err.message}`);
    }
  }

  // 2) FCM push to the customer's devices. Independent of the phone channel and
  //    best-effort: a push failure must NOT fail the job (a retry would only be
  //    skipped by runOnce, and push is a lossy-tolerable channel). The SMS/
  //    WhatsApp path above remains the durable one.
  const pushTpl = PUSH[type];
  let pushResult = null;
  if (rec.customerId && pushTpl) {
    try {
      const { title, body } = pushTpl(rec);
      pushResult = await pushService.pushToUser(rec.customerId, {
        title,
        body,
        data: {
          type,
          bookingId: String(bookingId),
          bookingNumber: String(rec.bookingNumber),
        },
      });
    } catch (err) {
      console.error(`[notification] push failed for ${type} ${bookingId}: ${err.message}`);
    }
  }

  // 3) Email, for the types that have one. Same best-effort contract as the
  //    push: it sits inside the runOnce'd branch, so it goes out once per
  //    booking, and it cannot fail the job.
  let emailResult = null;
  if (EMAIL_TYPES.has(type)) {
    emailResult = await sendConfirmationEmail(bookingId);
  }

  // One line per notification, in production too. Completed jobs are not
  // logged there (workers/index.js), so without this a notification that ran
  // and one that never ran looked identical in the worker log.
  console.log(
    `[notification] ${type} ${rec.bookingNumber} -> ` +
      (pushResult ? `push ${JSON.stringify(pushResult)}` : 'no push for this type') +
      (emailResult
        ? ` | email ${emailResult.skipped ? emailResult.reason : emailResult.failed ? 'FAILED' : 'sent'}`
        : ''),
  );

  return {
    sent: !!rec.to,
    pushed: !!(rec.customerId && pushTpl),
    emailed: !!(emailResult && !emailResult.skipped && !emailResult.failed),
    bookingNumber: rec.bookingNumber,
  };
}

module.exports = { handle };