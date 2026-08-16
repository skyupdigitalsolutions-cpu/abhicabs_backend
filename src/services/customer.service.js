'use strict';

/**
 * src/services/customer.service.js
 *
 * Customer profiles. The Customer row is a 1:1 extension of a User with
 * role USER — it holds everything specific to someone who books trips.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 * accountType (RETAIL / CORPORATE) determines whether a GST Tax Invoice or a
 * Non-Tax Invoice is issued. It is therefore:
 *
 *   - settable ONLY by a staff member holding CUSTOMER_MANAGE
 *   - written inside a transaction WITH its audit entry
 *   - absent from every self-service schema
 *
 * A customer who could flip their own account to CORPORATE would be issuing
 * themselves GST invoices for trips that were never a business expense. That
 * is a tax problem, not a UX one, and "we'll validate it in the controller" is
 * not a control — the constraint has to be structural.
 */

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');
const audit = require('./audit.service');
const {
  CUSTOMER_SELECT,
  CUSTOMER_LIST_SELECT,
  SELF_EDITABLE_CUSTOMER_FIELDS,
} = require('../models/customer.model');

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

async function findById(userId) {
  const customer = await prisma.customer.findUnique({
    where: { userId },
    select: CUSTOMER_SELECT,
  });
  if (!customer) throw ApiError.notFound('Customer not found');
  return customer;
}

/**
 * Creates the Customer row on demand for a User who does not have one yet.
 *
 * OTP signup creates it, but a staff-created USER or a legacy account may not
 * have one. Rather than 404 on a real user, materialise it as RETAIL — the
 * safe default, since RETAIL means Non-Tax invoice.
 */
async function findOrCreate(userId) {
  const existing = await prisma.customer.findUnique({
    where: { userId },
    select: CUSTOMER_SELECT,
  });
  if (existing) return existing;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) throw ApiError.notFound('User not found');

  try {
    return await prisma.customer.create({
      data: { userId, accountType: 'RETAIL' },
      select: CUSTOMER_SELECT,
    });
  } catch (err) {
    // Two concurrent first-requests: one wins, the other reads the winner's row.
    if (isUniqueViolation(err)) return findById(userId);
    throw err;
  }
}

async function list({ page, limit, search, accountType, corporateAccountId, sortBy, order }) {
  const where = {};

  if (accountType) where.accountType = accountType;
  if (corporateAccountId) where.corporateAccountId = corporateAccountId;

  // Search reaches through to the User row — name, email and phone all live there.
  if (search) {
    where.user = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ],
    };
  }

  const orderBy =
    sortBy === 'name' ? { user: { name: order } } : { [sortBy || 'createdAt']: order || 'desc' };

  const [total, items] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      select: CUSTOMER_LIST_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

/* ------------------------------------------------------------------ *
 * Self-service update
 * ------------------------------------------------------------------ */

/**
 * A customer editing their own profile. Only the fields in
 * SELF_EDITABLE_CUSTOMER_FIELDS are applied — everything else is dropped.
 *
 * The zod schema already strips unknown keys; this is defence in depth, because
 * the service is callable from a script or a worker that never passed through
 * the validator.
 */
async function updateSelf(userId, data) {
  await findOrCreate(userId);

  const patch = {};
  for (const field of SELF_EDITABLE_CUSTOMER_FIELDS) {
    if (data[field] !== undefined) patch[field] = data[field];
  }

  if (Object.keys(patch).length === 0) {
    throw ApiError.badRequest('Provide at least one field to update');
  }

  return prisma.customer.update({
    where: { userId },
    data: patch,
    select: CUSTOMER_SELECT,
  });
}

/* ------------------------------------------------------------------ *
 * Admin update — the audited path
 * ------------------------------------------------------------------ */

/**
 * Staff editing a customer. May change accountType, notes, loyalty and
 * corporate linkage — each one audited.
 *
 * The whole operation runs in ONE transaction so the change and its audit
 * entry are inseparable: no committed change without a record of who made it.
 */
