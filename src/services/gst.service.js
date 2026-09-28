/**
 * src/services/gst.service.js
 *
 * Answers three questions about tax, entirely from the database:
 *
 *   which GSTIN bills this trip     -> resolveConfig(pickupState)
 *   what rate applies, if any       -> resolveRate(tripType, pickupState)
 *   CGST+SGST or IGST               -> resolveSplitKind(pickupState, dropState)
 *
 * All three read one table, gst_config: one row per state the client is
 * registered in, holding the GSTIN, the rate, and a flag per trip type.
 *
 * Nothing here is hardcoded except the fallbacks that keep a fare quotable
 * when the tables are empty. GST_RATE_PCT in env is no longer read: a rate
 * that lives in an env var cannot be changed by an admin, and cannot differ by
 * trip type or state, which is the whole requirement.
 *
 * WHY THIS IS SEPARATE FROM billing.service
 * billing.service issues invoices — it runs once, at the end of a trip.
 * These answers are also needed at QUOTE time, for every fare option on the
 * fare list, so the rider can see the tax embedded in the price before they
 * book. Putting the resolution here lets both callers agree by construction
 * rather than by two copies staying in step.
 */

const { prisma } = require('../config/prisma');
const M = require('../lib/money');
const cache = require('./cache.service');

/**
 * Cache TTL. GST rows change about as often as a rate card — rarely, and
 * deliberately — so a long TTL is safe. The version suffix is the escape
 * hatch: bump it in the same commit as a migration that changes these tables,
 * and every stale entry is orphaned instantly rather than lingering.
 */
const TTL_SECONDS = 15 * 60;
const CACHE_VERSION = 'v1';

/**
 * Used only when the tables are empty or unreachable.
 *
 * Zero, deliberately. A missing rate must NOT silently become 18% — that would
 * invent a tax charge out of a failed query. Zero means "no tax line", which
 * is visibly wrong on an invoice and gets noticed, rather than quietly wrong
 * in a way that overcharges customers.
 */
const NO_TAX = Object.freeze({
  ratePct: 0,
  isInclusive: true,
  applies: false,
  source: 'none',
});

