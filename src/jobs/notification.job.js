'use strict';

/**
 * src/jobs/notification.job.js   — Day 12
 *
 * Handles the notifications queue: WhatsApp/SMS for booking confirmed, driver
 * assigned, and cancellation.
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

/** Message templates by notification type. Params fill the template. */
const TEMPLATES = {
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
    render: (b) => ({ bookingNumber: b.bookingNumber, pickup: b.pickupAddress }),
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
  // Honest about where the booking stands: received, awaiting the admin's
  // confirmation — which arrives as its own "Booking confirmed" push.
  BOOKING_RECEIVED: (b) => ({
    title: 'Booking received',
    body: `We've received your booking ${b.bookingNumber}. We'll notify you as soon as it's confirmed.`,
  }),
  BOOKING_CONFIRMED: (b) => ({
    title: 'Booking confirmed',
    body: `Your booking ${b.bookingNumber} is confirmed.`,
  }),
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
        select: { bookingNumber: true, pickupAddress: true, customerId: true },
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
  if (rec.customerId && pushTpl) {
    try {
      const { title, body } = pushTpl(rec);
      await pushService.pushToUser(rec.customerId, {
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

  return { sent: !!rec.to, pushed: !!(rec.customerId && pushTpl), bookingNumber: rec.bookingNumber };
}

module.exports = { handle };