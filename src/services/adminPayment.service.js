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
  failureReason: true,
  paidAt: true,
  createdAt: true,
  booking: {
    select: {
      bookingNumber: true,
      status: true,
      customer: { select: { userId: true, user: { select: { name: true, phone: true } } } },
    },
  },
};

async function list({ page, limit, status, method, from, to, bookingId, sortBy, order }) {
  const where = {};

  if (status) where.status = status;
  if (method) where.method = method;
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

module.exports = { list };