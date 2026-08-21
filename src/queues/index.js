'use strict';

/**
 * src/queues/index.js   — Day 12
 *
 * Defines the queues and the shared job policy. Importing this from the API
 * process gives you the producer side (Queue.add); the worker process
 * (src/workers) attaches the consumer side (Worker).
 *
 * ---------------------------------------------------------------------------
 * THE QUEUES
 * ---------------------------------------------------------------------------
 *   payments       CRITICAL. Money side-effects of a captured payment. Highest
 *                  retry budget; failures page someone.
 *   notifications  WhatsApp/SMS to customers (confirmed, driver assigned,
 *                  cancelled). Lossy is tolerable; still retried.
 *   documents      Invoice PDFs, receipts (deferred generation).
 *   analytics      Fire-and-forget metrics/rollups. Lowest priority.
 *   scheduled      Cron-like recurring jobs (sweepers, reconciliation, warming).
 *
 * Every queue shares a retry-with-backoff policy and, on FINAL failure, its job
 * is copied to the DEAD-LETTER queue where an operator can inspect and replay
 * it. Nothing is silently lost.
 */

const env = require('../config/env');

// Queue NAMES are safe to reference without a Redis connection. The Queue
// OBJECTS below are created lazily so merely importing a name does not connect.
const QUEUE = Object.freeze({
  PAYMENTS: 'payments',
  NOTIFICATIONS: 'notifications',
  DOCUMENTS: 'documents',
  ANALYTICS: 'analytics',
  SCHEDULED: 'scheduled',
  DEAD_LETTER: 'dead-letter',
});

/**
 * Default job options. At-least-once delivery + bounded retries with exponential
 * backoff. Completed/failed jobs are trimmed so Redis does not grow without
 * bound; failed jobs are kept longer for inspection before the DLQ takes over.
 */
const defaultJobOptions = {
  attempts: env.workers.maxAttempts,
  backoff: { type: 'exponential', delay: env.workers.backoffMs },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
};

// Payments get a larger retry budget — losing a money side-effect is worse than
// retrying it a few extra times.
const paymentJobOptions = {
  ...defaultJobOptions,
  attempts: Math.max(env.workers.maxAttempts, 8),
};

let queues = null;

/**
 * Lazily constructs and caches the Queue objects. Producer code calls this;
 * the worker process constructs its own Workers separately.
 */
function getQueues() {
  if (queues) return queues;

  const { Queue } = require('bullmq');
  const { getConnection } = require('./connection');
  const connection = getConnection();

  const make = (name, opts = defaultJobOptions) =>
    new Queue(name, { connection, defaultJobOptions: opts });

  queues = {
    [QUEUE.PAYMENTS]: make(QUEUE.PAYMENTS, paymentJobOptions),
    [QUEUE.NOTIFICATIONS]: make(QUEUE.NOTIFICATIONS),
    [QUEUE.DOCUMENTS]: make(QUEUE.DOCUMENTS),
    [QUEUE.ANALYTICS]: make(QUEUE.ANALYTICS),
    [QUEUE.SCHEDULED]: make(QUEUE.SCHEDULED),
    [QUEUE.DEAD_LETTER]: make(QUEUE.DEAD_LETTER, { removeOnComplete: false, removeOnFail: false }),
  };
  return queues;
}

/** Add a job to a queue by name. The one entry point producers use. */
async function enqueue(queueName, jobName, data, opts = {}) {
  const q = getQueues()[queueName];
  if (!q) throw new Error(`[queues] unknown queue "${queueName}"`);
  return q.add(jobName, data, opts);
}

async function closeQueues() {
  if (!queues) return;
  await Promise.all(Object.values(queues).map((q) => q.close().catch(() => {})));
  queues = null;
}

module.exports = {
  QUEUE,
  defaultJobOptions,
  getQueues,
  enqueue,
  closeQueues,
};