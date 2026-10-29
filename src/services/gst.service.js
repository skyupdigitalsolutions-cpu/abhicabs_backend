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
const audit = require('./audit.service');
const { ApiError } = require('../utils/helpers');

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
const CACHE_PREFIX = `gst:cfg:${CACHE_VERSION}:`;

/**
 * Drop every cached registration.
 *
 * Called after ANY admin write. The TTL is fifteen minutes, which is fine for
 * a table that changes twice a year and intolerable the one time it matters:
 * an admin correcting a placeholder GSTIN, or switching a trip type off,
 * needs that live on the next quote — not on the next quarter-hour. Without
 * this, the admin screen shows the new value and every invoice keeps using
 * the old one, which reads as the save having failed.
 *
 * By prefix, not by state: a row's state can itself be edited, so clearing
 * only the state we just wrote would leave the OLD state's entry pointing at
 * a registration that has moved.
 */
async function invalidate() {
  await cache.delByPrefix(CACHE_PREFIX);
}

async function resolveConfig(pickupState) {
  const s = norm(pickupState);
  if (!s) return null;

  return cache.getOrSet(
    `${CACHE_PREFIX}${s}`,
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
async function resolveSplitKind(pickupState, dropState, recipientGstin = null) {
  const cfg = await resolveConfig(pickupState);
  if (!cfg) return 'INTRA';

  /*
   * B2B: compare against the state in the CUSTOMER's own GSTIN.
   *
   * Checked before interstateByRoute, because it is the more specific rule
   * and the two can disagree — a Karnataka pickup dropping in Karnataka for
   * a Telangana-registered company is INTRA by route and INTER by recipient.
   *
   * Only when a GSTIN was actually supplied. A retail trip has no recipient
   * registration to compare with and must fall through, or every personal
   * booking would be forced INTRA by a rule that was never about it.
   */
  if (cfg.splitByRecipientGstin && recipientGstin) {
    const recipientState = stateFromGstin(recipientGstin);
    // An unrecognised state code reads as "no answer" and falls through,
    // rather than defaulting to INTER and raising IGST off a typo.
    if (recipientState) {
      return norm(cfg.state) === norm(recipientState) ? 'INTRA' : 'INTER';
    }
  }

  if (!cfg.interstateByRoute) return 'INTRA';
  if (!dropState) return 'INTRA';
  return norm(pickupState) === norm(dropState) ? 'INTRA' : 'INTER';
}

/* ------------------------------------------------------------------ *
 * GSTIN -> state
 * ------------------------------------------------------------------ */

/**
 * The first two digits of a GSTIN are the state code.
 *
 * A SECOND COPY of the table in corporate.service, and that is deliberate
 * rather than careless: requiring corporate.service from here would close a
 * cycle, because corporate.service already reaches billing-side code that
 * reaches this file. The list is a statutory constant that last changed when
 * Ladakh was created; the duplication costs nothing and the cycle would cost
 * a startup crash.
 */
const GST_STATE_CODES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
});

function stateFromGstin(gstin) {
  return GST_STATE_CODES[String(gstin || '').slice(0, 2)] || null;
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
async function quoteTax(
  fareTotal,
  { tripType, pickupState, dropState, accountType, recipientGstin = null },
) {
  const [rate, splitKind] = await Promise.all([
    // accountType must be passed through: without it every caller of quoteTax
    // resolves as retail and reports no tax, including for a corporate rider.
    resolveRate(tripType, pickupState, accountType),
    resolveSplitKind(pickupState, dropState, recipientGstin),
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

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ *
 *
 * THERE WAS NO WAY TO EDIT THIS TABLE.
 *
 * gst_config shipped with a migration that seeded two placeholder GSTINs and
 * no API of any kind — no route, no controller, no service write. So the
 * rate, the registrations, the per-trip-type toggles and the retail/corporate
 * switches could only be changed with a psql session against production. The
 * missing Telangana registration sat there for a month for exactly that
 * reason: nobody could add it without a developer.
 *
 * Every write invalidates the cache, because a tax change that takes fifteen
 * minutes to appear looks like a save that did not work.
 */

/** Every registration, active first. Admin screens want the retired ones too. */
async function listConfigs({ includeInactive = true } = {}) {
  return prisma.gstConfig.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: 'desc' }, { state: 'asc' }],
  });
}

async function getConfig(id) {
  const row = await prisma.gstConfig.findUnique({ where: { id: Number(id) } });
  if (!row) throw ApiError.notFound('GST registration not found', 'GST_CONFIG_NOT_FOUND');
  return row;
}

/**
 * The GSTIN's own state code must agree with the state on the row.
 *
 * REFUSES, where corporate.service only warns, and the asymmetry is the
 * point. There, a mismatch is a customer's data about their own company and
 * we are a bystander — a company may legitimately be headquartered in one
 * state and registered in another. Here it is OUR registration, and the state
 * on the row is what resolveConfig matches a pickup against. A Karnataka row
 * carrying a Telangana GSTIN means every Bengaluru pickup raises an invoice
 * under the wrong registration, which is a filing problem, not a warning.
 */
