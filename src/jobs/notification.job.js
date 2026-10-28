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
const env = require('../config/env');
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

/* ---------------- formatting for the DLT SMS copy ---------------- */

/**
 * An SMS variable as DLT and the GSM-7 alphabet will actually accept it.
 *
 * TWO CONSTRAINTS, BOTH SILENT WHEN BROKEN:
 *
 *   1. One non-GSM character anywhere in the body — "₹", a curly quote, an
 *      en dash, a Kannada or Devanagari place name — flips the whole message
 *      to UCS-2. That halves the per-part length to 70 characters and bills
 *      accordingly, and some operators drop the message rather than re-encode
 *      it. So everything here is stripped to plain ASCII.
 *   2. Operators reject or truncate a variable longer than 30 characters.
 *      Truncating HERE, deliberately, is better than having the gateway do it
 *      somewhere mid-word or refuse the send outright.
 */
function smsVar(value, max = env.msg91.smsVarMax) {
  if (value == null) return '';
  const ascii = String(value)
    .normalize('NFKD')
    // Curly quotes / dashes that sneak in from addresses and admin input.
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ascii.length > max ? `${ascii.slice(0, max - 1).trim()}.` : ascii;
}

/**
 * Segments that carry no information for a rider reading a text: the country,
 * the state, and a six-digit PIN. Dropping them is what makes room for the
 * parts that identify the place — "Dasarahalli, Sahakar Nagar" beats
 * "Bengaluru, Karnataka, India" in the same number of characters.
 */
const ADDRESS_NOISE = /^(india|bharat|karnataka|ka|\d{6}|[a-z .]*\s\d{6})$/i;

/**
 * As much of an address as will fit in one SMS variable.
 *
 * placeName (used by the push copy) keeps only the text before the first
 * comma, which turned "SKYUP Digital Solutions, Dasarahalli Main Road,
 * Sahakar Nagar, Bengaluru" into just the company name. This keeps adding
 * comma-separated segments while they fit, so the rider gets the road and the
 * locality too.
 *
 * WHOLE SEGMENTS, NOT A HARD CUT. Truncating the joined string mid-word gives
 * "SKYUP Digital Solutions, Dasarahal." — the half-word reads like a bug. An
 * address that overflows simply stops at the last segment that fit.
 */
