'use strict';

/**
 * src/lib/money.js
 *
 * Every rupee in this codebase passes through here.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST USE NUMBERS
 * ---------------------------------------------------------------------------
 * JavaScript numbers are IEEE-754 binary floats. They cannot represent 0.1
 * exactly, so:
 *
 *     0.1 + 0.2                    -> 0.30000000000000004
 *     1839.5 * 3                   -> 5518.499999999999
 *     (0.1 + 0.2) === 0.3          -> false
 *
 * On a single fare the error is invisible. Across a month of settlements it
 * becomes a reconciliation that never balances, and nobody can find the missing
 * paisa because it was never in one place.
 *
 * decimal.js does base-10 arithmetic, so 0.1 is exactly 0.1.
 *
 * RULE: never call Number() on a fare. Not for comparison, not for rounding,
 * not "just to log it". Convert to a string at the boundary and keep Decimal
 * everywhere inside.
 */

const Decimal = require('decimal.js');

// 20 significant digits is far more than rupee amounts need, and ROUND_HALF_UP
// matches how invoices are conventionally rounded in India.
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Coerces anything to a Decimal.
 *
 * Handles Prisma Decimal (which arrives as an object), strings, and numbers.
 * A null or undefined becomes 0 rather than NaN — a missing optional fare
 * component means "not charged", not "invalid".
 */
function dec(value) {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (value instanceof Decimal) return value;
  // Prisma Decimal and similar: stringify rather than valueOf, so we never pass
  // through a float.
  if (typeof value === 'object' && typeof value.toString === 'function') {
    return new Decimal(value.toString());
  }
  return new Decimal(value);
}

const add = (a, b) => dec(a).plus(dec(b));
const sub = (a, b) => dec(a).minus(dec(b));
const mul = (a, b) => dec(a).times(dec(b));
const div = (a, b) => {
  const d = dec(b);
  if (d.isZero()) return new Decimal(0);
  return dec(a).dividedBy(d);
};

/** Percentage OF an amount: pct(1000, 10) -> 100 */
const pct = (amount, percent) => dec(amount).times(dec(percent)).dividedBy(100);

/** Two decimal places — the storage and display format for INR. */
const round2 = (v) => dec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Whole rupees. Indian fare displays almost never show paise, and a customer
 * seeing "₹1,247.63" on a cab quote looks wrong even though it is arithmetically
 * right. Applied to the FINAL total only — never to intermediate components, or
 * the parts stop summing to the whole.
 */
const roundRupee = (v) => dec(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

const max = (a, b) => (dec(a).greaterThan(dec(b)) ? dec(a) : dec(b));
const min = (a, b) => (dec(a).lessThan(dec(b)) ? dec(a) : dec(b));

/** Clamps to a range. Used for the MVAG surge band (0.5x to 2x). */
const clamp = (v, lo, hi) => max(min(v, hi), lo);

const isZero = (v) => dec(v).isZero();
const isPositive = (v) => dec(v).greaterThan(0);
const gt = (a, b) => dec(a).greaterThan(dec(b));
const gte = (a, b) => dec(a).greaterThanOrEqualTo(dec(b));
const lt = (a, b) => dec(a).lessThan(dec(b));

/**
 * Serialises for an API response.
 *
 * ALWAYS a string, never a number. Sending 1839.50 as JSON makes it a float
 * again the moment the client parses it, reintroducing exactly the problem this
 * module exists to avoid. Strings survive the round trip intact.
 */
const toStr = (v) => round2(v).toFixed(2);

/** Sums a list of Decimals or numeric-ish values. */
const sum = (values) => values.reduce((acc, v) => acc.plus(dec(v)), new Decimal(0));

/**
 * Splits an amount by percentage without losing a paisa to rounding.
 *
 * Used for the driver share: if the fare is 1000.01 and the driver takes 80%,
 * naive rounding of both halves can produce 800.01 + 200.01 = 1000.02, creating
 * a rupee from nothing. Computing one side and subtracting guarantees the parts
 * sum exactly to the whole.
 */
function splitByPercent(total, percent) {
  const t = round2(total);
  const first = round2(pct(t, percent));
  const second = t.minus(first);
  return { first, second };
}

module.exports = {
  Decimal,
  dec,
  add, sub, mul, div, pct, sum,
  round2, roundRupee,
  max, min, clamp,
  isZero, isPositive, gt, gte, lt,
  toStr,
  splitByPercent,
};