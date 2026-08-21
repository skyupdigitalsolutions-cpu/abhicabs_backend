'use strict';

/**
 * src/services/report.service.js   — Day 13
 *
 * The reporting layer. Five reports, all built on the same three principles:
 *
 *   1. READ OFF THE REPORTING CLIENT. Every query here uses `reportingPrisma`
 *      (config/reportingPrisma.js) — an isolated pool / read replica — so a
 *      heavy scan never contends with live booking traffic.
 *
 *   2. CACHE WITH TTLs. Each report is wrapped in cache.getOrSet. A dashboard
 *      hit is served from Redis; only a cold key touches the database. The
 *      scheduled pre-aggregation job (jobs/scheduled.js) warms the common
 *      windows so the first user of the day is fast too.
 *
 *   3. MONEY IS DERIVED FROM THE LEDGER / INVOICES, NOT GUESSED. Revenue,
 *      commission, driver payout and GST come from the same authoritative
 *      records the billing service writes — so a report can be reconciled
 *      against the books, never diverge from them.
 *
 * Reports are READ-ONLY. Nothing here writes; the pre-aggregation job only
 * recomputes and re-caches.
 */

const { reportingPrisma: db } = require('../config/reportingPrisma');
const cache = require('./cache.service');
const env = require('../config/env');
const M = require('../lib/money');

/* ------------------------------------------------------------------ *
 * Date-range helpers — every report takes a { from, to } window
 * ------------------------------------------------------------------ */

/**
 * Normalises an optional { from, to } into concrete Dates, defaulting to the
 * last 30 days. `to` is exclusive-friendly (we use < to), so callers pass the
 * day AFTER the last day they want included, or a plain day and get midnight.
 */
function resolveRange({ from, to } = {}) {
  const now = new Date();
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  return { start, end };
}

/** A stable cache-key fragment for a window, to the minute. */
function rangeKey(start, end) {
  return `${start.toISOString().slice(0, 16)}_${end.toISOString().slice(0, 16)}`;
}

const num = (v) => (v == null ? 0 : Number(v));
const money = (v) => M.round2(v || 0).toFixed(2);

/* ================================================================== *
 * 1. EXECUTIVE REPORT
 *    The one-screen business summary for a period: volume, conversion,
 *    revenue and its distribution.
 * ================================================================== */

async function executiveReport(range = {}) {
  const { start, end } = resolveRange(range);
  const key = `report:exec:${rangeKey(start, end)}`;

  return cache.getOrSet(
    key,
    () => buildExecutive(start, end),
    { ttl: env.reporting.ttlLiveSeconds, cacheNull: false }
  );
}

