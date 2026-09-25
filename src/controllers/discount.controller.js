'use strict';

/**
 * src/controllers/discount.controller.js
 */

const { prisma } = require('../config/prisma');
const discountService = require('../services/discount.service');
const audit = require('../services/audit.service');
const { asyncHandler, ApiError } = require('../utils/helpers');

const auditMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const q = (req) => req.validatedQuery || req.query || {};

/** Decimals serialise as strings; the admin form needs numbers. */
function serialise(d) {
  return {
    id: d.id,
    code: d.code,
    description: d.description,
    type: d.type,
    value: Number(d.value),
    maxDiscount: d.maxDiscount == null ? null : Number(d.maxDiscount),
    minFare: Number(d.minFare),
    maxUses: d.maxUses,
    usedCount: d.usedCount,
    maxUsesPerCustomer: d.maxUsesPerCustomer,
    appliesTo: d.appliesTo,
    startsAt: d.startsAt,
    expiresAt: d.expiresAt,
    isActive: d.isActive,
    /** Convenience for the list: a code can be inactive for three reasons. */
    status: statusOf(d),
  };
}

function statusOf(d) {
  if (!d.isActive) return 'DISABLED';
  const now = new Date();
  if (d.startsAt > now) return 'SCHEDULED';
  if (d.expiresAt && d.expiresAt < now) return 'EXPIRED';
  if (d.maxUses != null && d.usedCount >= d.maxUses) return 'EXHAUSTED';
  return 'LIVE';
}

exports.list = asyncHandler(async (req, res) => {
  const { page, limit, includeInactive, search } = q(req);

  const where = {};
  if (!includeInactive) where.isActive = true;
  if (search) {
    where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.discount.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.discount.count({ where }),
  ]);

  const items = rows.map(serialise);
  res.json({
    success: true,
    data: {
      items,
      discounts: items,
      pagination: {
        page, limit, total,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    },
  });
});

exports.create = asyncHandler(async (req, res) => {
  const existing = await prisma.discount.findUnique({ where: { code: req.body.code } });
  if (existing) {
    throw ApiError.conflict(`Promo code ${req.body.code} already exists`, 'DISCOUNT_EXISTS');
  }

  const discount = await prisma.discount.create({
    data: { ...req.body, createdById: req.user?.id ?? null },
  });

  audit.recordAsync({
    actor: req.user,
    action: 'DISCOUNT_CREATED',
    entityType: 'discount',
    entityId: discount.id,
    after: serialise(discount),
    meta: auditMeta(req),
  });

  res.status(201).json({
    success: true,
    message: `${discount.code} created`,
    data: { discount: serialise(discount) },
  });
});

exports.update = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const before = await prisma.discount.findUnique({ where: { id } });
  if (!before) throw ApiError.notFound('Promo code not found', 'DISCOUNT_NOT_FOUND');

  const discount = await prisma.discount.update({ where: { id }, data: req.body });

  audit.recordAsync({
    actor: req.user,
    action: 'DISCOUNT_UPDATED',
    entityType: 'discount',
    entityId: id,
    before: serialise(before),
    after: serialise(discount),
    meta: auditMeta(req),
  });

  res.json({
    success: true,
    // Says what actually happens: a booking already made keeps what it got.
    message: 'Promo updated — applies to new bookings, not to ones already made',
    data: { discount: serialise(discount) },
  });
});

/**
 * Disable, never delete.
 *
 * discount_redemptions references this row with ON DELETE RESTRICT, so a used
 * code cannot be removed anyway — and should not be: a customer disputing
 * their bill needs the promo that was applied to still exist.
 */
exports.disable = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const discount = await prisma.discount.update({ where: { id }, data: { isActive: false } });

  audit.recordAsync({
    actor: req.user,
    action: 'DISCOUNT_DISABLED',
    entityType: 'discount',
    entityId: id,
    after: serialise(discount),
    meta: auditMeta(req),
  });

  res.json({ success: true, message: `${discount.code} disabled`, data: { discount: serialise(discount) } });
});

/** Who used it, and when. The answer to "did this campaign work". */
exports.redemptions = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await prisma.discountRedemption.findMany({
    where: { discountId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    success: true,
    data: {
      count: rows.length,
      redemptions: rows.map((r) => ({
        bookingId: r.bookingId,
        customerId: r.customerId,
        amount: Number(r.amount),
        usedAt: r.createdAt,
      })),
    },
  });
});

/* --------------------------- rider-facing -------------------------------- */

/**
 * Check a code against a live quote. Changes nothing.
 *
 * Separate from redeeming on purpose: a rider may see a quote five times
 * before booking once, and burning a use on every quote would exhaust a
 * 100-use campaign in an afternoon of browsing.
 */
exports.check = asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { userId: req.user.id },
    select: { corporateAccountId: true },
  });

  const result = await discountService.evaluate({
    code: req.body.code,
    customerId: req.user.id,
    fareTotal: req.body.fareTotal,
    tripType: req.body.tripType,
    isCorporate: Boolean(customer?.corporateAccountId),
  });

  // 200 either way. An inapplicable promo is a normal outcome of quoting, not
  // an error, and the app needs the reason to show it.
  res.json({ success: true, data: result });
});