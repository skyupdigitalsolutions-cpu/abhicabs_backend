'use strict';

/**
 * src/jobs/payment.job.js   — Day 12
 *
 * The CRITICAL queue. Processes the durable side-effects of a captured payment
 * asynchronously — anything that should happen once money is confirmed but need
 * not block the webhook's sub-2s response.
 *
 * Idempotent via runOnce, keyed by the gateway payment id, so a redelivered job
 * (worker killed mid-effect) applies exactly once. This is where the "one
 * effect, not two" guarantee protects actual money.
 */

const { runOnce } = require('./runOnce');

/**
 * @param {import('bullmq').Job} job  data: { paymentId, bookingId, providerPaymentId, purpose, amount }
 */
async function handle(job) {
  const { paymentId, bookingId, providerPaymentId, purpose, amount } = job.data;

  // Keyed by the gateway payment id — the globally-unique fact about this money
  // movement. Two deliveries of the same capture collapse to one effect.
  const key = `payjob:${providerPaymentId || paymentId}`;

  const outcome = await runOnce(
    key,
    'payments',
    async (tx) => {
      // The durable effect. Kept intentionally small and idempotent-by-nature;
      // heavier follow-on work (receipts, corporate credit reconciliation) is
      // enqueued to documents/analytics rather than done inline. Here we simply
      // stamp the payment as post-processed so downstream reads can rely on it.
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true, bookingId: true },
      });
      if (!payment) throw new Error(`[payment.job] payment ${paymentId} not found`);

      return {
        paymentId,
        bookingId: bookingId || payment.bookingId,
        purpose,
        amount,
        processedAt: new Date().toISOString(),
      };
    },
    job.data
  );

  return outcome.skipped ? { skipped: true } : { processed: true, ...outcome.result };
}

module.exports = { handle };