async function buildExecutive(start, end) {
  // Booking volume + status mix in one grouped scan.
  const byStatus = await db.booking.groupBy({
    by: ['status'],
    where: { createdAt: { gte: start, lt: end } },
    _count: { _all: true },
  });

  const statusCounts = {};
  let totalBookings = 0;
  for (const row of byStatus) {
    statusCounts[row.status] = row._count._all;
    totalBookings += row._count._all;
  }
  const completed = statusCounts.COMPLETED || 0;
  const cancelled = statusCounts.CANCELLED || 0;

  // Revenue distribution comes from the LEDGER, summed by entry type over the
  // period. This is the authoritative money — the same rows billing wrote.
  const ledger = await db.ledgerEntry.groupBy({
    by: ['entryType'],
    where: { createdAt: { gte: start, lt: end } },
    _sum: { amount: true },
  });
  const ledgerBy = (t) => {
    const r = ledger.find((x) => x.entryType === t);
    return r?._sum.amount || 0;
  };

  const grossRevenue = ledgerBy('FARE_CHARGED');
  const driverPayout = ledgerBy('DRIVER_CREDIT');
  const commission = ledgerBy('COMMISSION');
  const welfare = ledgerBy('WELFARE_FEE');
  const refunds = ledgerBy('REFUND');

  // Cash actually collected in the window (captured payments), distinct from
  // revenue recognised — the two differ by advances and outstanding balances.
  const collected = await db.payment.aggregate({
    where: { status: 'CAPTURED', paidAt: { gte: start, lt: end } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  const distinctCustomers = await db.booking.findMany({
    where: { createdAt: { gte: start, lt: end } },
    distinct: ['customerId'],
    select: { customerId: true },
  });

  const avgFare = completed > 0 ? M.div(grossRevenue, completed) : 0;

  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    volume: {
      totalBookings,
      completed,
      cancelled,
      byStatus: statusCounts,
      completionRate: totalBookings ? Number((completed / totalBookings).toFixed(4)) : 0,
      cancellationRate: totalBookings ? Number((cancelled / totalBookings).toFixed(4)) : 0,
      distinctCustomers: distinctCustomers.length,
    },
    revenue: {
      grossRevenue: money(grossRevenue),
      commissionEarned: money(commission),
      driverPayout: money(driverPayout),
      welfareLevy: money(welfare),
      refunds: money(refunds),
      netToPlatform: money(M.sub(commission, refunds)),
      avgFarePerTrip: money(avgFare),
    },
    cash: {
      collected: money(collected._sum.amount || 0),
      paymentCount: collected._count._all,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* ================================================================== *
 * 2. FLEET UTILISATION REPORT
 *    How hard the fleet is working: trips and revenue per vehicle class,
 *    and how many vehicles actually moved.
 * ================================================================== */

async function fleetReport(range = {}) {
  const { start, end } = resolveRange(range);
  const key = `report:fleet:${rangeKey(start, end)}`;
  return cache.getOrSet(
    key,
    () => buildFleet(start, end),
    { ttl: env.reporting.ttlLiveSeconds, cacheNull: false }
  );
}

async function buildFleet(start, end) {
  // Total & active fleet size (a denominator for utilisation).
  const [fleetTotal, fleetActive, byStatus] = await Promise.all([
    db.vehicle.count(),
    db.vehicle.count({ where: { isActive: true } }),
    db.vehicle.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  // Trips + revenue per class come straight from BOOKINGS (no allocation join),
  // so a completed booking that happens to have more than one allocation row
  // (a decline-then-reoffer) is never double-counted. vehiclesUsed — which does
  // need the allocation join — is computed separately with COUNT(DISTINCT) and
  // merged in, so its fan-out cannot inflate trips or revenue.
  const [perClass, perClassVehicles, totalVehiclesRow] = await Promise.all([
    db.$queryRaw`
      SELECT b.vehicle_class                                      AS "vehicleClass",
             COUNT(*)                                             AS "trips",
             COALESCE(SUM(COALESCE(b.final_fare, b.estimated_fare)), 0) AS "revenue"
      FROM bookings b
      WHERE b.status = 'COMPLETED'
        AND b.completed_at >= ${start} AND b.completed_at < ${end}
      GROUP BY b.vehicle_class
    `,
    db.$queryRaw`
      SELECT b.vehicle_class              AS "vehicleClass",
             COUNT(DISTINCT a.vehicle_id) AS "vehiclesUsed"
      FROM allocations a
      JOIN bookings b ON b.id = a.booking_id
      WHERE b.status = 'COMPLETED'
        AND b.completed_at >= ${start} AND b.completed_at < ${end}
      GROUP BY b.vehicle_class
    `,
    db.$queryRaw`
      SELECT COUNT(DISTINCT a.vehicle_id) AS "n"
      FROM allocations a
      JOIN bookings b ON b.id = a.booking_id
      WHERE b.status = 'COMPLETED'
        AND b.completed_at >= ${start} AND b.completed_at < ${end}
    `,
  ]);

  const usedByClass = new Map(perClassVehicles.map((r) => [r.vehicleClass, num(r.vehiclesUsed)]));

  const classes = perClass
    .map((r) => {
      const vehiclesUsedForClass = usedByClass.get(r.vehicleClass) || 0;
      return {
        vehicleClass: r.vehicleClass,
        trips: num(r.trips),
        vehiclesUsed: vehiclesUsedForClass,
        revenue: money(r.revenue),
        revenuePerVehicle: vehiclesUsedForClass
          ? money(M.div(r.revenue, vehiclesUsedForClass))
          : '0.00',
      };
    })
    .sort((a, b) => Number(b.revenue) - Number(a.revenue));

  const totalTrips = classes.reduce((s, c) => s + c.trips, 0);
  const vehiclesUsed = num(totalVehiclesRow[0]?.n);

  const statusCounts = {};
  for (const row of byStatus) statusCounts[row.status] = row._count._all;

  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    fleet: {
      total: fleetTotal,
      active: fleetActive,
      byStatus: statusCounts,
      vehiclesUsed,
      utilisation: fleetActive ? Number((vehiclesUsed / fleetActive).toFixed(4)) : 0,
    },
    totals: {
      trips: totalTrips,
      tripsPerActiveVehicle: fleetActive ? Number((totalTrips / fleetActive).toFixed(2)) : 0,
    },
    byClass: classes,
    generatedAt: new Date().toISOString(),
  };
}

/* ================================================================== *
 * 3. DRIVER-PERFORMANCE REPORT
 *    Per-driver trips, earnings, rating and offer acceptance.
 * ================================================================== */

async function driverPerformanceReport(range = {}) {
  const { start, end } = resolveRange(range);
  const key = `report:driver:${rangeKey(start, end)}`;
  return cache.getOrSet(
    key,
    () => buildDriverPerformance(start, end),
    { ttl: env.reporting.ttlLiveSeconds, cacheNull: false }
  );
}

async function buildDriverPerformance(start, end) {
  // Per-driver roll-up. Offers/accepted/completedTrips come from the allocation
  // join; earnings come from a CORRELATED SUBQUERY over the driver's DISTINCT
  // completed bookings, so neither the ledger nor a repeat allocation can
  // fan-out and double-count. completedTrips is COUNT(DISTINCT booking) for the
  // same reason. Rating is read straight off the drivers row.
  const rows = await db.$queryRaw`
    SELECT d.user_id                                              AS "driverId",
           u.name                                                 AS "name",
           d.rating_avg                                           AS "ratingAvg",
           d.rating_count                                         AS "ratingCount",
           COUNT(a.id)                                            AS "offers",
           COUNT(a.accepted_at)                                   AS "accepted",
           COUNT(DISTINCT a.booking_id) FILTER (WHERE b.status = 'COMPLETED') AS "completedTrips",
           COALESCE((
             SELECT SUM(le.amount)
             FROM ledger_entries le
             WHERE le.entry_type = 'DRIVER_CREDIT'
               AND le.booking_id IN (
                 SELECT DISTINCT a2.booking_id
                 FROM allocations a2
                 JOIN bookings b2 ON b2.id = a2.booking_id
                 WHERE a2.driver_id = d.user_id
                   AND b2.status = 'COMPLETED'
                   AND a2.created_at >= ${start} AND a2.created_at < ${end}
               )
           ), 0)                                                  AS "earnings"
    FROM drivers d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN allocations a
           ON a.driver_id = d.user_id
          AND a.created_at >= ${start} AND a.created_at < ${end}
    LEFT JOIN bookings b ON b.id = a.booking_id
    GROUP BY d.user_id, u.name, d.rating_avg, d.rating_count
    ORDER BY "completedTrips" DESC, "earnings" DESC
  `;

  const drivers = rows.map((r) => {
    const offers = num(r.offers);
    const accepted = num(r.accepted);
    return {
      driverId: r.driverId,
      name: r.name,
      completedTrips: num(r.completedTrips),
      earnings: money(r.earnings),
      ratingAvg: num(r.ratingAvg),
      ratingCount: num(r.ratingCount),
      offersReceived: offers,
      offersAccepted: accepted,
      acceptanceRate: offers ? Number((accepted / offers).toFixed(4)) : 0,
    };
  });

  const activeDrivers = drivers.filter((d) => d.completedTrips > 0).length;
  const totalEarnings = drivers.reduce((s, d) => M.add(s, d.earnings), M.dec(0));

  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    summary: {
      driversWithTrips: activeDrivers,
      totalDriverEarnings: money(totalEarnings),
    },
    drivers,
    generatedAt: new Date().toISOString(),
  };
}

/* ================================================================== *
 * 4. BUSINESS-TREND REPORT
 *    A daily time series of volume and revenue, so a manager can SEE the
 *    trajectory rather than read a single number.
 * ================================================================== */

async function businessTrendReport(range = {}) {
  const { start, end } = resolveRange(range);
  const key = `report:trend:${rangeKey(start, end)}`;
  return cache.getOrSet(
    key,
    () => buildBusinessTrend(start, end),
    { ttl: env.reporting.ttlLiveSeconds, cacheNull: false }
  );
}

async function buildBusinessTrend(start, end) {
  // date_trunc gives a gap-tolerant daily bucket; days with no bookings simply
  // do not appear (the caller can zero-fill for a chart if it wants).
  const rows = await db.$queryRaw`
    SELECT date_trunc('day', b.created_at)::date       AS "day",
           COUNT(*)                                    AS "bookings",
           COUNT(*) FILTER (WHERE b.status = 'COMPLETED') AS "completed",
           COUNT(*) FILTER (WHERE b.status = 'CANCELLED') AS "cancelled",
           COALESCE(SUM(COALESCE(b.final_fare, b.estimated_fare))
                    FILTER (WHERE b.status = 'COMPLETED'), 0) AS "revenue"
    FROM bookings b
    WHERE b.created_at >= ${start} AND b.created_at < ${end}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  const series = rows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    bookings: num(r.bookings),
    completed: num(r.completed),
    cancelled: num(r.cancelled),
    revenue: money(r.revenue),
  }));

  const totalBookings = series.reduce((s, d) => s + d.bookings, 0);
  const totalRevenue = series.reduce((s, d) => M.add(s, d.revenue), M.dec(0));
  const days = series.length || 1;

  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    totals: {
      bookings: totalBookings,
      revenue: money(totalRevenue),
      avgBookingsPerDay: Number((totalBookings / days).toFixed(2)),
      avgRevenuePerDay: money(M.div(totalRevenue, days)),
    },
    series,
    generatedAt: new Date().toISOString(),
  };
}

/* ================================================================== *
 * 5. GST REPORT
 *    A GSTR-1-style summary from ISSUED tax invoices: taxable value and
 *    CGST/SGST/IGST split, plus the exempt (bill-of-supply) total.
 * ================================================================== */

async function gstReport(range = {}) {
  const { start, end } = resolveRange(range);
  const key = `report:gst:${rangeKey(start, end)}`;
  // Issued invoices are immutable, so GST can cache longer than the live reports.
  return cache.getOrSet(
    key,
    () => buildGst(start, end),
    { ttl: env.reporting.ttlGstSeconds, cacheNull: false }
  );
}

async function buildGst(start, end) {
  // Only ISSUED/PAID invoices count for a return; drafts and cancelled do not.
  const where = {
    issuedAt: { gte: start, lt: end },
    status: { in: ['ISSUED', 'PAID'] },
  };

  // Taxable (B2B / TAX) invoices — the ones that carry GST.
  const taxAgg = await db.invoice.aggregate({
    where: { ...where, type: 'TAX' },
    _sum: { taxableValue: true, cgst: true, sgst: true, igst: true, totalAmount: true },
    _count: { _all: true },
  });

  // Exempt supply (retail bill-of-supply, NON_TAX) — reported separately.
  const exemptAgg = await db.invoice.aggregate({
    where: { ...where, type: 'NON_TAX' },
    _sum: { totalAmount: true },
    _count: { _all: true },
  });

  const s = taxAgg._sum;
  const cgst = num(s.cgst);
  const sgst = num(s.sgst);
  const igst = num(s.igst);

  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    gstRatePct: env.billing.gstRatePct,
    sacCode: env.billing.sacCode,
    taxable: {
      invoiceCount: taxAgg._count._all,
      taxableValue: money(s.taxableValue),
      cgst: money(cgst),
      sgst: money(sgst),
      igst: money(igst),
      totalTax: money(M.add(M.add(cgst, sgst), igst)),
      invoiceTotal: money(s.totalAmount),
      intraStateTax: money(M.add(cgst, sgst)),
      interStateTax: money(igst),
    },
    exempt: {
      invoiceCount: exemptAgg._count._all,
      total: money(exemptAgg._sum.totalAmount),
    },
    note: 'Summary from issued tax invoices. GST is embedded (inclusive) in the fare; figures reconcile to invoice totals.',
    generatedAt: new Date().toISOString(),
  };
}

/* ================================================================== *
 * Registry — name -> builder. Used by the controller, the CSV export job,
 * and the pre-aggregation scheduler so all three agree on the report set.
 * ================================================================== */

const REPORTS = {
  executive: executiveReport,
  fleet: fleetReport,
  'driver-performance': driverPerformanceReport,
  'business-trend': businessTrendReport,
  gst: gstReport,
};

function isValidReport(type) {
  return Object.prototype.hasOwnProperty.call(REPORTS, type);
}

/** Runs a report by name (cached path). */
async function runReport(type, range = {}) {
  const fn = REPORTS[type];
  if (!fn) throw new Error(`[report] unknown report "${type}"`);
  return fn(range);
}

/**
 * Pre-aggregation entry point for the scheduler. Recomputes and re-caches the
 * common windows (this-month and last-30-days) so a dashboard hit is always
 * warm. Cheap relative to the value: it turns a multi-second cold report into
 * an instant one for the first user after each interval.
 */
async function refreshPreaggregates() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const windows = [
    { from: monthStart.toISOString(), to: now.toISOString() },
    { from: last30.toISOString(), to: now.toISOString() },
  ];

  let warmed = 0;
  for (const type of Object.keys(REPORTS)) {
    for (const w of windows) {
      // Bust the cached key first so we recompute fresh, then let runReport
      // repopulate it.
      const { start, end } = resolveRange(w);
      const key = `report:${keyForType(type)}:${rangeKey(start, end)}`;
      await cache.del(key);
      // eslint-disable-next-line no-await-in-loop
      await runReport(type, w);
      warmed += 1;
    }
  }
  return { warmed, windows: windows.length, reports: Object.keys(REPORTS).length };
}

// The cache-key fragment each report uses (kept in sync with the builders).
function keyForType(type) {
  return {
    executive: 'exec',
    fleet: 'fleet',
    'driver-performance': 'driver',
    'business-trend': 'trend',
    gst: 'gst',
  }[type];
}

module.exports = {
  REPORTS,
  isValidReport,
  runReport,
  refreshPreaggregates,
  resolveRange,
  // individual reports (exported for direct use / tests)
  executiveReport,
  fleetReport,
  driverPerformanceReport,
  businessTrendReport,
  gstReport,
};