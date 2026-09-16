'use strict';

/**
 * src/services/corporateSelfService.service.js
 *
 * Lets a signed-in customer register their own company account and become a
 * corporate account IMMEDIATELY — no admin approval step.
 *
 * ---------------------------------------------------------------------------
 * INSTANT ACTIVATION (chosen behaviour)
 * ---------------------------------------------------------------------------
 * Registering a company now switches the customer to CORPORATE and activates
 * the account in the same transaction. From the next booking onward, billing
 * routes to the company: invoices become TAX invoices carrying the GSTIN, and
 * trips are billed to the company on credit, settled on a cycle.
 *
 * The starter credit limit is 0, which `assertCreditAvailable` treats as
 * UNLIMITED (corporate.service.js:366 — `if (limit <= 0) return { unlimited }`).
 * That is deliberate per product decision: a self-registered company starts
 * with uncapped post-paid credit. An admin can set a real limit later.
 *
 * SECURITY NOTE (intentional trade-off): because activation is instant and the
 * GSTIN is only format/state-checked (not verified against the tax authority),
 * this path grants uncapped credit against an unverified GSTIN. Before going to
 * production, gate this behind GSTIN verification or a non-zero starter cap.
 * The two switches for that are marked below with `PROD-GATE`.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const corporateService = require('./corporate.service');
const customerService = require('./customer.service');
const audit = require('./audit.service');

/** PROD-GATE: set true to require admin approval instead of instant activation. */
const REQUIRE_ADMIN_APPROVAL = false;

/** PROD-GATE: starter credit limit on instant activation. 0 = unlimited. */
const STARTER_CREDIT_LIMIT = 0;

/**
 * What a customer may see about their own company.
 *
 * creditLimit/creditUsed stay absent: they are commercial terms the customer
 * cannot change, and surfacing a number they did not agree to invites an
 * argument about it.
 */
const SELF_CORPORATE_SELECT = {
  id: true,
  companyName: true,
  gstin: true,
  pan: true,
  billingEmail: true,
  billingPhone: true,
  billingAddress: true,
  billingCity: true,
  billingState: true,
  billingPincode: true,
  billingCycle: true,
  isActive: true,
  createdAt: true,
};

/**
 * Where the customer's company stands.
 *
 * NONE    — no company registered
 * PENDING — registered but not yet active (only reachable if an admin later
 *           deactivates, or if REQUIRE_ADMIN_APPROVAL is turned on)
 * ACTIVE  — corporate billing is live
 */
