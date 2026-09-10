'use strict';

/**
 * src/services/billing.service.js   — Day 8
 *
 * Turns a completed booking into its financial record: one invoice and a
 * balanced set of ledger entries, generated inside the completion transaction
 * so a booking is never marked COMPLETED without its books being written.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 * ---------------------------------------------------------------------------
 *  1. GAP-FREE INVOICE NUMBERS. GST law requires an unbroken series. We draw
 *     from a Postgres SEQUENCE (nextval), never from COUNT(*)+1 — a count has a
 *     race (two invoices read the same count) and leaves holes when a row is
 *     deleted. A sequence is atomic and monotonic by construction.
 *
 *  2. A BALANCED LEDGER. The fare is split into what the driver earns, the
 *     state welfare levy, and the platform commission. Commission is computed
 *     as the REMAINDER, not its own percentage, so
 *         FARE_CHARGED == DRIVER_CREDIT + WELFARE_FEE + COMMISSION
 *     holds to the paisa regardless of rounding. That exact identity is the
 *     Day 8 done-line.
 *
 *  3. IDEMPOTENCE. Every ledger entry has a deterministic unique `reference`
 *     and there is at most one invoice per booking. Re-running finalise (a
 *     retry, a replayed completion) inserts nothing new and throws nothing.
 */

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const M = require('../lib/money');
const env = require('../config/env');
const audit = require('./audit.service');

/* ------------------------------------------------------------------ *
 * Financial year & invoice numbering
 * ------------------------------------------------------------------ */

/**
 * Indian financial year for a date: 1 April – 31 March. A trip on 2026-08-19
 * falls in FY 2026-2027; one on 2026-02-10 falls in 2025-2026.
 */
