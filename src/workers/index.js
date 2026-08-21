'use strict';

/**
 * src/workers/index.js   — Day 12
 *
 * The WORKER PROCESS. Run separately from the API:
 *
 *     node src/workers        (or: npm run worker)
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE PROCESS
 * ---------------------------------------------------------------------------
 * A CPU-heavy or slow job (a PDF, a stuck external call) must never steal the
 * event loop from HTTP request handling. Separating workers from the API means:
 *   - the API stays responsive no matter how backed up the queues are;
 *   - workers scale independently (run 1 API + 4 workers, or vice versa);
 *   - a worker crash cannot take the API down, and a redeploy of one does not
 *     restart the other.
 *
 * This process opens BullMQ Workers (consumers) for each queue, registers the
 * repeatable scheduled jobs, and wires the dead-letter + alert path. It shares
 * the services and Prisma client with the API but never binds a port.
 */

const { Worker } = require('bullmq');
const db = require('../config/prisma');
const redis = require('../config/redis');
const env = require('../config/env');
const { getConnection, closeConnection } = require('../queues/connection');
const { QUEUE, getQueues, enqueue, closeQueues } = require('../queues');

const notificationJob = require('../jobs/notification.job');
const paymentJob = require('../jobs/payment.job');
const reportJob = require('../jobs/report.job');
const scheduled = require('../jobs/scheduled');

const connection = getConnection();
const concurrency = env.workers.concurrency;
const workers = [];

/* ------------------------------------------------------------------ *
 * Queue -> handler map
 * ------------------------------------------------------------------ */

const PROCESSORS = {
  [QUEUE.PAYMENTS]: (job) => paymentJob.handle(job),
  [QUEUE.NOTIFICATIONS]: (job) => notificationJob.handle(job),
  [QUEUE.DOCUMENTS]: (job) => handleDocument(job),
  [QUEUE.ANALYTICS]: (job) => handleAnalytics(job),
  [QUEUE.SCHEDULED]: (job) => handleScheduled(job),
};

// Documents queue. Day 13 routes 'report-csv' exports here so CSV generation
// runs off the request path. Other document jobs (invoice PDFs, receipts) will
// slot in the same way. Unknown names fall through to a logged no-op.
async function handleDocument(job) {
  if (job.name === 'report-csv') {
    const result = await reportJob.handle(job);
    console.log(`[worker:documents] report-csv ${job.data?.token} ->`, result.skipped ? 'skipped (dedup)' : `${result.bytes}B`);
    return result;
  }
  console.log(`[worker:documents] ${job.name}`, job.data);
  return { ok: true };
}
async function handleAnalytics(job) {
  console.log(`[worker:analytics] ${job.name}`, job.data);
  return { ok: true };
}

// A scheduled job's NAME selects its handler from the registry.
async function handleScheduled(job) {
  const fn = scheduled.HANDLERS[job.name];
  if (!fn) throw new Error(`[worker:scheduled] no handler for "${job.name}"`);
  const result = await fn();
  console.log(`[worker:scheduled] ${job.name} ->`, result);
  return result;
}

/* ------------------------------------------------------------------ *
 * Dead-letter queue
 *
 * When a job exhausts its retries, its FINAL failure is captured to the
 * dead-letter queue with the reason and payload, and an admin alert is emitted.
 * Nothing is silently lost — an operator can inspect and replay from there.
 * ------------------------------------------------------------------ */

async function toDeadLetter(queueName, job, failedReason) {
  try {
    await enqueue(QUEUE.DEAD_LETTER, `${queueName}:${job.name}`, {
      originalQueue: queueName,
      originalJobId: job.id,
      name: job.name,
      data: job.data,
      failedReason: String(failedReason || '').slice(0, 1000),
      attemptsMade: job.attemptsMade,
      deadAt: new Date().toISOString(),
    });
    // Best-effort admin alert. Also pushed to the notifications list the Day 10
    // dispatch/admin surface already drains.
    if (redis.isQueueUp()) {
      await redis.queue
        .rpush('notifications:admin', JSON.stringify({
          type: 'JOB_DEAD_LETTERED',
          queue: queueName,
          job: job.name,
          reason: String(failedReason || '').slice(0, 300),
          at: new Date().toISOString(),
        }))
        .catch(() => {});
    }
    console.error(`[worker:DLQ] ${queueName}:${job.name} dead-lettered after ${job.attemptsMade} attempts`);
  } catch (err) {
    console.error('[worker:DLQ] failed to dead-letter a job:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function start() {
  // Prisma and the Redis clients connect lazily on first use / at construction
  // (ioredis lazyConnect:false). A quick health probe surfaces a bad config now
  // rather than on the first job.
  await db.health().catch((e) => console.warn(`[worker] db health: ${e.message}`));

  // Ensure the queue objects exist (producers side) so the scheduler and DLQ can
  // add jobs from within this process too.
  getQueues();

  // One Worker per processable queue.
  for (const [queueName, processor] of Object.entries(PROCESSORS)) {
    const worker = new Worker(queueName, processor, { connection, concurrency });

    worker.on('completed', (job) => {
      if (env.nodeEnv !== 'production') {
        console.log(`[worker:${queueName}] done ${job.name}#${job.id}`);
      }
    });

    // 'failed' fires on EVERY attempt. Only when the job has no attempts left do
    // we dead-letter it — earlier failures are just retries with backoff.
    worker.on('failed', async (job, err) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts || 1);
      console.error(`[worker:${queueName}] failed ${job.name}#${job.id} attempt ${job.attemptsMade}: ${err.message}`);
      if (exhausted) await toDeadLetter(queueName, job, err.message);
    });

    worker.on('error', (err) => console.error(`[worker:${queueName}] error:`, err.message));
    workers.push(worker);
  }

  await registerSchedules();

  console.log(`[worker] up — ${workers.length} queues, concurrency ${concurrency}`);
}

/**
 * Registers the repeatable scheduled jobs on the SCHEDULED queue. BullMQ
 * deduplicates repeatables by name+pattern, so re-registering on every worker
 * start is safe and does not create duplicates.
 */
async function registerSchedules() {
  const q = getQueues()[QUEUE.SCHEDULED];
  for (const { name, pattern } of scheduled.SCHEDULES) {
    await q.add(name, {}, {
      repeat: { pattern },
      jobId: `sched:${name}`, // stable id keeps the repeatable singular
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }
  console.log(`[worker] ${scheduled.SCHEDULES.length} scheduled jobs registered`);
}

/* ------------------------------------------------------------------ *
 * Graceful shutdown — finish in-flight jobs, then release everything.
 * ------------------------------------------------------------------ */

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} — draining…`);
  try {
    // close() waits for active jobs to finish (up to the lock duration), so a
    // clean shutdown does NOT cause the redelivery the done-line tests — that
    // is what a KILL (-9) demonstrates instead.
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closeConnection();
    await redis.disconnect().catch(() => {});
    await db.disconnect().catch(() => {});
    await require('../config/reportingPrisma').disconnect().catch(() => {});
    console.log('[worker] bye');
    process.exit(0);
  } catch (err) {
    console.error('[worker] shutdown error:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandled rejection:', reason);
});

start().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});