function norm(state) {
  return (state || '').trim().toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** Which column on the row switches this trip type on or off. */
const APPLY_COLUMN = {
  ONE_WAY: 'applyOneWay',
  ROUND_TRIP: 'applyRoundTrip',
  AIRPORT: 'applyAirport',
  HOURLY: 'applyHourly',
};

/**
 * The GST row that governs a trip, by PICKUP state.
 *
 * Per the requirement: a Bengaluru pickup bills on the Karnataka registration
 * whatever the destination. Returns null when the client is not registered in
 * that state, which callers must treat as "no tax invoice" rather than "tax
 * with no GSTIN" — an invoice without a seller GSTIN is not a valid tax
 * invoice.
 */
async function resolveConfig(pickupState) {
  const s = norm(pickupState);
  if (!s) return null;

  return cache.getOrSet(
    `gst:cfg:${CACHE_VERSION}:${s}`,
    async () => {
      const rows = await prisma.gstConfig.findMany({ where: { isActive: true } });
      // Compared in JS rather than SQL so casing and stray whitespace in
      // cities.state cannot silently miss a registration.
      return rows.find((r) => norm(r.state) === s) ?? null;
    },
    { ttl: TTL_SECONDS },
  );
}

/**
 * Rate and applicability for a trip type in a state.
 *
 * Returns NO_TAX when there is no registration for that state, or when the
 * trip type has been switched off on the row. The rate is still reported in
 * the second case so an admin screen can show what WOULD apply.
 */
async function resolveRate(tripType, pickupState, accountType) {
  const cfg = await resolveConfig(pickupState);
  if (!cfg) return NO_TAX;

  const column = APPLY_COLUMN[tripType];
  // An unknown trip type is not silently taxed: a new enum value that nobody
  // added a column for must read as "off", not as "18% by default".
  const tripTypeOk = column ? Boolean(cfg[column]) : false;

  /*
   * WHO is taxed. Corporate only.
   *
   * A personal rider is not taxed, which is what billing.service has always
   * done — retail invoices are NON_TAX bills of supply. Gating here keeps the
   * QUOTE honest against the INVOICE: before this, a personal rider saw
   * "Includes GST @18%" on the fare card for a fare that was then billed with
   * no tax line at all.
   *
   * An unknown or missing account type reads as retail, i.e. not taxed. Erring
   * toward no tax means a misconfiguration surfaces as a missing line someone
   * notices, rather than a charge the customer never agreed to.
   */
  const accountOk =
    accountType === 'CORPORATE' ? Boolean(cfg.applyCorporate) : Boolean(cfg.applyRetail);

  const applies = tripTypeOk && accountOk && Number(cfg.ratePct) > 0;

  return {
    ratePct: Number(cfg.ratePct),
    isInclusive: cfg.isInclusive,
    applies: applies && Number(cfg.ratePct) > 0,
    source: `gst_config:${cfg.id}`,
  };
}

/**
 * 'INTRA' (CGST + SGST) or 'INTER' (IGST).
 *
 *   interstateByRoute = false (default)
 *     By PLACE OF SUPPLY. For passenger transport that is where the passenger
 *     embarks — the pickup. Since the billing GSTIN is also chosen by pickup
 *     state, supplier state and place of supply always match, so every trip is
 *     INTRA. Bengaluru to Hyderabad is CGST+SGST on the Karnataka GSTIN.
 *
 *   interstateByRoute = true
 *     By ROUTE: pickup state vs drop state, so Bengaluru to Hyderabad is IGST.
 *     Note what that produces — an IGST invoice under a Karnataka GSTIN for a
 *     Karnataka place of supply. Confirm with a CA before enabling.
 *
 * A trip with no drop (a rental) is always INTRA: it starts and ends in the
 * same place, so there is no second state to compare.
 */
async function resolveSplitKind(pickupState, dropState) {
  const cfg = await resolveConfig(pickupState);
  if (!cfg || !cfg.interstateByRoute) return 'INTRA';
  if (!dropState) return 'INTRA';
  return norm(pickupState) === norm(dropState) ? 'INTRA' : 'INTER';
}

/* ------------------------------------------------------------------ *
 * Applying it to an amount
 * ------------------------------------------------------------------ */

/**
 * Splits an amount into taxable value and tax, honouring `isInclusive`.
 *
 * INCLUSIVE  the fare already contains the tax, so it is backed out:
 *            taxable = total / (1 + rate/100). The customer pays the fare they
 *            were quoted and the invoice totals to the same figure.
 *
 * EXCLUSIVE  the tax is added on top: total = fare * (1 + rate/100). Every
 *            fare rises by the rate. This is a pricing decision, which is why
 *            it is a stored flag and not a default.
 *
 * On an INTRA supply the tax halves into CGST and SGST, with SGST absorbing
 * any odd paisa so the two sum back to the tax exactly — a rounded half twice
 * over can otherwise miss the total by a paisa, and an invoice that does not
 * add up is a filing problem.
 */
function applyGst(amount, { ratePct, isInclusive, applies }, splitKind) {
  const gross = M.round2(amount);

  if (!applies || !ratePct) {
    return {
      taxable: gross,
      cgst: M.dec(0),
      sgst: M.dec(0),
      igst: M.dec(0),
      tax: M.dec(0),
      total: gross,
      ratePct: 0,
      isInclusive,
    };
  }

  const rate = M.dec(ratePct);
  let taxable;
  let total;

  if (isInclusive) {
    total = gross;
    taxable = M.round2(M.div(total, M.add(1, M.div(rate, 100))));
  } else {
    taxable = gross;
    total = M.round2(M.add(taxable, M.pct(taxable, rate)));
  }

  const tax = M.round2(M.sub(total, taxable));

  if (splitKind === 'INTRA') {
    const cgst = M.round2(M.div(tax, 2));
    return { taxable, cgst, sgst: M.sub(tax, cgst), igst: M.dec(0), tax, total, ratePct: Number(ratePct), isInclusive };
  }
  return { taxable, cgst: M.dec(0), sgst: M.dec(0), igst: tax, tax, total, ratePct: Number(ratePct), isInclusive };
}

/**
 * Everything a quote needs, in one call.
 *
 * Shaped for the fare list: the app shows the rate and the tax amount beside
 * the total, so a rider can see what is embedded before booking rather than
 * discovering it on the invoice afterwards.
 */
async function quoteTax(fareTotal, { tripType, pickupState, dropState, accountType }) {
  const [rate, splitKind] = await Promise.all([
    // accountType must be passed through: without it every caller of quoteTax
    // resolves as retail and reports no tax, including for a corporate rider.
    resolveRate(tripType, pickupState, accountType),
    resolveSplitKind(pickupState, dropState),
  ]);

  const applied = applyGst(fareTotal, rate, splitKind);

  return {
    ratePct: applied.ratePct,
    isInclusive: applied.isInclusive,
    applies: rate.applies,
    splitKind,
    taxable: M.toStr(applied.taxable),
    tax: M.toStr(applied.tax),
    cgst: M.toStr(applied.cgst),
    sgst: M.toStr(applied.sgst),
    igst: M.toStr(applied.igst),
    total: M.toStr(applied.total),
  };
}

module.exports = {
  resolveConfig,
  resolveRate,
  resolveSplitKind,
  applyGst,
  quoteTax,
  NO_TAX,
};