function addressForSms(raw, max = env.msg91.smsVarMax) {
  if (!raw) return '';

  const seen = new Set();
  const segments = [];
  for (const part of String(raw).split(',')) {
    // A trailing PIN rides along inside a segment ("Bengaluru 560092") as
    // often as it gets one of its own.
    const clean = smsVar(part, max).replace(/\s*\b\d{6}\b\s*$/, '').trim();
    if (!clean || ADDRESS_NOISE.test(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;   // "Bengaluru, Bengaluru Urban"
    seen.add(key);
    segments.push(clean);
  }
  if (!segments.length) return '';

  let out = segments[0];
  for (const segment of segments.slice(1)) {
    const next = `${out}, ${segment}`;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** "28 Oct 9:00 am" in India time — short, because it shares a variable. */
function istShort(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/,/g, '');
}

/**
 * "2,450.00" — the same number emailService.formatAmount produces, WITHOUT the
 * rupee sign. The approved template already prints "Rs.", and "₹" is not in
 * GSM-7 (see smsVar).
 */
function plainAmount(value) {
  const formatted = emailService.formatAmount(value);
  return formatted ? formatted.replace(/^₹/, '') : null;
}

/**
 * The four variables of the approved booking-confirmed template, in order:
 *
 *   Booking ID: ##var1##
 *   Trip details: ##var2##
 *   Scheduled date and vehicle: ##var3##
 *   Estimated fare: Rs. ##var4##
 *
 * Returns null when the fare cannot be read — a confirmation SMS quoting a
 * blank or "NaN" fare is worse than no SMS, and the push and email still go.
 */
/**
 * The variable NAMES this template uses, in the order the message reads them.
 *
 * MSG91 matches variables BY NAME, not by position — a name that is not in the
 * approved template substitutes nothing, which is why the first live message
 * arrived with every field blank while the fixed text came through intact.
 *
 * The names belong to whatever MSG91 generated when the DLT template was
 * imported, not to this code, so they are an env var: open the template in
 * MSG91 -> SMS -> Templates, read the six names off the body, and set
 * MSG91_BOOKING_VARS to them in this order:
 *
 *   booking id, pickup, drop, date, vehicle, fare
 */
const BOOKING_SMS_VARS = () => env.msg91.bookingVars;

/**
 * The six values of the approved booking-confirmed template:
 *
 *   Booking ID: ##1##
 *   Trip: ##2## to ##3##
 *   Date: ##4##
 *   Vehicle: ##5##
 *   Estimated fare: Rs. ##6##
 *
 * Each sits in its OWN variable, so each gets the full 30-character DLT
 * allowance — the pickup and drop no longer have to share one.
 *
 * Returns null when the fare cannot be read: a confirmation quoting a blank
 * fare is worse than no SMS, and the push and email still go out.
 */
function bookingConfirmedSmsVars(b) {
  const amount = plainAmount(b.finalFare ?? b.estimatedFare);
  if (!amount) return null;

  /*
   * A place name can come back empty — smsVar strips non-ASCII, so an address
   * stored entirely in Kannada or Devanagari reduces to "". The fallbacks keep
   * the line readable rather than printing "Trip:  to Mysuru".
   *
   * A local rental has no destination; its drop is the pickup again, so the
   * template's "to" slot says so instead of sitting empty.
   */
  const from = addressForSms(b.pickupAddress) || 'pickup point';
  const to =
    b.tripType === 'HOURLY'
      ? 'local rental'
      : addressForSms(b.dropAddress) || 'drop point';

  const values = [
    smsVar(b.bookingNumber),
    from,
    to,
    smsVar(istShort(b.pickupAt)),
    smsVar(b.vehicleClass),
    smsVar(amount),
  ];

  // Zipped against the configured names. A short MSG91_BOOKING_VARS silently
  // dropping the last fields is the one failure mode worth shouting about.
  const names = BOOKING_SMS_VARS();
  if (names.length < values.length) {
    console.error(
      `[notification] MSG91_BOOKING_VARS has ${names.length} names but the ` +
        `template needs ${values.length} — the SMS will arrive incomplete`,
    );
  }

  return Object.fromEntries(values.map((value, i) => [names[i] || `var${i + 1}`, value]));
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

  /*
   * THE RIDER'S CONFIRMATION — SENT AT BOOKING, NOT AT ADMIN CONFIRM.
   *
   * This type fires from BOOKING_CREATED, the moment the rider finishes
   * booking in the app. It carries the "Your booking is confirmed!" DLT SMS.
   *
   * The admin's confirm step is INTERNAL DISPATCH WORK: it decides which car
   * goes, not whether the trip is happening. Making the rider wait for it
   * meant someone could book at 11pm and hear nothing until morning, which
   * reads as a failed booking. So the rider is told immediately, and
   * BOOKING_CONFIRMED below has become the internal event.
   *
   * `amount` is pre-formatted here rather than in the push copy so the
   * channels can never quote the rider different numbers. `sms` carries the
   * DLT template's four variables, already ASCII-clean and length-capped —
   * the provider substitutes them by name and reformats nothing.
   */
  BOOKING_RECEIVED: {
    channel: 'sms',
    template: 'booking_confirmed',
    render: (b) => ({
      bookingNumber: b.bookingNumber,
      pickup: b.pickupAddress,
      amount: emailService.formatAmount(b.finalFare ?? b.estimatedFare),
      sms: bookingConfirmedSmsVars(b),
    }),
  },

  /*
   * The admin's confirm step. NO SMS — the rider already got one at booking,
   * and a second identical text would read as a duplicate send.
   *
   * `booking_confirmed_internal` is deliberately NOT mapped in
   * notify.provider's SMS_KIND, so this logs rather than sends. Leaving the
   * type in place keeps the push, the email and the notification record that
   * ops and the app's notification list rely on.
   */
  BOOKING_CONFIRMED: {
    channel: 'whatsapp',
    template: 'booking_confirmed_internal',
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
  /*
   * Fires at booking, alongside the confirmation SMS.
   *
   * The old copy said "we'll notify you as soon as it's confirmed" — written
   * when the rider genuinely was waiting on the admin. It cannot stay now
   * that a text saying "Your booking is confirmed!" lands in the same second;
   * two channels contradicting each other is worse than either alone.
   *
   * The fare goes in the tray so the rider sees the number without opening
   * anything. A booking with no readable fare gets the shorter line rather
   * than a push that trails off.
   */
  BOOKING_RECEIVED: (b) => {
    const amount = b.params?.amount || null;
    return {
      title: 'Booking confirmed',
      body: amount
        ? `Your booking ${b.bookingNumber} is confirmed. Estimated fare ${amount}.`
        : `Your booking ${b.bookingNumber} is confirmed.`,
    };
  },

  /*
   * The admin's confirm step, now INTERNAL. No push — the rider was told at
   * booking, and a second "Booking confirmed" an hour later invites the
   * question of which one was real. The trip screen still flips live via
   * BOOKING_STATUS_CHANGED, and ops still get the notification record.
   */
  BOOKING_CONFIRMED: null,
  DRIVER_ASSIGNED: (b) => ({
    title: 'Driver assigned',
    body: `A driver has been assigned to booking ${b.bookingNumber}.`,
  }),
  BOOKING_CANCELLED: (b) => ({
    title: 'Booking cancelled',
    body: `Booking ${b.bookingNumber} was cancelled.`,
  }),
};

/**
 * Types that also get an email. Keyed so adding one is a line, not a branch.
 *
 * Moved from BOOKING_CONFIRMED to BOOKING_RECEIVED with the SMS. The three
 * rider-facing channels now leave together at booking and say the same thing;
 * leaving the email on the admin's confirm would have had the rider read
 * "Booking confirmed" twice, hours apart, with the fare breakdown arriving
 * long after the text that quoted the fare.
 */
const EMAIL_TYPES = new Set(['BOOKING_RECEIVED']);

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
        // vehicleClass / guestPhone / customer.user.phone: the confirmation
        // SMS names the vehicle and needs somewhere to send the text.
        select: {
          bookingNumber: true,
          pickupAddress: true,
          dropAddress: true,
          pickupAt: true,
          tripType: true,
          vehicleClass: true,
          estimatedFare: true,
          finalFare: true,
          customerId: true,
          guestPhone: true,
          customer: { select: { user: { select: { phone: true } } } },
        },
      });
      if (!booking) throw new Error(`[notification] booking ${bookingId} not found`);

      /*
       * THE PHONE IS RESOLVED HERE, NOT TAKEN FROM THE JOB.
       *
       * Producers pass `to: p.customerPhone`, and nothing emits customerPhone —
       * lifecycle.confirm emits bookingId / bookingNumber / customerId /
       * pickupAt and no number. So `to` was always null and the SMS leg below
       * never ran, for any type. Reading the number from the booking makes
       * every notification type work regardless of what its producer happens
       * to put on the event; a producer that DOES send one still wins.
       *
       * guestPhone first: on a guest booking the user row deliberately has no
       * phone, and the booking is the only place the rider's number exists.
       */
      const phone = to || booking.guestPhone || booking.customer?.user?.phone || null;

      return {
        bookingNumber: booking.bookingNumber,
        customerId: booking.customerId, // == User.id — the push target
        to: phone,
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
  let sendResult = null;
  if (rec.to) {
    try {
      const provider = notifyProvider.getProvider();
      sendResult = await provider.send({
        to: rec.to,
        channel: rec.channel,
        template: rec.template,
        params: rec.params,
      });
    } catch (err) {
      console.error(`[notification] ${rec.channel} failed for ${type} ${bookingId}: ${err.message}`);
    }
  } else {
    console.warn(`[notification] ${type} ${rec.bookingNumber}: no phone on the booking — ${rec.channel} skipped`);
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
      (sendResult
        ? `${rec.channel} ${sendResult.status}${sendResult.messageId ? ` (${sendResult.messageId})` : ''} | `
        : rec.to ? `${rec.channel} FAILED | ` : '') +
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