function assertGstinMatchesState(gstin, state) {
  const encoded = stateFromGstin(gstin);
  if (!encoded) {
    throw ApiError.badRequest(
      `${String(gstin).slice(0, 2)} is not a valid GST state code`,
      'GSTIN_STATE_UNKNOWN',
    );
  }
  if (norm(encoded) !== norm(state)) {
    throw ApiError.badRequest(
      `This GSTIN begins ${String(gstin).slice(0, 2)}, which is ${encoded}, but the ` +
        `registration is for ${state}. Every invoice raised on it would carry the ` +
        'wrong place of supply.',
      'GSTIN_STATE_MISMATCH',
    );
  }
}

async function createConfig(input, actor, meta = {}) {
  const gstin = String(input.gstin).trim().toUpperCase();
  assertGstinMatchesState(gstin, input.state);

  /*
   * One ACTIVE registration per state, enforced by a partial unique index.
   * Checked here as well so the admin gets a sentence instead of a constraint
   * name, and so the sentence can say what to do about it.
   */
  const clash = await prisma.gstConfig.findFirst({
    where: { isActive: true, state: input.state },
    select: { id: true, gstin: true },
  });
  if (clash && input.isActive !== false) {
    throw ApiError.conflict(
      `An active registration already exists for ${input.state} (${clash.gstin}). ` +
        'Retire it first, or edit it instead of adding a second.',
      'GST_CONFIG_STATE_ACTIVE',
    );
  }

  const row = await prisma.gstConfig.create({ data: { ...input, gstin } });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'GST_CONFIG_CREATED',
    entityType: 'gst_config',
    entityId: row.id,
    after: row,
    meta,
  });

  return row;
}

async function updateConfig(id, patch, actor, meta = {}) {
  const before = await getConfig(id);

  const gstin = patch.gstin ? String(patch.gstin).trim().toUpperCase() : before.gstin;
  const state = patch.state ?? before.state;
  // Re-checked whenever EITHER side moves. Validating only when the GSTIN
  // changes would let an admin edit the state out from under a correct GSTIN
  // and leave the row mismatched.
  if (patch.gstin || patch.state) assertGstinMatchesState(gstin, state);

  const row = await prisma.gstConfig.update({
    where: { id: Number(id) },
    data: { ...patch, ...(patch.gstin ? { gstin } : {}) },
  });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'GST_CONFIG_UPDATED',
    entityType: 'gst_config',
    entityId: row.id,
    before,
    after: row,
    meta,
  });

  return row;
}

/**
 * Retire a registration. NEVER deletes.
 *
 * Invoices snapshot the seller details at issue, so a deleted row does not
 * corrupt an invoice already held — but it does destroy the only record of
 * what the registration was before it was replaced, which is the thing a tax
 * audit asks for.
 */
async function deactivateConfig(id, actor, meta = {}) {
  const before = await getConfig(id);
  const row = await prisma.gstConfig.update({
    where: { id: Number(id) },
    data: { isActive: false },
  });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'GST_CONFIG_DEACTIVATED',
    entityType: 'gst_config',
    entityId: row.id,
    before,
    after: row,
    meta,
  });

  return row;
}

/**
 * What the current configuration actually does, as a sentence per state.
 *
 * For the admin screen, and for whoever is asked "is GST working?" — which is
 * a question nobody could answer from this table before, because the
 * placeholder GSTINs look exactly like real ones at a glance.
 */
async function health() {
  const rows = await prisma.gstConfig.findMany({ orderBy: { state: 'asc' } });

  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    gstin: r.gstin,
    isActive: r.isActive,
    ratePct: Number(r.ratePct),
    isInclusive: r.isInclusive,
    appliesTo: [r.applyRetail && 'RETAIL', r.applyCorporate && 'CORPORATE'].filter(Boolean),
    tripTypes: [
      r.applyOneWay && 'ONE_WAY',
      r.applyRoundTrip && 'ROUND_TRIP',
      r.applyAirport && 'AIRPORT',
      r.applyHourly && 'HOURLY',
    ].filter(Boolean),
    /*
     * The single most useful line on this screen. A placeholder GSTIN is in
     * the right format and passes every validator, so the only way to notice
     * one is to recognise the pattern — which is exactly what nobody did for
     * a month.
     */
    placeholderGstin: /^\d{2}AAAAA0000A1Z5$/.test(r.gstin),
    stateCodeMatches: norm(stateFromGstin(r.gstin) || '') === norm(r.state),
  }));
}

module.exports = {
  resolveConfig,
  resolveRate,
  resolveSplitKind,
  applyGst,
  quoteTax,
  stateFromGstin,
  invalidate,
  listConfigs,
  getConfig,
  createConfig,
  updateConfig,
  deactivateConfig,
  health,
  NO_TAX,
};