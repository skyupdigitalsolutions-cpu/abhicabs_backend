'use strict';

/**
 * src/services/corporate.service.js
 *
 * Corporate accounts: the billing entity for company customers. Several
 * customers (employees) point at one account, and their trips are invoiced to
 * the company rather than to them.
 *
 * Every mutation here is audited, because every one of them has a tax or
 * financial consequence: attaching an employee changes who receives a GST
 * invoice, and changing a credit limit changes how much unbilled exposure the
 * company carries.
 */

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');
const audit = require('./audit.service');
const { CORPORATE_SELECT, CORPORATE_LIST_SELECT } = require('../models/customer.model');

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

async function findById(id) {
  const account = await prisma.corporateAccount.findUnique({
    where: { id },
    select: CORPORATE_SELECT,
  });
  if (!account) throw ApiError.notFound('Corporate account not found');
  return account;
}

async function list({ page, limit, search, isActive, billingCycle, sortBy, order }) {
  const where = {};
  if (typeof isActive === 'boolean') where.isActive = isActive;
  if (billingCycle) where.billingCycle = billingCycle;
  if (search) {
    where.OR = [
      { companyName: { contains: search, mode: 'insensitive' } },
      { gstin: { contains: search.toUpperCase() } },
      { billingEmail: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, items] = await Promise.all([
    prisma.corporateAccount.count({ where }),
    prisma.corporateAccount.findMany({
      where,
      select: CORPORATE_LIST_SELECT,
      orderBy: { [sortBy || 'createdAt']: order || 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

async function listEmployees(corporateAccountId, { page = 1, limit = 50 } = {}) {
  await findById(corporateAccountId);

  const where = { corporateAccountId };
  const [total, items] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      select: {
        userId: true,
        accountType: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, phone: true, isActive: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

async function create(data, actor, meta = {}) {
  const gstin = data.gstin.toUpperCase();

  // GSTIN encodes the state in its first two digits. A mismatch against the
  // billing state produces invoices with the wrong place of supply, which is a
  // GST filing error rather than a cosmetic one.
  assertGstinMatchesState(gstin, data.billingState);

  try {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.corporateAccount.create({
        data: { ...data, gstin },
        select: CORPORATE_SELECT,
      });

      await audit.record(tx, {
        actor,
        action: audit.ACTIONS.CORPORATE_CREATED,
        entityType: audit.ENTITIES.CORPORATE_ACCOUNT,
        entityId: account.id,
        after: account,
        meta,
      });

      return account;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('A corporate account with that GSTIN already exists', 'GSTIN_TAKEN');
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

async function update(id, data, actor, meta = {}) {
  const before = await prisma.corporateAccount.findUnique({ where: { id } });
  if (!before) throw ApiError.notFound('Corporate account not found');

  const patch = { ...data };
  if (patch.gstin) {
    patch.gstin = patch.gstin.toUpperCase();
    assertGstinMatchesState(patch.gstin, patch.billingState || before.billingState);
  }

  // Lowering a credit limit below what is already consumed would put the
  // account instantly over its ceiling and block every new booking. Refuse it
  // and let finance reconcile first.
  if (patch.creditLimit !== undefined) {
    const newLimit = Number(patch.creditLimit);
    const used = Number(before.creditUsed);
    if (newLimit > 0 && newLimit < used) {
      throw ApiError.badRequest(
        `Credit limit cannot be below the amount already used (${used})`,
        'CREDIT_LIMIT_BELOW_USED'
      );
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const after = await tx.corporateAccount.update({
        where: { id },
        data: patch,
        select: CORPORATE_SELECT,
      });

      if (patch.creditLimit !== undefined && String(before.creditLimit) !== String(after.creditLimit)) {
        await audit.record(tx, {
          actor,
          action: audit.ACTIONS.CREDIT_LIMIT_CHANGED,
          entityType: audit.ENTITIES.CORPORATE_ACCOUNT,
          entityId: id,
          before: { creditLimit: before.creditLimit },
          after: { creditLimit: after.creditLimit },
          meta,
        });
      }

      await audit.record(tx, {
        actor,
        action: audit.ACTIONS.CORPORATE_UPDATED,
        entityType: audit.ENTITIES.CORPORATE_ACCOUNT,
        entityId: id,
        before,
        after,
        meta,
      });

      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('That GSTIN is already in use', 'GSTIN_TAKEN');
    }
    throw err;
  }
}

/**
 * Deactivate rather than delete.
 *
 * Corporate accounts are referenced by invoices and bookings, which carry
 * statutory retention obligations. Deleting one would either fail on a foreign
 * key or orphan financial records. Deactivation stops new corporate billing
 * while leaving history intact — resolveBillingEntity falls back to individual
 * billing for the employees.
 */
async function setActive(id, isActive, actor, meta = {}) {
  const before = await prisma.corporateAccount.findUnique({ where: { id } });
  if (!before) throw ApiError.notFound('Corporate account not found');

  return prisma.$transaction(async (tx) => {
    const after = await tx.corporateAccount.update({
      where: { id },
      data: { isActive },
      select: CORPORATE_SELECT,
    });

    await audit.record(tx, {
      actor,
      action: audit.ACTIONS.CORPORATE_DEACTIVATED,
      entityType: audit.ENTITIES.CORPORATE_ACCOUNT,
      entityId: id,
      before: { isActive: before.isActive },
      after: { isActive },
      meta,
    });

    return after;
  });
}

/* ------------------------------------------------------------------ *
 * Employees
 * ------------------------------------------------------------------ */

/**
 * Attaches a customer to a corporate account.
 *
 * accountType and corporateAccountId are set TOGETHER in one transaction. They
 * are two halves of one fact — a CORPORATE customer with no company, or a
 * RETAIL customer with one, is a contradiction that would surface later as an
 * invoice with no billing entity.
 */
async function attachEmployee(corporateAccountId, customerId, actor, meta = {}) {
  const account = await prisma.corporateAccount.findUnique({
    where: { id: corporateAccountId },
    select: { id: true, companyName: true, isActive: true },
  });
  if (!account) throw ApiError.notFound('Corporate account not found');
  if (!account.isActive) {
    throw ApiError.badRequest('Cannot attach employees to an inactive account', 'ACCOUNT_INACTIVE');
  }

  const customer = await prisma.customer.findUnique({ where: { userId: customerId } });
  if (!customer) throw ApiError.notFound('Customer not found');

  if (customer.corporateAccountId === corporateAccountId) {
    throw ApiError.conflict('Customer is already attached to this account', 'ALREADY_ATTACHED');
  }
  if (customer.corporateAccountId) {
    throw ApiError.conflict(
      'Customer is attached to another corporate account. Detach them first.',
      'ATTACHED_ELSEWHERE'
    );
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.customer.update({
      where: { userId: customerId },
      data: {
        corporateAccountId,
        accountType: 'CORPORATE',   // set together, never independently
      },
      select: {
        userId: true,
        accountType: true,
        corporateAccountId: true,
        user: { select: { id: true, name: true, email: true, phone: true } },
        corporate: { select: { id: true, companyName: true, gstin: true, billingCycle: true } },
      },
    });

    await audit.record(tx, {
      actor,
      action: audit.ACTIONS.EMPLOYEE_ATTACHED,
      entityType: audit.ENTITIES.CORPORATE_ACCOUNT,
      entityId: corporateAccountId,
      before: { customerId, accountType: customer.accountType, corporateAccountId: null },
      after: { customerId, accountType: 'CORPORATE', corporateAccountId },
      meta,
    });

    // Recorded against the customer too, so their own trail explains why their
    // invoices changed type.
    await audit.record(tx, {
      actor,
      action: audit.ACTIONS.ACCOUNT_TYPE_CHANGED,
      entityType: audit.ENTITIES.CUSTOMER,
      entityId: customerId,
      before: { accountType: customer.accountType },
      after: { accountType: 'CORPORATE', corporateAccountId },
      meta,
    });

    return after;
  });
}

/** Detaching reverts the customer to RETAIL — the safe default (Non-Tax invoice). */
async function detachEmployee(corporateAccountId, customerId, actor, meta = {}) {
  const customer = await prisma.customer.findUnique({ where: { userId: customerId } });
  if (!customer) throw ApiError.notFound('Customer not found');
  if (customer.corporateAccountId !== corporateAccountId) {
    throw ApiError.badRequest('Customer is not attached to this account', 'NOT_ATTACHED');
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.customer.update({
      where: { userId: customerId },
      data: { corporateAccountId: null, accountType: 'RETAIL' },
      select: {
        userId: true,
        accountType: true,
        corporateAccountId: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    await audit.record(tx, {
      actor,
      action: audit.ACTIONS.EMPLOYEE_DETACHED,
      entityType: audit.ENTITIES.CORPORATE_ACCOUNT,
      entityId: corporateAccountId,
      before: { customerId, accountType: 'CORPORATE', corporateAccountId },
      after: { customerId, accountType: 'RETAIL', corporateAccountId: null },
      meta,
    });

    await audit.record(tx, {
      actor,
      action: audit.ACTIONS.ACCOUNT_TYPE_CHANGED,
      entityType: audit.ENTITIES.CUSTOMER,
      entityId: customerId,
      before: { accountType: 'CORPORATE' },
      after: { accountType: 'RETAIL' },
      meta,
    });

    return after;
  });
}

/* ------------------------------------------------------------------ *
 * Credit
 * ------------------------------------------------------------------ */

/**
 * Checks headroom before a booking is confirmed. Called by Day 5.
 *
 * A creditLimit of 0 means "no limit configured" — unlimited. Treating 0 as a
 * hard zero would block every corporate booking the moment an account is
 * created without a limit.
 */
async function assertCreditAvailable(corporateAccountId, amount) {
  const account = await prisma.corporateAccount.findUnique({
    where: { id: corporateAccountId },
    select: { creditLimit: true, creditUsed: true, isActive: true, companyName: true },
  });
  if (!account) throw ApiError.notFound('Corporate account not found');
  if (!account.isActive) {
    throw ApiError.badRequest('Corporate account is inactive', 'ACCOUNT_INACTIVE');
  }

  const limit = Number(account.creditLimit);
  if (limit <= 0) return { allowed: true, unlimited: true };

  const used = Number(account.creditUsed);
  const available = limit - used;

  if (Number(amount) > available) {
    throw ApiError.badRequest(
      `Booking exceeds available credit for ${account.companyName} (available ${available})`,
      'CREDIT_LIMIT_EXCEEDED'
    );
  }
  return { allowed: true, unlimited: false, available: available - Number(amount) };
}

/**
 * Adjusts consumed credit. Uses an atomic increment, NOT read-modify-write:
 * two concurrent bookings reading the same value and both writing back would
 * lose one of the increments.
 *
 * Note this is the one mutable money counter in the schema. Treat it as a cache
 * for fast credit checks and reconcile it against the ledger on a schedule —
 * never make a refund decision from it.
 */
async function adjustCreditUsed(corporateAccountId, delta, tx = prisma) {
  return tx.corporateAccount.update({
    where: { id: corporateAccountId },
    data: { creditUsed: { increment: delta } },
    select: { id: true, creditLimit: true, creditUsed: true },
  });
}

/* ------------------------------------------------------------------ *
 * GSTIN
 * ------------------------------------------------------------------ */

/** First two digits of a GSTIN are the state code. */
const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

function stateFromGstin(gstin) {
  return GST_STATE_CODES[String(gstin).slice(0, 2)] || null;
}

/**
 * Warns rather than blocks on a mismatch.
 *
 * A company legitimately headquartered in one state may hold a GST
 * registration in another, so a hard rejection would be wrong. But a silent
 * mismatch produces invoices with the wrong place of supply, so it is logged
 * loudly for finance to check.
 */
function assertGstinMatchesState(gstin, billingState) {
  const gstState = stateFromGstin(gstin);
  if (!gstState || !billingState) return;

  const normalise = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  if (normalise(gstState) !== normalise(billingState)) {
    console.warn(
      `[corporate] GSTIN state mismatch: ${gstin.slice(0, 2)} = ${gstState}, ` +
      `billing state = ${billingState}. Place of supply on invoices may be wrong.`
    );
  }
}

async function stats() {
  const [total, active, byCycle] = await Promise.all([
    prisma.corporateAccount.count(),
    prisma.corporateAccount.count({ where: { isActive: true } }),
    prisma.corporateAccount.groupBy({ by: ['billingCycle'], _count: true }),
  ]);
  return {
    total,
    active,
    inactive: total - active,
    byBillingCycle: byCycle.reduce((a, r) => ({ ...a, [r.billingCycle]: r._count }), {}),
  };
}

module.exports = {
  findById,
  list,
  listEmployees,
  create,
  update,
  setActive,
  attachEmployee,
  detachEmployee,
  assertCreditAvailable,
  adjustCreditUsed,
  stateFromGstin,
  stats,
};