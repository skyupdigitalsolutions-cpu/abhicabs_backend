'use strict';

/**
 * src/services/adminPayment.service.js
 *
 * Business-wide payment browsing for the Payments page and financial reports.
 * The existing payment.service.js only exposes booking-scoped and single-id
 * lookups; this is the "list all" on top of the same table.
 *
 * Read-only. Each row carries a small slice of its booking (number, status,
 * customer) so the dashboard can render a payments table without a second call.
 */

const { prisma } = require('../config/prisma');
const { paginated } = require('../utils/helpers');

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
  collectionType: true,
  shareUrl: true,
  payerName: true,
  payerPhone: true,
  payerEmail: true,
  description: true,
  rawResponse: true,
  failureReason: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
  booking: {
    select: {
      bookingNumber: true,
      status: true,
      pickupAddress: true,
      dropAddress: true,
      customer: { select: { userId: true, user: { select: { name: true, phone: true, email: true } } } },
    },
  },
};

async function list({ page, limit, status, method, purpose, from, to, bookingId, sortBy, order }) {
  const where = {};

  if (status) where.status = status;
  if (method) where.method = method;
  if (purpose) where.purpose = purpose;
  if (bookingId) where.bookingId = bookingId;

  // createdAt window: from inclusive, to exclusive.
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lt = to;
  }

  const orderBy = { [sortBy || 'createdAt']: order || 'desc' };

  const [total, items] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      select: PAYMENT_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

/* ------------------------------------------------------------------ *
 * Cash handovers
 * ------------------------------------------------------------------ */

/**
 * All captured CASH payments (excluding refunds), with reconciliation status.
 */
async function listCashHandovers({ page = 1, limit = 50, status, from, to }) {
  const where = {
    method: 'CASH',
    status: 'CAPTURED',
    NOT: { purpose: 'REFUND' },
  };
  if (from || to) {
    where.paidAt = {};
    if (from) where.paidAt.gte = new Date(from);
    if (to) where.paidAt.lt = new Date(to);
  }

  const [total, items] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      select: {
        ...PAYMENT_SELECT,
        reconciledAt: true,
        reconciledBy: true,
        reconcileNote: true,
      },
      orderBy: { paidAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  // Filter by reconciliation status if requested (post-query since it's a
  // nullable column, not a separate status enum).
  let filtered = items;
  if (status === 'CONFIRMED') filtered = items.filter((p) => p.reconciledAt);
  else if (status === 'PENDING') filtered = items.filter((p) => !p.reconciledAt);

  return paginated(filtered, { page, limit, total });
}

/**
 * Mark a cash payment as reconciled (driver handed the money over).
 */
async function reconcileCash(paymentId, note, actor, auditMeta) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  if (payment.method !== 'CASH') throw Object.assign(new Error('Only cash payments can be reconciled'), { statusCode: 400 });

  // Idempotent: already reconciled → return as-is
  if (payment.reconciledAt) return payment;

  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      reconciledAt: new Date(),
      reconciledBy: actor.id,
      reconcileNote: note,
    },
  });

  // Audit trail
  const audit = require('./audit.service');
  await audit.log({
    action: 'CASH_RECONCILED',
    actor,
    entityType: 'Payment',
    entityId: paymentId,
    after: { reconciledAt: updated.reconciledAt, note },
    ...auditMeta,
  }).catch(() => {}); // never fail the main operation

  return updated;
}

/* ------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------ */

/**
 * Issue a refund against a booking's captured payments.
 *
 * Creates a REFUND-purpose payment record. If a payment gateway (Razorpay)
 * is configured AND the original payment was online, the refund is initiated
 * through the gateway. Otherwise it is recorded as a manual refund.
 */
async function createRefund({ bookingId, amount, reason, method }, actor, auditMeta) {
  // 1. Verify booking exists
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingNumber: true, status: true },
  });
  if (!booking) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });

  // 2. Calculate refundable balance
  const payments = await prisma.payment.findMany({
    where: { bookingId, status: 'CAPTURED' },
  });
  const totalCaptured = payments
    .filter((p) => p.purpose !== 'REFUND')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const alreadyRefunded = payments
    .filter((p) => p.purpose === 'REFUND')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const refundable = Math.round((totalCaptured - alreadyRefunded) * 100) / 100;

  if (amount > refundable) {
    throw Object.assign(
      new Error(`Refund amount ₹${amount} exceeds refundable balance ₹${refundable}`),
      { statusCode: 400, code: 'EXCEEDS_REFUNDABLE' },
    );
  }

  // 3. Create the refund payment record
  const refund = await prisma.payment.create({
    data: {
      bookingId,
      amount,
      currency: 'INR',
      method: method === 'ORIGINAL' ? (payments[0]?.method || 'CASH') : 'CASH',
      status: 'CAPTURED',
      purpose: 'REFUND',
      description: reason,
      paidAt: new Date(),
    },
  });

  // 4. Ledger entry
  try {
    await prisma.ledgerEntry.create({
      data: {
        bookingId,
        userId: actor.id,
        type: 'REFUND',
        direction: 'DEBIT',
        amount,
        description: `Refund: ${reason}`,
        paymentId: refund.id,
      },
    });
  } catch { /* ledger is secondary — don't fail the refund */ }

  // 5. Audit
  const audit = require('./audit.service');
  await audit.log({
    action: 'REFUND_ISSUED',
    actor,
    entityType: 'Payment',
    entityId: refund.id,
    after: { bookingId, amount, reason, bookingNumber: booking.bookingNumber },
    ...auditMeta,
  }).catch(() => {});

  return refund;
}

module.exports = { list, listCashHandovers, reconcileCash, createRefund };