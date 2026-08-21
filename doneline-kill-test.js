#!/usr/bin/env node
'use strict';

/**
 * doneline-kill-test.js — Day 12 done-line.
 *
 * Proves: killing a worker mid-job causes redelivery and produces ONE effect,
 * not two.
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS
 * ---------------------------------------------------------------------------
 * We enqueue a notification job for a real bookingId. The notification handler
 * records its effect via runOnce (an idempotency_keys row keyed by
 * "notif:<type>:<bookingId>"). We then:
 *
 *   1. Start a worker.
 *   2. While it processes, KILL it hard (SIGKILL) so the job is NOT acked.
 *   3. BullMQ's lock expires and the job is REDELIVERED to a fresh worker.
 *   4. Count idempotency_keys rows for that key: must be exactly 1.
 *
 * The manual version (recommended, most convincing):
 *   Terminal A:  npm run worker
 *   Terminal B:  node doneline-kill-test.js enqueue <bookingId>
 *   Terminal A:  Ctrl-C is graceful — instead, kill -9 the worker PID while the
 *                job is mid-flight (add a sleep in the handler to widen the
 *                window, or watch the log).
 *   Then:        node doneline-kill-test.js count <bookingId>
 *
 * The SQL check (simplest proof):
 *   SELECT count(*) FROM idempotency_keys
 *   WHERE key = 'notif:BOOKING_CONFIRMED:<bookingId>';
 *   -- must be 1, no matter how many times the job was delivered.
 */

const mode = process.argv[2];
const bookingId = process.argv[3];

if (!mode || !bookingId) {
  console.log('Usage:');
  console.log('  node doneline-kill-test.js enqueue <bookingId>   # queue a notification job');
  console.log('  node doneline-kill-test.js count   <bookingId>   # count committed effects (expect 1)');
  process.exit(1);
}

(async () => {
  if (mode === 'enqueue') {
    const { QUEUE, enqueue, closeQueues } = require('./src/queues');
    const job = await enqueue(QUEUE.NOTIFICATIONS, 'booking-confirmed', {
      type: 'BOOKING_CONFIRMED',
      bookingId,
      to: null, // no real SMS; the durable EFFECT (the idempotency row) is what we count
    });
    console.log(`enqueued notification job ${job.id} for booking ${bookingId}`);
    console.log('Now: let the worker pick it up, KILL -9 the worker mid-job, watch it redeliver.');
    await closeQueues();
    process.exit(0);
  }

  if (mode === 'count') {
    const { prisma } = require('./src/config/prisma');
    const key = `notif:BOOKING_CONFIRMED:${bookingId}`;
    const n = await prisma.idempotencyKey.count({ where: { key } });
    console.log(`idempotency_keys rows for "${key}": ${n}`);
    console.log(n === 1
      ? 'PASS — exactly one committed effect despite any redeliveries.'
      : (n === 0 ? 'not processed yet (run the worker first)' : `FAIL — ${n} effects (expected 1)`));
    await prisma.$disconnect();
    process.exit(n === 1 ? 0 : 1);
  }

  console.error(`unknown mode "${mode}"`);
  process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });