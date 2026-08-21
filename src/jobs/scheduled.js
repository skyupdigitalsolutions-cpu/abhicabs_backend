'use strict';

/**
 * src/jobs/scheduled.js   — Day 12
 *
 * The recurring maintenance jobs. Each is safe to run repeatedly (they reconcile
 * or sweep — no per-run side effect that could double up), so they do not need
 * runOnce; re-running one is a no-op or a fresh reconciliation.
 *
 *   reconciliation        cross-check ledger vs booking snapshots, log drift
 *   pendingPaymentSweeper expire stale unpaid payment orders + expire bookings
 *   sessionPruning        delete expired/revoked refresh tokens
 *   staleDriverCleanup    mark non-pinging drivers offline; release stale offers
 *   cacheWarming          re-warm the permission cache
 *
 * These are registered as BullMQ repeatable jobs by the worker process.
 */

const { prisma } = require('../config/prisma');
const env = require('../config/env');

/* ---------------- reconciliation ---------------- */

/**
 * Samples recently completed bookings and checks the ledger balances against
 * the fare — the "snapshot vs derived" reconciliation Day 8 set up. Logs any
 * drift for an operator; does not auto-correct (a mismatch needs a human).
 */
async function reconciliation() {
  const billing = require('../services/billing.service');

  const recent = await prisma.booking.findMany({
    where: { status: 'COMPLETED' },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: { id: true, bookingNumber: true },
  });

  let checked = 0;
  let drifted = 0;
  for (const b of recent) {
    // eslint-disable-next-line no-await-in-loop
    const bal = await billing.deriveBookingBalance(b.id);
    checked += 1;
    if (!bal.balanced) {
      drifted += 1;
      console.error(`[reconcile] DRIFT on ${b.bookingNumber}: fare=${bal.fareCharged} distributed=${bal.distributed}`);
    }
  }
  return { checked, drifted };
}

/* ---------------- pending-payment sweeper ---------------- */

/**
 * Two sweeps:
 *   1. Booking orders that were never paid and whose pickup time has passed →
 *      expire the booking (PENDING -> EXPIRED) via the lifecycle guard.
 *   2. Payment rows stuck at CREATED long past their order's usefulness are
 *      left as-is (a late webhook can still settle them); we only expire the
 *      BOOKING, not the payment, so a delayed capture is never lost.
 */
async function pendingPaymentSweeper() {
  const lifecycle = require('../services/lifecycle.service');

  const now = new Date();
  const stale = await prisma.booking.findMany({
    where: { status: 'PENDING', pickupAt: { lt: now } },
    select: { id: true, bookingNumber: true },
    take: 200,
  });

  let expired = 0;
  for (const b of stale) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await lifecycle.expire(b.id, { id: null, role: 'SYSTEM' }, { source: 'scheduler' });
      expired += 1;
    } catch (_) {
      // Already moved on (confirmed/cancelled between query and here) — fine.
    }
  }
  return { scanned: stale.length, expired };
}

/* ---------------- session pruning ---------------- */

/**
 * Deletes refresh tokens that are expired or were revoked more than a day ago.
 * Keeps the auth table small; a single batched delete.
 */
async function sessionPruning() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { lt: cutoff } },
      ],
    },
  });
  return { pruned: count };
}

/* ---------------- stale-driver cleanup ---------------- */

/**
 * Marks non-pinging drivers offline (Day 11) and releases assignment offers that
 * were never accepted within the timeout (Day 9). Both are batched and
 * idempotent; running them on a timer is exactly what they were built for.
 */
async function staleDriverCleanup() {
  const location = require('../services/location.service');
  const allocation = require('../services/allocation.service');

  const [drivers, offers] = await Promise.all([
    location.sweepStaleDrivers(),
    allocation.expireStaleOffers(),
  ]);
  return { driversSwept: drivers.swept, offersReleased: offers.released };
}

/* ---------------- cache warming ---------------- */

/**
 * Re-warms the permission cache so the first authorised request after a cache
 * flush/restart is not slow. Cheap and safe to run often.
 */
async function cacheWarming() {
  const permissionService = require('../services/permission.service');
  const res = await permissionService.warm();
  return { warmed: res || true };
}

/* ---------------- report pre-aggregation (Day 13) ---------------- */

/**
 * Recomputes and re-caches the heavy reports for the common windows (this month
 * and last 30 days). Run on a timer so the first dashboard hit after each
 * interval is served warm from cache instead of paying for a cold multi-second
 * scan. Reads go through the reporting client, so this never touches the
 * transactional pool. Safe to run repeatedly — it only reads and re-caches.
 */
async function reportPreaggregation() {
  const reportService = require('../services/report.service');
  return reportService.refreshPreaggregates();
}

/* ------------------------------------------------------------------ *
 * Registry — the worker maps a scheduled job's name to its handler.
 * ------------------------------------------------------------------ */

const HANDLERS = {
  reconciliation,
  'pending-payment-sweeper': pendingPaymentSweeper,
  'session-pruning': sessionPruning,
  'stale-driver-cleanup': staleDriverCleanup,
  'cache-warming': cacheWarming,
  'report-preaggregation': reportPreaggregation,
};

/**
 * The repeat schedules. Cron expressions in the server's local time. Kept
 * conservative — these are maintenance jobs, not real-time work.
 */
const SCHEDULES = [
  { name: 'stale-driver-cleanup', pattern: '*/1 * * * *' },   // every minute
  { name: 'pending-payment-sweeper', pattern: '*/5 * * * *' }, // every 5 min
  { name: 'cache-warming', pattern: '*/15 * * * *' },          // every 15 min
  { name: 'report-preaggregation', pattern: '*/10 * * * *' },  // every 10 min
  { name: 'session-pruning', pattern: '0 * * * *' },           // hourly
  { name: 'reconciliation', pattern: '30 2 * * *' },           // 02:30 daily
];

module.exports = { HANDLERS, SCHEDULES };