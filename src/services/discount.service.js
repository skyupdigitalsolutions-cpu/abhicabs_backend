'use strict';

/**
 * src/services/discount.service.js
 *
 * Validating a promo code and working out what it takes off.
 *
 * ---------------------------------------------------------------------------
 * VALIDATION AND REDEMPTION ARE SEPARATE
 * ---------------------------------------------------------------------------
 * `evaluate()` answers "would this code apply, and for how much" and changes
 * nothing. `redeem()` records that it was used, inside the booking's own
 * transaction.
 *
 * They are split because a rider may see a quote five times before booking
 * once — and a code that burned a use on every quote would exhaust a 100-use
 * campaign in an afternoon of browsing. A quote is not a redemption.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const M = require('../lib/money');

/** Codes are compared uppercase. Nobody types a promo in the marketer's case. */
function normaliseCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

/**
 * Would this code apply to this booking, and for how much?
 *
 * Returns a REASON when it does not, never a bare false. "This code expired on
 * 12 Oct" ends the conversation; "invalid code" starts a support ticket.
 *
 * Throws nothing for an ordinary rejection — an inapplicable promo is a normal
 * outcome of quoting, not an error. It throws only when the caller asked for
 * something impossible.
 */
async function evaluate({ code, customerId, fareTotal, tripType, isCorporate }) {
  const normalised = normaliseCode(code);
  if (!normalised) return { ok: false, reason: 'Enter a promo code' };

  const discount = await prisma.discount.findUnique({ where: { code: normalised } });

  if (!discount || !discount.isActive) {
    return { ok: false, code: 'DISCOUNT_NOT_FOUND', reason: 'That promo code is not valid' };
  }

  const now = new Date();

  if (discount.startsAt > now) {
    return {
      ok: false,
      code: 'DISCOUNT_NOT_STARTED',
      reason: `This code is valid from ${discount.startsAt.toLocaleDateString('en-IN')}`,
    };
  }

  if (discount.expiresAt && discount.expiresAt < now) {
    return {
      ok: false,
      code: 'DISCOUNT_EXPIRED',
      reason: `This code expired on ${discount.expiresAt.toLocaleDateString('en-IN')}`,
    };
  }

  if (discount.maxUses != null && discount.usedCount >= discount.maxUses) {
    return { ok: false, code: 'DISCOUNT_EXHAUSTED', reason: 'This code has been fully claimed' };
  }

  const fare = M.dec(fareTotal ?? 0);
  const minFare = M.dec(discount.minFare ?? 0);
  if (M.lt(fare, minFare)) {
    return {
      ok: false,
      code: 'DISCOUNT_MIN_FARE',
      reason: `This code needs a fare of at least ₹${M.toStr(minFare)}`,
    };
  }

  /* ---- scope ---- */

  if (discount.appliesTo === 'AIRPORT' && tripType !== 'AIRPORT') {
    return { ok: false, code: 'DISCOUNT_SCOPE', reason: 'This code is for airport trips only' };
  }

  if (discount.appliesTo === 'CORPORATE' && !isCorporate) {
    return {
      ok: false,
      code: 'DISCOUNT_SCOPE',
      reason: 'This code is for corporate accounts only',
    };
  }

  if (discount.appliesTo === 'FIRST_RIDE' && customerId) {
    /*
     * Counts COMPLETED trips, not bookings.
     *
     * A rider whose first attempt was cancelled has still not ridden with us,
     * and telling them they have used their first-ride offer on a trip that
     * never happened is the kind of thing that ends a new customer.
     */
    const priorTrips = await prisma.booking.count({
      where: { customerId, status: 'COMPLETED' },
    });
    if (priorTrips > 0) {
      return {
        ok: false,
        code: 'DISCOUNT_NOT_FIRST_RIDE',
        reason: 'This code is for your first ride with us',
      };
    }
  }

  /* ---- per-customer limit ---- */

  if (customerId) {
    const used = await prisma.discountRedemption.count({
      where: { discountId: discount.id, customerId },
    });
    if (used >= discount.maxUsesPerCustomer) {
      return {
        ok: false,
        code: 'DISCOUNT_ALREADY_USED',
        reason:
          discount.maxUsesPerCustomer === 1
            ? 'You have already used this code'
            : `You have used this code ${used} times`,
      };
    }
  }

  /* ---- the amount ---- */

  let amount;
  if (discount.type === 'PERCENT') {
    amount = M.round2(M.pct(fare, discount.value));
    // The cap is what stops "20% off" becoming ₹6,000 on a ₹30,000 outstation
    // booking nobody budgeted for.
    if (discount.maxDiscount != null) {
      amount = M.min(amount, M.dec(discount.maxDiscount));
    }
  } else {
    amount = M.dec(discount.value);
  }

  /*
   * Never more than the fare.
   *
   * A ₹500 flat code on a ₹300 trip must take ₹300, not leave the company
   * owing ₹200. Everything downstream — balanceDue, the ledger, the invoice —
   * assumes a total that is zero or positive.
   */
  amount = M.min(amount, fare);
  amount = M.max(amount, M.dec(0));

  return {
    ok: true,
    discountId: discount.id,
    code: discount.code,
    description: discount.description,
    type: discount.type,
    amount: M.toStr(amount),
    // What the rider pays after it. The caller still owns the arithmetic for
    // the booking; this is for display.
    payable: M.toStr(M.sub(fare, amount)),
  };
}

/**
 * Record a redemption. Call INSIDE the booking transaction.
 *
 * The `tx` parameter is not optional in spirit: a redemption written outside
 * the booking's transaction can survive a booking that rolls back, burning a
 * use on a trip that does not exist.
 *
 * The unique index on bookingId is the real guard — one promo per booking,
 * enforced by the database rather than by remembering to check.
 */
async function redeem(tx, { discountId, bookingId, customerId, amount }) {
  await tx.discountRedemption.create({
    data: { discountId, bookingId, customerId, amount },
  });

  /*
   * An atomic increment, not a read-then-write.
   *
   * Two riders redeeming the last use of a 100-use code at the same moment
   * would both read 99 and both write 100, handing out 101. `increment` is
   * resolved by the database.
   */
  await tx.discount.update({
    where: { id: discountId },
    data: { usedCount: { increment: 1 } },
  });
}

/**
 * Give a use back when a booking is cancelled.
 *
 * Without this a rider who cancels loses the promo permanently, which they
 * experience as being punished for changing their mind.
 */
async function release(tx, bookingId) {
  const redemption = await tx.discountRedemption.findUnique({ where: { bookingId } });
  if (!redemption) return null;

  await tx.discountRedemption.delete({ where: { bookingId } });
  await tx.discount.update({
    where: { id: redemption.discountId },
    // Floored at zero: a counter that can go negative would hand out extra
    // uses after a few cancellations.
    data: { usedCount: { decrement: 1 } },
  });

  return redemption;
}

module.exports = { evaluate, redeem, release, normaliseCode };