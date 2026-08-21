'use strict';

/**
 * src/jobs/runOnce.js   — Day 12
 *
 * The mechanism behind the Day 12 done-line: "killing a worker mid-job causes
 * redelivery and produces one effect, not two."
 *
 * ---------------------------------------------------------------------------
 * WHY QUEUES NEED THIS AT ALL
 * ---------------------------------------------------------------------------
 * BullMQ (like every durable queue) is AT-LEAST-ONCE. A job is only removed
 * when the worker acknowledges completion. If the worker is killed after doing
 * the work but before acknowledging, the job's lock expires and it is
 * REDELIVERED. Without protection, the effect runs twice — a customer charged
 * twice, two "driver assigned" texts, a doubled ledger entry.
 *
 * ---------------------------------------------------------------------------
 * HOW runOnce MAKES IT EXACTLY-ONCE (for DB effects)
 * ---------------------------------------------------------------------------
 * We claim a unique key AND run the effect in the SAME database transaction:
 *
 *   BEGIN
 *     INSERT idempotency_keys(key)          -- unique; the claim
 *     <run the effect>                       -- same tx
 *   COMMIT
 *
 * Three cases, all correct:
 *   - Job runs to completion, worker acks     → committed once, one effect.
 *   - Worker killed BEFORE commit             → nothing committed; redelivery
 *                                               re-claims and re-runs → one effect.
 *   - Worker killed AFTER commit, before ack  → redelivery's INSERT hits the
 *                                               unique key, we SKIP → the one
 *                                               effect already stands.
 *
 * There is no window in which the effect happens twice, because the effect and
 * its "done" marker are the same commit. That is the whole trick.
 *
 * External side-effects (an actual SMS) cannot join a database transaction, so
 * for those the effect recorded here is the DURABLE INTENT ("this message is to
 * be sent"), and the send is fired after commit. The record is exactly-once;
 * the send is at-least-once — correct for SMS, where a rare duplicate is far
 * better than a silent drop.
 */

const crypto = require('crypto');
const { prisma, isUniqueViolation } = require('../config/prisma');

const TTL_HOURS = 72;

function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj ?? {})).digest('hex');
}

/**
 * Runs `effect(tx)` exactly once for a given `key`.
 *
 * @param {string} key       stable, job-derived dedupe key (e.g.
 *                           "notif:booking-confirmed:<bookingId>")
 * @param {string} endpoint  short label for the job type (stored for auditing)
 * @param {(tx) => Promise<any>} effect  the work, run inside the claim's tx
 * @param {object} [payload] hashed into request_hash so the same key with a
 *                           different payload is caught as a bug, not replayed
 *
 * @returns {Promise<{ skipped: boolean, result?: any }>}
 */
async function runOnce(key, endpoint, effect, payload = {}) {
  const requestHash = hash(payload);
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // THE CLAIM. Unique on `key`. If another delivery already committed this,
      // create() throws a unique violation and the whole transaction aborts —
      // so the effect below never runs a second time.
      await tx.idempotencyKey.create({
        data: {
          key: key.slice(0, 120),
          endpoint: endpoint.slice(0, 120),
          requestHash,
          status: 'COMPLETED',
          expiresAt,
        },
      });

      // THE EFFECT — same transaction as the claim.
      const out = await effect(tx);

      // Record the outcome for inspection/replay (best effort; ignore if the
      // payload is not serialisable).
      try {
        await tx.idempotencyKey.update({
          where: { key: key.slice(0, 120) },
          data: { responseBody: out == null ? {} : JSON.parse(JSON.stringify(out)) },
        });
      } catch (_) {
        /* non-serialisable result; the claim + effect already committed */
      }

      return out;
    });

    return { skipped: false, result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Already done by a previous (possibly killed-then-redelivered) attempt.
      // The single effect stands; this delivery is a no-op. THIS is the branch
      // that turns redelivery into "one effect, not two".
      return { skipped: true };
    }
    // A real failure inside the effect — the tx rolled back, INCLUDING the
    // claim, so a retry will re-run cleanly. Rethrow so BullMQ retries/backs off.
    throw err;
  }
}

module.exports = { runOnce, hash };