function statusOf(customer, corporate) {
  if (!corporate) return 'NONE';
  if (customer.accountType === 'CORPORATE' && corporate.isActive) return 'ACTIVE';
  return 'PENDING';
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/**
 * The customer's own account type and company, if any.
 *
 * Always returns a shape rather than 404ing on "no company" — the app renders
 * the retail/corporate choice off this, and an error is the wrong way to say
 * "nothing here yet".
 */
async function getMyAccount(userId) {
  const customer = await customerService.findOrCreate(userId);

  const corporate = customer.corporateAccountId
    ? await prisma.corporateAccount.findUnique({
        where: { id: customer.corporateAccountId },
        select: SELF_CORPORATE_SELECT,
      })
    : null;

  return {
    accountType: customer.accountType,
    corporateStatus: statusOf(customer, corporate),
    corporate,
  };
}

/* ------------------------------------------------------------------ *
 * Register  (instant activation)
 * ------------------------------------------------------------------ */

/**
 * Register a company for the signed-in customer and switch them to corporate.
 *
 * The GSTIN is unique across corporate accounts, which stops two employees of
 * the same company each creating their own and splitting one credit line. When
 * the GSTIN already exists the customer is told to ask their administrator
 * rather than being handed the account — joining a company is that company's
 * decision, not one a stranger with the right 15 characters makes.
 */
async function registerCorporate(userId, input, meta = {}) {
  const customer = await customerService.findOrCreate(userId);

  if (customer.accountType === 'CORPORATE') {
    throw ApiError.badRequest(
      'This account is already billed to a company.',
      'ALREADY_CORPORATE'
    );
  }
  if (customer.corporateAccountId) {
    throw ApiError.badRequest(
      'A company is already registered on this account.',
      'CORPORATE_EXISTS'
    );
  }

  const gstin = String(input.gstin || '').trim().toUpperCase();

  // The state encoded in a GSTIN must match the billing state, or every invoice
  // raised against it applies the wrong tax split. Reused from the admin path
  // so both doors enforce the same rule.
  corporateService.assertGstinMatchesState(gstin, input.billingState);

  const existing = await prisma.corporateAccount.findUnique({
    where: { gstin },
    select: { id: true, companyName: true },
  });
  if (existing) {
    throw ApiError.conflict(
      `${existing.companyName} is already registered. Ask your company administrator to add you to it.`,
      'CORPORATE_ALREADY_REGISTERED'
    );
  }

  // Instant unless the prod gate is on.
  const activate = !REQUIRE_ADMIN_APPROVAL;

  const created = await prisma.$transaction(async (tx) => {
    const corporate = await tx.corporateAccount.create({
      data: {
        companyName: input.companyName.trim(),
        gstin,
        pan: input.pan ? String(input.pan).trim().toUpperCase() : null,
        billingEmail: input.billingEmail.trim().toLowerCase(),
        billingPhone: input.billingPhone || null,
        billingAddress: input.billingAddress,
        billingCity: input.billingCity,
        billingState: input.billingState,
        billingPincode: input.billingPincode,
        billingCycle: input.billingCycle || 'PER_TRIP',

        // 0 = unlimited to assertCreditAvailable (see PROD-GATE above).
        creditLimit: STARTER_CREDIT_LIMIT,
        creditUsed: 0,

        // Instant activation: the account is live the moment it is created.
        isActive: activate,
      },
      select: SELF_CORPORATE_SELECT,
    });

    // Link AND switch: the customer becomes CORPORATE now, so resolveBillingEntity
    // (which needs accountType === 'CORPORATE' AND corporate.isActive) routes the
    // next booking's billing to the company.
    await tx.customer.update({
      where: { userId },
      data: {
        corporateAccountId: corporate.id,
        accountType: activate ? 'CORPORATE' : 'RETAIL',
      },
    });

    return corporate;
  });

  await audit.record(prisma, {
    actor: { id: userId },
    action: 'CORPORATE_SELF_REGISTERED',
    entityType: 'CorporateAccount',
    entityId: created.id,
    after: {
      companyName: created.companyName,
      gstin: created.gstin,
      isActive: activate,
      activatedInstantly: activate,
    },
    meta,
  });

  return {
    accountType: activate ? 'CORPORATE' : 'RETAIL',
    corporateStatus: activate ? 'ACTIVE' : 'PENDING',
    corporate: created,
    message: activate
      ? 'Company registered. Your trips are now billed to ' + created.companyName + '.'
      : 'Company registered. Trips stay billed to you personally until our team verifies the details.',
  };
}

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

/**
 * Edit the company's billing details.
 *
 * GSTIN is never editable here (it is not in the field list) — it sits on
 * issued tax invoices. The other billing fields can be corrected even while the
 * account is active, since instant self-service means the customer owns these
 * details. Company name changes still land on future invoices, so treat with
 * care, but they are allowed.
 */
async function updateMyCorporate(userId, input, meta = {}) {
  const customer = await customerService.findOrCreate(userId);

  if (!customer.corporateAccountId) {
    throw ApiError.notFound('No company found on this account');
  }

  const patch = {};
  for (const f of [
    'companyName', 'pan', 'billingEmail', 'billingPhone',
    'billingAddress', 'billingCity', 'billingState', 'billingPincode', 'billingCycle',
  ]) {
    if (input[f] !== undefined) patch[f] = input[f];
  }

  if (Object.keys(patch).length === 0) {
    throw ApiError.badRequest('Provide at least one field to update');
  }

  // If the state moved, the GSTIN must still agree with it.
  if (patch.billingState) {
    const current = await prisma.corporateAccount.findUnique({
      where: { id: customer.corporateAccountId },
      select: { gstin: true },
    });
    corporateService.assertGstinMatchesState(current.gstin, patch.billingState);
  }

  const updated = await prisma.corporateAccount.update({
    where: { id: customer.corporateAccountId },
    data: patch,
    select: SELF_CORPORATE_SELECT,
  });

  await audit.record(prisma, {
    actor: { id: userId },
    action: 'CORPORATE_SELF_UPDATED',
    entityType: 'CorporateAccount',
    entityId: updated.id,
    after: patch,
    meta,
  });

  return {
    accountType: customer.accountType,
    corporateStatus: statusOf(customer, updated),
    corporate: updated,
  };
}

/* ------------------------------------------------------------------ *
 * Switch back to retail
 * ------------------------------------------------------------------ */

/**
 * Turn the account back into a plain retail account.
 *
 * Blocked while the company still owes money: switching to retail must not be a
 * way to walk away from an unpaid post-paid balance. creditUsed is a cache
 * reconciled against the ledger on a schedule, so this is a first-line guard,
 * not the final word — the ledger remains the source of truth.
 *
 * The corporate row is deactivated, not deleted: it may carry an audit trail
 * and a GSTIN worth keeping a record of if the company registers again.
 */
async function withdrawApplication(userId, meta = {}) {
  const customer = await customerService.findOrCreate(userId);

  if (!customer.corporateAccountId) {
    throw ApiError.notFound('No company found on this account');
  }

  const corporateAccountId = customer.corporateAccountId;

  const corporate = await prisma.corporateAccount.findUnique({
    where: { id: corporateAccountId },
    select: { creditUsed: true, companyName: true },
  });

  if (corporate && Number(corporate.creditUsed) > 0) {
    throw ApiError.badRequest(
      'This company has an unsettled balance. Clear it before switching back to a personal account.',
      'CORPORATE_BALANCE_DUE'
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { userId },
      data: { corporateAccountId: null, accountType: 'RETAIL' },
    });
    await tx.corporateAccount.update({
      where: { id: corporateAccountId },
      data: { isActive: false },
    });
  });

  await audit.record(prisma, {
    actor: { id: userId },
    action: 'CORPORATE_SWITCHED_TO_RETAIL',
    entityType: 'CorporateAccount',
    entityId: corporateAccountId,
    meta,
  });

  return { accountType: 'RETAIL', corporateStatus: 'NONE', corporate: null };
}

module.exports = {
  getMyAccount,
  registerCorporate,
  updateMyCorporate,
  withdrawApplication,
  SELF_CORPORATE_SELECT,
};