function financialYear(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/**
 * Next gap-free invoice number, e.g. "A/2026-2027/000042".
 *
 * The number comes from nextval() — atomic and monotonic. The financial year
 * and series are formatting around that single source of truth; the sequence
 * itself is what guarantees no two invoices ever share a number and none is
 * skipped by a race.
 */
async function nextInvoiceNumber(tx, series, fy) {
  const [{ nextval }] = await tx.$queryRaw`SELECT nextval('invoice_number_seq') AS nextval`;
  return `${series}/${fy}/${String(nextval).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------ *
 * GST
 * ------------------------------------------------------------------ */

/**
 * Splits a GST-INCLUSIVE gross into taxable value and tax components.
 *
 * WHY INCLUSIVE: the fare the customer was quoted is what they pay. The tax
 * invoice must total to that same figure, so we back out the embedded GST
 * rather than adding it on top — otherwise the invoice total would exceed the
 * fare and the ledger would not reconcile against what was actually charged.
 * (Exclusive/B2B-with-ITC pricing is a separate business decision; when it is
 * made, only this function and its config flag change.)
 *
 * Intra-state supply (place of supply == supplier state) splits into CGST+SGST,
 * half each. Inter-state supply is a single IGST line. Which one applies is
 * decided by comparing the supplier's state (the operating city) with the
 * billed party's state.
 */
function splitGstInclusive(gross, ratePct, intraState) {
  const total = M.round2(gross);
  const rate = M.dec(ratePct);

  // taxable = total / (1 + rate/100)
  const divisor = M.add(1, M.div(rate, 100));
  const taxable = M.round2(M.div(total, divisor));
  const tax = M.round2(M.sub(total, taxable));

  if (intraState) {
    // Half to CGST, half to SGST. SGST absorbs any odd paisa so the two halves
    // sum back to `tax` exactly.
    const cgst = M.round2(M.div(tax, 2));
    const sgst = M.sub(tax, cgst);
    return { taxable, cgst, sgst, igst: M.dec(0), total };
  }
  return { taxable, cgst: M.dec(0), sgst: M.dec(0), igst: tax, total };
}

/* ------------------------------------------------------------------ *
 * The finaliser — called INSIDE the completion transaction
 * ------------------------------------------------------------------ */

const BILLING_SELECT = {
  id: true,
  bookingNumber: true,
  status: true,
  cityId: true,
  customerId: true,
  corporateAccountId: true,
  estimatedFare: true,
  finalFare: true,
  advancePaid: true,
  balanceDue: true,
  driverSharePct: true,
  pickupAt: true,
  // Read for the extra-distance invoice line. `meta.extraDistance` is written by
  // lifecycle.recordTripDistance when a trip runs longer than quoted.
  distanceKm: true,
  fareBasis: true,
  meta: true,
  city: { select: { id: true, name: true, state: true, welfareFeePct: true } },
  customer: {
    select: {
      userId: true,
      accountType: true,
      user: { select: { id: true, name: true, email: true } },
    },
  },
  corporate: {
    select: {
      id: true,
      companyName: true,
      gstin: true,
      billingAddress: true,
      billingState: true,
    },
  },
};

/**
 * Generates the invoice and ledger set for a booking that has just been marked
 * COMPLETED. MUST run inside the caller's transaction `tx`.
 *
 * Idempotent: if the booking already has an invoice, returns it and writes
 * nothing. Safe to call again on a retried completion.
 *
 * @returns {Promise<{ invoice, ledger, reused }>}
 */
async function finaliseBooking(tx, bookingId, actor = null, meta = {}) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: BILLING_SELECT,
  });
  if (!booking) throw ApiError.notFound('Booking not found');

  // Idempotence guard #1: one invoice per booking. An invoice line carries the
  // bookingId, so an existing line means this booking is already billed.
  const existingLine = await tx.invoiceLine.findFirst({
    where: { bookingId },
    select: { invoiceId: true },
  });
  if (existingLine) {
    const invoice = await tx.invoice.findUnique({
      where: { id: existingLine.invoiceId },
      include: { lines: true },
    });
    const ledger = await tx.ledgerEntry.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
    });
    return { invoice, ledger, reused: true };
  }

  const fare = M.round2(booking.finalFare != null ? booking.finalFare : booking.estimatedFare);
  const isCorporate = booking.customer?.accountType === 'CORPORATE' && booking.corporateAccountId;

  const invoice = await createInvoice(tx, booking, fare, isCorporate);
  const ledger = await writeLedgerSet(tx, booking, fare);

  audit.recordAsync({
    actor,
    action: 'INVOICE_ISSUED',
    entityType: 'invoice',
    entityId: invoice.id,
    after: {
      invoiceNumber: invoice.invoiceNumber,
      type: invoice.type,
      total: invoice.totalAmount,
      bookingId,
    },
    meta,
  });

  return { invoice, ledger, reused: false };
}

/**
 * Builds the invoice row + its single line. Type follows the account:
 *   CORPORATE -> TAX     (GST broken out)
 *   RETAIL    -> NON_TAX (no GST; a bill of supply)
 */
async function createInvoice(tx, booking, fare, isCorporate) {
  const fy = financialYear(booking.pickupAt || new Date());
  const series = env.billing.invoiceSeries;
  const invoiceNumber = await nextInvoiceNumber(tx, series, fy);

  const supplierState = booking.city?.state || 'Karnataka';

  let type;
  let gst;
  let billTo;

  if (isCorporate) {
    type = 'TAX';
    const recipientState = booking.corporate?.billingState || supplierState;
    const intraState =
      recipientState.trim().toLowerCase() === supplierState.trim().toLowerCase();
    gst = splitGstInclusive(fare, env.billing.gstRatePct, intraState);
    billTo = {
      name: booking.corporate?.companyName || 'Corporate',
      address: booking.corporate?.billingAddress || null,
      gstin: booking.corporate?.gstin || null,
    };
  } else {
    // Retail: no tax. A bill of supply — subtotal == taxable == total.
    type = 'NON_TAX';
    gst = { taxable: fare, cgst: M.dec(0), sgst: M.dec(0), igst: M.dec(0), total: fare };
    billTo = {
      name: booking.customer?.user?.name || 'Customer',
      address: null,
      gstin: null,
    };
  }

  return tx.invoice.create({
    data: {
      invoiceNumber,
      series,
      financialYear: fy,
      type,
      status: 'ISSUED',
      customerId: booking.customerId,
      corporateAccountId: booking.corporateAccountId,
      billToName: billTo.name,
      billToAddress: billTo.address,
      billToGstin: billTo.gstin,
      subtotal: gst.taxable.toFixed(2),
      discount: '0.00',
      taxableValue: gst.taxable.toFixed(2),
      cgst: gst.cgst.toFixed(2),
      sgst: gst.sgst.toFixed(2),
      igst: gst.igst.toFixed(2),
      totalAmount: gst.total.toFixed(2),
      placeOfSupply: supplierState,
      hsnSac: env.billing.sacCode,
      lines: {
        create: buildInvoiceLines(booking, gst.taxable, fare),
      },
    },
    include: { lines: true },
  });
}

/**
 * Builds the invoice line(s) for a booking.
 *
 * The default is one "Cab service" line for the whole taxable value. Charges
 * the customer is likely to QUERY are broken out onto their own lines — the
 * night allowance, the driver allowance (bata), and any extra distance:
 *
 *   Cab service — booking ABH-2026-000123        ₹1,200.00
 *   Night allowance (21:55–06:00)                  ₹338.00
 *   Driver allowance / Bata (2 days × ₹400.00)     ₹800.00
 *   Extra distance (8.0 km × ₹14.00/km)            ₹112.00
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THREE AND NOT EVERY COMPONENT
 * ---------------------------------------------------------------------------
 * An invoice is not a fare breakdown. Itemising base, per-km, per-minute and
 * return-empty turns a bill into a spreadsheet nobody reads. These three are
 * different: they are the lines a customer does not expect. "Why is this ₹338
 * more than the app quoted?" is a support ticket if the invoice is silent and
 * a non-event if the invoice says "Night allowance (21:55–06:00)". The full
 * component-level breakdown still lives on booking.fareBasis for disputes.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AMOUNTS ARE SCALED
 * ---------------------------------------------------------------------------
 * Fares are GST-INCLUSIVE, so on a TAX invoice the taxable value is the gross
 * with the embedded tax backed out. The allowance figures on fareBasis are
 * gross. Copying them straight onto a taxable-value invoice would overstate
 * each line and force the "Cab service" remainder to absorb the difference —
 * the invoice would still foot, but the individual lines would be wrong, and
 * the night line would not match what the fare engine said it charged.
 *
 * Scaling every broken-out line by taxable/gross keeps each line a genuine
 * taxable value. On a retail NON_TAX invoice the ratio is exactly 1, so
 * nothing changes there.
 *
 * The "Cab service" line is always the REMAINDER, so whatever rounding falls
 * out of the scaling lands in one place and the lines sum to the taxable value
 * to the paisa.
 */
function buildInvoiceLines(booking, taxable, gross) {
  const taxableValue = M.round2(taxable);

  // Gross → taxable ratio. Guard the zero-fare case rather than dividing by it.
  const grossValue = M.round2(gross ?? taxable);
  const ratio = M.isPositive(grossValue) ? M.div(taxableValue, grossValue) : M.dec(1);
  const scaled = (amount) => M.round2(M.mul(M.dec(amount ?? 0), ratio));

  // The frozen quote. booking.service stores it at fareBasis.components; fall
  // back to the top level for any older row written before that nesting.
  const fareBasis = booking.fareBasis || {};
  const quote = fareBasis.components || fareBasis;
  const quoteMeta = quote.meta || {};
  const snapshot = quote.configSnapshot || {};

  const lines = [];

  /* --- night allowance ------------------------------------------- */
  const night = scaled(quote.night);
  if (M.isPositive(night)) {
    // The window is read from the FROZEN snapshot, not the live rate card: an
    // invoice reprinted after the night window moves must still describe the
    // window that was actually applied to this trip.
    const window = snapshot.nightWindow || quoteMeta.nightWindow || null;
    lines.push({
      bookingId: booking.id,
      description: window ? `Night allowance (${window})` : 'Night allowance',
      quantity: '1',
      unitPrice: night.toFixed(2),
      amount: night.toFixed(2),
    });
  }

  /* --- driver allowance (bata) ----------------------------------- */
  const bata = scaled(quote.bata);
  if (M.isPositive(bata)) {
    const days = Number(quoteMeta.days ?? 1);
    const perDay = snapshot.driverAllowance ? M.toStr(snapshot.driverAllowance) : null;
    const detail =
      days > 1 && perDay ? ` (${days} days × ₹${perDay})` : perDay ? ` (₹${perDay})` : '';

    lines.push({
      bookingId: booking.id,
      description: `Driver allowance / Bata${detail}`,
      quantity: String(days),
      unitPrice: perDay ? M.round2(M.div(bata, days)).toFixed(2) : bata.toFixed(2),
      amount: bata.toFixed(2),
    });
  }

  /* --- extra distance -------------------------------------------- */
  const extra = booking.meta && booking.meta.extraDistance;
  const extraCharge = extra ? scaled(extra.extraCharge) : M.dec(0);
  if (extra && M.isPositive(extraCharge)) {
    const extraKm = M.toStr(extra.extraKm ?? 0);
    lines.push({
      bookingId: booking.id,
      description: `Extra distance (${extraKm} km × ₹${M.toStr(extra.perKm ?? 0)}/km)`,
      quantity: extraKm,
      unitPrice: M.toStr(extra.perKm ?? 0),
      amount: extraCharge.toFixed(2),
    });
  }

  /* --- the base line is whatever is left -------------------------- */
  const brokenOut = lines.reduce((acc, l) => M.add(acc, M.dec(l.amount)), M.dec(0));
  const baseAmount = M.round2(M.sub(taxableValue, brokenOut));

  return [
    {
      bookingId: booking.id,
      description: `Cab service — booking ${booking.bookingNumber}`,
      quantity: '1',
      unitPrice: baseAmount.toFixed(2),
      amount: baseAmount.toFixed(2),
    },
    ...lines,
  ];
}

/**
 * Writes the booking's ledger set in one go. Four entry types, one invariant:
 *
 *   FARE_CHARGED (CREDIT)  =  DRIVER_CREDIT + WELFARE_FEE + COMMISSION  (DEBIT)
 *
 * Commission is the remainder so the two sides are equal to the paisa. The
 * welfare entry is written only when the levy is non-zero (the amount>0 CHECK
 * forbids a zero row), and the identity still holds with three entries.
 *
 * Each entry's `reference` is deterministic, so a re-run collides on the unique
 * index and is skipped rather than double-posted.
 */
async function writeLedgerSet(tx, booking, fare) {
  const driverPct = M.dec(booking.driverSharePct ?? 80);
  const welfarePct = M.dec(booking.city?.welfareFeePct ?? 0);

  const driverCredit = M.round2(M.pct(fare, driverPct));
  const welfareFee = M.round2(M.pct(fare, welfarePct));
  // Commission absorbs the residual — this is what makes the set balance.
  const commission = M.sub(M.sub(fare, driverCredit), welfareFee);

  const ref = (kind) => `ledger:booking:${booking.id}:${kind}`;

  const entries = [
    {
      entryType: 'FARE_CHARGED',
      direction: 'CREDIT',
      amount: fare.toFixed(2),
      reference: ref('FARE_CHARGED'),
      note: `Fare charged for ${booking.bookingNumber}`,
    },
    {
      entryType: 'DRIVER_CREDIT',
      direction: 'DEBIT',
      amount: driverCredit.toFixed(2),
      reference: ref('DRIVER_CREDIT'),
      note: `Driver earnings (${driverPct.toFixed(2)}%)`,
    },
    {
      entryType: 'COMMISSION',
      direction: 'DEBIT',
      amount: commission.toFixed(2),
      reference: ref('COMMISSION'),
      note: 'Platform commission',
    },
  ];

  if (M.isPositive(welfareFee)) {
    entries.push({
      entryType: 'WELFARE_FEE',
      direction: 'DEBIT',
      amount: welfareFee.toFixed(2),
      reference: ref('WELFARE_FEE'),
      note: `State welfare levy (${welfarePct.toFixed(2)}%)`,
    });
  }

  const written = [];
  for (const e of entries) {
    // chk_ledger_amount_positive forbids a non-positive amount. Commission can
    // in theory be zero if the driver takes 100% and there is no levy; skip it
    // rather than violate the constraint. The identity still holds (0 term).
    if (!M.isPositive(M.dec(e.amount))) continue;

    try {
      const row = await tx.ledgerEntry.create({
        data: {
          bookingId: booking.id,
          userId: booking.customer?.userId || null,
          entryType: e.entryType,
          direction: e.direction,
          amount: e.amount,
          currency: 'INR',
          reference: e.reference,
          note: e.note,
          meta: { bookingNumber: booking.bookingNumber },
        },
      });
      written.push(row);
    } catch (err) {
      // Already posted (a re-run). The ledger is append-only and the reference
      // is unique, so a collision means the entry exists — leave it be.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  return written;
}

/* ------------------------------------------------------------------ *
 * Balance — derived from the ledger, checked against the snapshot
 * ------------------------------------------------------------------ */

/**
 * Derives a booking's financial position by SUMMING its ledger entries, which
 * is the authoritative source. The booking row's advance_paid / balance_due are
 * a fast SNAPSHOT for the common read path; this is the slow, correct number to
 * reconcile them against.
 *
 * Returns the four totals and whether the fundamental identity holds:
 *   fareCharged == driverCredit + commission + welfare
 */
async function deriveBookingBalance(bookingId) {
  const rows = await prisma.ledgerEntry.groupBy({
    by: ['entryType'],
    where: { bookingId },
    _sum: { amount: true },
  });

  const by = (t) => {
    const r = rows.find((x) => x.entryType === t);
    return r?._sum.amount ? M.round2(r._sum.amount) : M.dec(0);
  };

  const fareCharged = by('FARE_CHARGED');
  const driverCredit = by('DRIVER_CREDIT');
  const commission = by('COMMISSION');
  const welfare = by('WELFARE_FEE');
  const distributed = M.add(M.add(driverCredit, commission), welfare);

  return {
    bookingId,
    fareCharged: fareCharged.toFixed(2),
    driverCredit: driverCredit.toFixed(2),
    commission: commission.toFixed(2),
    welfareFee: welfare.toFixed(2),
    distributed: distributed.toFixed(2),
    balanced: M.dec(fareCharged).equals(distributed),
  };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

async function getInvoice(id) {
  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { lines: true } });
  if (!invoice) throw ApiError.notFound('Invoice not found');
  return invoice;
}

async function getInvoiceForBooking(bookingId) {
  const line = await prisma.invoiceLine.findFirst({
    where: { bookingId },
    select: { invoiceId: true },
  });
  if (!line) throw ApiError.notFound('No invoice for this booking yet');
  return getInvoice(line.invoiceId);
}

async function listLedgerForBooking(bookingId) {
  return prisma.ledgerEntry.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
  });
}

module.exports = {
  finaliseBooking,
  deriveBookingBalance,
  getInvoice,
  getInvoiceForBooking,
  listLedgerForBooking,
  // exported for tests
  financialYear,
  splitGstInclusive,
  buildInvoiceLines,
};