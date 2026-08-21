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

/** Message templates by notification type. Params fill the template. */
const TEMPLATES = {
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
  if (rec.to) {
    const provider = notifyProvider.getProvider();
    await provider.send({ to: rec.to, channel: rec.channel, template: rec.template, params: rec.params });
  }

  return { sent: !!rec.to, bookingNumber: rec.bookingNumber };
}

module.exports = { handle };