async function updateByAdmin(userId, data, actor, meta = {}) {
  const before = await prisma.customer.findUnique({ where: { userId } });
  if (!before) throw ApiError.notFound('Customer not found');

  // Changing accountType by hand while a corporate link exists produces a
  // contradiction: RETAIL customer attached to a company. Route those through
  // attachEmployee / detachEmployee, which keep the two fields consistent.
  if (
    data.accountType === 'RETAIL' &&
    before.corporateAccountId &&
    data.corporateAccountId === undefined
  ) {
    throw ApiError.badRequest(
      'Detach the customer from their corporate account before setting them to RETAIL',
      'CORPORATE_LINK_EXISTS'
    );
  }

  if (data.accountType === 'CORPORATE' && !before.corporateAccountId && !data.corporateAccountId) {
    throw ApiError.badRequest(
      'A CORPORATE customer must be attached to a corporate account',
      'CORPORATE_ACCOUNT_REQUIRED'
    );
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.customer.update({
      where: { userId },
      data,
      select: CUSTOMER_SELECT,
    });

    // accountType is significant enough to get its own action name, so the
    // trail is queryable for exactly the change a tax audit asks about.
    if (data.accountType && data.accountType !== before.accountType) {
      await audit.record(tx, {
        actor,
        action: audit.ACTIONS.ACCOUNT_TYPE_CHANGED,
        entityType: audit.ENTITIES.CUSTOMER,
        entityId: userId,
        before: { accountType: before.accountType },
        after: { accountType: after.accountType },
        meta,
      });
    }

    await audit.record(tx, {
      actor,
      action: audit.ACTIONS.CUSTOMER_UPDATED,
      entityType: audit.ENTITIES.CUSTOMER,
      entityId: userId,
      before,
      after,
      meta,
    });

    return after;
  });
}

/* ------------------------------------------------------------------ *
 * Billing resolution — consumed by Day 5's booking engine
 * ------------------------------------------------------------------ */

/**
 * Answers "who is billed for this customer's trip, and how".
 *
 * This is the function the Day 3 acceptance criterion turns on: an employee
 * attached to a corporate account must resolve to that company as the billing
 * entity, with a TAX invoice.
 *
 * @returns {Promise<{
 *   billTo: 'CUSTOMER'|'CORPORATE',
 *   invoiceType: 'TAX'|'NON_TAX',
 *   customerId: string,
 *   corporateAccountId: string|null,
 *   billingName: string,
 *   gstin: string|null,
 *   billingCycle: string,
 *   creditAvailable: string|null
 * }>}
 */
async function resolveBillingEntity(customerId) {
  const customer = await prisma.customer.findUnique({
    where: { userId: customerId },
    select: {
      userId: true,
      accountType: true,
      gstin: true,
      user: { select: { name: true, email: true, phone: true } },
      corporate: {
        select: {
          id: true,
          companyName: true,
          gstin: true,
          billingEmail: true,
          billingAddress: true,
          billingCity: true,
          billingState: true,
          billingPincode: true,
          billingCycle: true,
          creditLimit: true,
          creditUsed: true,
          isActive: true,
        },
      },
    },
  });

  if (!customer) throw ApiError.notFound('Customer not found');

  const corp = customer.corporate;

  // A deactivated corporate account must not silently keep billing. Falling
  // back to the individual is the safe behaviour: the trip is still billable,
  // just not to a company that may be in arrears.
  if (customer.accountType === 'CORPORATE' && corp && corp.isActive) {
    return {
      billTo: 'CORPORATE',
      invoiceType: 'TAX',
      customerId: customer.userId,
      corporateAccountId: corp.id,
      billingName: corp.companyName,
      gstin: corp.gstin,
      billingAddress: {
        address: corp.billingAddress,
        city: corp.billingCity,
        state: corp.billingState,
        pincode: corp.billingPincode,
        email: corp.billingEmail,
      },
      billingCycle: corp.billingCycle,
      creditAvailable: corp.creditLimit.minus(corp.creditUsed).toString(),
    };
  }

  return {
    billTo: 'CUSTOMER',
    invoiceType: 'NON_TAX',
    customerId: customer.userId,
    corporateAccountId: null,
    billingName: customer.user.name,
    gstin: customer.gstin || null,
    billingAddress: null,
    billingCycle: 'PER_TRIP',
    creditAvailable: null,
    ...(corp && !corp.isActive
      ? { note: 'Corporate account is inactive — billed to the individual' }
      : {}),
  };
}

async function stats() {
  const [total, retail, corporate, withCorporate] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where: { accountType: 'RETAIL' } }),
    prisma.customer.count({ where: { accountType: 'CORPORATE' } }),
    prisma.customer.count({ where: { corporateAccountId: { not: null } } }),
  ]);
  return { total, retail, corporate, linkedToCorporate: withCorporate };
}

module.exports = {
  findById,
  findOrCreate,
  list,
  updateSelf,
  updateByAdmin,
  resolveBillingEntity,
  stats,
};