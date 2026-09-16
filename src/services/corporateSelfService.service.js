'use strict';

/**
 * src/services/corporateSelfService.service.js
 *
 * Lets a signed-in customer register their own company account, instead of an
 * admin having to create every one by hand.
 *
 * ---------------------------------------------------------------------------
 * WHY REGISTRATION DOES NOT IMMEDIATELY MAKE SOMEONE CORPORATE
 * ---------------------------------------------------------------------------
 * A corporate account is not a preference. It changes two things that cost real
 * money:
 *
 *   1. Invoices become TAX invoices carrying the company's GSTIN, which is a
 *      filing the business makes to the tax authority.
 *   2. Billing moves to the company, on credit, settled on a cycle — the trip
 *      happens before the money does.
 *
 * Worse, `assertCreditAvailable` treats a creditLimit of 0 as UNLIMITED rather
 * than as blocked. So a customer who could flip their own account to CORPORATE
 * would be granting themselves uncapped post-paid credit and issuing tax
 * invoices against a GSTIN nobody checked. That is not a feature with a bug in
 * it; it is a way to take free rides.
 *
 * So registration creates the company and links it, but leaves
 * `customer.accountType` as RETAIL and the account inactive. Billing keeps
 * routing to the individual — resolveBillingEntity requires accountType ===
 * 'CORPORATE' AND corporate.isActive, and neither is true yet — so the rider
 * can carry on booking normally while the application is reviewed.
 *
 * An admin then activates the account and sets a credit limit, which is the
 * moment corporate billing actually begins. The customer-facing word for this
 * is "pending review", and the app shows it as such.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const corporateService = require('./corporate.service');
const customerService = require('./customer.service');
const audit = require('./audit.service');

/**
 * What a customer may see about their own application.
 *
 * creditLimit and creditUsed are deliberately absent. They are commercial terms
 * set by the business, and showing a limit the customer did not agree to invites
 * an argument about a number they cannot change.
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
 * Describes where the customer's application has got to.
 *
 * Three states rather than a boolean, because "no application", "waiting" and
 * "live" need three different screens and three different next actions.
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
 * The customer's own account type and corporate application, if any.
 *
 * Always returns a shape rather than 404ing on "no application" — the app needs
 * to render the "switch to corporate" choice, and an error is the wrong way to
 * say "nothing here yet".
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
 * Register
 * ------------------------------------------------------------------ */

/**
 * Register a company for the signed-in customer.
 *
 * The GSTIN is unique across corporate accounts, which is what stops two
 * employees of the same company each creating their own and splitting one
 * credit limit in half without anyone noticing. When the GSTIN already exists
 * the customer is told to ask their administrator rather than being handed the
 * existing account — joining a company is a decision that company makes, not
 * one a stranger with the right 15 characters makes.
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
      'A corporate application is already under review for this account.',
      'APPLICATION_PENDING'
    );
  }

  const gstin = String(input.gstin || '').trim().toUpperCase();

  // The state encoded in a GSTIN must match the billing state, or every invoice
  // raised against it will apply the wrong tax split. Reused from the admin
  // path so both doors enforce the same rule.
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

        // Set by an admin at approval, never by the applicant. Note that 0 means
        // UNLIMITED to assertCreditAvailable — which is exactly why this account
        // stays inactive until a human has looked at it.
        creditLimit: 0,
        creditUsed: 0,

        // The whole safety of self-registration rests on this line.
        isActive: false,
      },
      select: SELF_CORPORATE_SELECT,
    });

    // Linked, but NOT switched: accountType stays RETAIL, so billing keeps
    // routing to the individual and the rider can book normally meanwhile.
    await tx.customer.update({
      where: { userId },
      data: { corporateAccountId: corporate.id },
    });

    return corporate;
  });

  await audit.record(prisma, {
    actor: { id: userId },
    action: 'CORPORATE_SELF_REGISTERED',
    entityType: 'CorporateAccount',
    entityId: created.id,
    after: { companyName: created.companyName, gstin: created.gstin, isActive: false },
    meta,
  });

  return {
    accountType: 'RETAIL',
    corporateStatus: 'PENDING',
    corporate: created,
    message:
      'Company registered. Trips stay billed to you personally until our team ' +
      'verifies the details — usually within one working day.',
  };
}

/* ------------------------------------------------------------------ *
 * Update while pending
 * ------------------------------------------------------------------ */

/**
 * Correct a typo in an application that has not been approved yet.
 *
 * Locked once the account is live: at that point the details are on issued tax
 * invoices, and changing the billing name or GSTIN under them would leave
 * documents that no longer match the entity they were raised against. After
 * approval this is an admin action with an audit trail.
 */
async function updateMyCorporate(userId, input, meta = {}) {
  const customer = await customerService.findOrCreate(userId);

  if (!customer.corporateAccountId) {
    throw ApiError.notFound('No corporate application found for this account');
  }
  if (customer.accountType === 'CORPORATE') {
    throw ApiError.badRequest(
      'This company is already active. Contact support to change its billing details.',
      'CORPORATE_ACTIVE'
    );
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

  return { accountType: customer.accountType, corporateStatus: 'PENDING', corporate: updated };
}

/* ------------------------------------------------------------------ *
 * Withdraw
 * ------------------------------------------------------------------ */

/**
 * Cancel a pending application and go back to a plain retail account.
 *
 * The corporate row is deactivated rather than deleted. It may already carry an
 * audit trail, and a GSTIN that was registered once is worth keeping a record
 * of — if the same company applies again, support can see what happened before.
 */
async function withdrawApplication(userId, meta = {}) {
  const customer = await customerService.findOrCreate(userId);

  if (!customer.corporateAccountId) {
    throw ApiError.notFound('No corporate application found for this account');
  }
  if (customer.accountType === 'CORPORATE') {
    throw ApiError.badRequest(
      'This company is active. Contact support to close it.',
      'CORPORATE_ACTIVE'
    );
  }

  const corporateAccountId = customer.corporateAccountId;

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
    action: 'CORPORATE_APPLICATION_WITHDRAWN',
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