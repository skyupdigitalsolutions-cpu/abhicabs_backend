'use strict';

/**
 * src/models/payment.model.js
 *
 * The payment status machine and shared selects. Kept beside booking.model.js
 * so both state machines live in the same layer.
 *
 * ---------------------------------------------------------------------------
 * WHY FORWARD-ONLY, AND WHY IT IS THE WHOLE POINT OF THE WEBHOOK DESIGN
 * ---------------------------------------------------------------------------
 * Gateway webhooks are AT-LEAST-ONCE and ARRIVE OUT OF ORDER. You will receive
 * `captured` before `authorized`, the same `captured` five times, and a late
 * `authorized` after you already captured. If applying an event were a blind
 * write, the fifth `captured` would re-run capture side effects and a late
 * `authorized` would move a paid order backwards.
 *
 * Making the status machine forward-only turns all of that into a no-op: an
 * event that would move the status backward, or sideways, or nowhere, changes
 * zero rows. Combined with insert-event-first dedup, replaying the same webhook
 * any number of times changes state exactly once. That is the Day 7 done-line.
 *
 *   CREATED ─▶ AUTHORISED ─▶ CAPTURED
 *      │            │            │
 *      │            └────────────┴─▶ (terminal-ish: CAPTURED)
 *      ├─▶ PARTIALLY_PAID ─▶ CAPTURED
 *      ├─▶ FAILED            (terminal)
 *      └─▶ (CAPTURED / PARTIALLY_PAID) ─▶ REFUNDED   (terminal)
 *
 * RANK encodes "how far along" a status is. An incoming status is applied only
 * if it ranks strictly higher than the current one — except REFUNDED, which is
 * a deliberate backward-from-money move handled by the refund path, not by
 * webhooks.
 */

const PAYMENT_STATUS = Object.freeze({
  CREATED: 'CREATED',
  AUTHORISED: 'AUTHORISED',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
});

/**
 * Monotonic progress rank. Higher = further along. A webhook may only advance
 * a payment to a strictly higher rank; anything else is ignored as stale or
 * duplicate. FAILED sits above CREATED (it is a resolution of a created order)
 * but below any money-in state, so a stray `failed` can never override a real
 * capture. REFUNDED is highest and is only ever reached through the refund
 * service, never a forward webhook.
 */
const STATUS_RANK = Object.freeze({
  CREATED: 0,
  FAILED: 1,
  AUTHORISED: 2,
  PARTIALLY_PAID: 3,
  CAPTURED: 4,
  REFUNDED: 5,
});

const TERMINAL = Object.freeze(['FAILED', 'REFUNDED']);

/** Maps a gateway's payment status string to our enum. */
function mapGatewayStatus(raw) {
  switch (String(raw || '').toLowerCase()) {
    case 'captured':
      return PAYMENT_STATUS.CAPTURED;
    case 'authorized':
    case 'authorised':
      return PAYMENT_STATUS.AUTHORISED;
    case 'failed':
      return PAYMENT_STATUS.FAILED;
    case 'refunded':
      return PAYMENT_STATUS.REFUNDED;
    case 'created':
      return PAYMENT_STATUS.CREATED;
    default:
      return null;
  }
}

/**
 * May the payment move from `current` to `next`?
 *
 * The single rule the whole webhook design leans on: strictly-higher rank only.
 * Equal rank (the same event again) or lower rank (an out-of-order earlier
 * event) both return false, so the apply becomes a no-op.
 */
function canAdvance(current, next) {
  if (!(current in STATUS_RANK) || !(next in STATUS_RANK)) return false;
  if (TERMINAL.includes(current)) return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}

const isTerminal = (status) => TERMINAL.includes(status);

/** Purposes a payment can serve. Aligns with the partial unique index. */
const PAYMENT_PURPOSE = Object.freeze({
  ADVANCE: 'ADVANCE',
  BALANCE: 'BALANCE',
  FULL: 'FULL',
  REFUND: 'REFUND',
});

const PAYMENT_SELECT = {
  id: true,
  bookingId: true,
  provider: true,
  providerOrderId: true,
  providerPaymentId: true,
  amount: true,
  currency: true,
  method: true,
  status: true,
  purpose: true,
  failureReason: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
};

module.exports = {
  PAYMENT_STATUS,
  STATUS_RANK,
  TERMINAL,
  PAYMENT_PURPOSE,
  PAYMENT_SELECT,
  mapGatewayStatus,
  canAdvance,
  isTerminal,
};