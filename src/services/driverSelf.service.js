'use strict';

/**
 * src/services/driverSelf.service.js
 *
 * Driver SELF-service: sign up, complete a profile, upload documents, register
 * a vehicle, submit for review.
 *
 * RECONCILED WITH THE ACTUAL DB SCHEMA. The previous version referenced a
 * `vehicleClaim` table and Vehicle columns (ownerDriverId, verificationStatus,
 * verifiedAt, rejectionReason) and Driver columns (submittedAt, rejectionReason)
 * that were never migrated — every vehicle/onboarding call 500'd. The real
 * schema models driver↔vehicle ownership with drivers.assignedVehicleId and has
 * no claim/verification tables, so this file now uses only columns that exist:
 *
 *   - ownership            drivers.assignedVehicleId -> vehicles.id
 *   - "pending" vehicle    vehicles.status = INACTIVE + isActive = false
 *   - "approved" vehicle   an admin sets isActive = true / status = AVAILABLE
 *   - submission marker    stored in drivers.documents.__meta (no column exists)
 *
 * A driver still becomes dispatchable only when an admin sets kycStatus=VERIFIED
 * AND activates the vehicle. Nothing here grants that. role is hard-coded DRIVER
 * on create and kycStatus is never writable to VERIFIED through this file.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { prisma, isUniqueViolation, violatedFields } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');
const tokens = require('../utils/tokens');
const storageService = require('./storage.service');
const {
  REQUIRED_DRIVER_DOCS,
  REQUIRED_VEHICLE_DOCS,
} = require('../validators/driverSelf.schemas');
const { isStaffRole } = require('../lib/accountRoles');

const BCRYPT_ROUNDS = 12;

/* kycStatus values from which the driver may still edit their own details. */
const EDITABLE_KYC = ['PENDING', 'REJECTED'];

const DRIVER_SELF_SELECT = {
  userId: true,
  licenceNumber: true,
  licenceExpiry: true,
  aadhaarLast4: true,
  kycStatus: true,
  kycVerifiedAt: true,
  documents: true,
  assignedVehicleId: true,
  ratingAvg: true,
  ratingCount: true,
  isOnline: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true, phone: true, isActive: true } },
};

const VEHICLE_SELF_SELECT = {
  id: true,
  registrationNumber: true,
  vehicleClass: true,
  makeModel: true,
  year: true,
  colour: true,
  seatingCapacity: true,
  status: true,
  isActive: true,
  insuranceExpiry: true,
  fitnessExpiry: true,
  permitExpiry: true,
  pucExpiry: true,
  documents: true,
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Placeholder email keeps users.email UNIQUE satisfiable for phone-first signup. */
const placeholderEmail = (phone) => `phone_${phone}@placeholder.local`;

/** Generated, undeliverable addresses — safe to replace with a real one. */
const isPlaceholderEmail = (email) =>
  /@(placeholder\.local|whatsapp\.invalid|temp-driver\.invalid)$/i.test(String(email || ''));

/** Which of `required` are missing from a documents JSON blob. */
function missingDocs(documents, required) {
  const docs = documents && typeof documents === 'object' ? documents : {};
  return required.filter((k) => !docs[k] || !docs[k].url);
}

/** Read our private submission metadata off the driver.documents JSON blob. */
function readMeta(documents) {
  const docs = documents && typeof documents === 'object' ? documents : {};
  return docs.__meta && typeof docs.__meta === 'object' ? docs.__meta : {};
}

/** Turn unique-index violations into clean 409s. */
function claimConflict(err) {
  const text = `${err?.message || ''} ${violatedFields(err).join(',')}`;
  if (text.includes('registration_number')) {
    return ApiError.conflict(
      'A vehicle with that registration number is already on the platform.',
      'VEHICLE_EXISTS',
    );
  }
  if (text.includes('licence')) {
    return ApiError.conflict('That licence number is already registered', 'LICENCE_TAKEN');
  }
  if (text.includes('email')) {
    return ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');
  }
  return ApiError.conflict('That request conflicts with an existing record', 'DRIVER_SELF_CONFLICT');
}

/** Loads the caller's driver row or 404s. */
async function requireDriver(userId) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: DRIVER_SELF_SELECT,
  });
  if (!driver) throw ApiError.notFound('Driver profile not found', 'DRIVER_NOT_FOUND');
  return driver;
}

/* ------------------------------------------------------------------ *
 * Register
 * ------------------------------------------------------------------ */

/**
 * Find the account that owns a mobile number, comparing the LAST TEN DIGITS of
 * what is stored rather than the exact string.
 *
 * Same reasoning as authOtp.findAccountByPhone: older rows stored numbers as
 * typed, so "+91 98765 43210" and "9876543210" are one person and an exact
 * match would miss. Missing the match here is the dangerous direction — it
 * would create a SECOND account for someone who already has one, and then
 * neither can sign in by SMS.
 */
async function findUserByMobile(rawPhone) {
  const mobile = String(rawPhone || '').replace(/\D/g, '').slice(-10);
  if (mobile.length !== 10) return null;

  const rows = await prisma.$queryRaw`
    SELECT id FROM users
    WHERE phone IS NOT NULL
      AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${mobile}
    LIMIT 2
  `;

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw ApiError.conflict(
      'This mobile number is linked to more than one account. Please contact support.',
      'PHONE_AMBIGUOUS',
    );
  }

  return prisma.user.findUnique({
    where: { id: rows[0].id },
    select: { id: true, role: true, driver: { select: { userId: true } } },
  });
}

/**
 * PUBLIC driver signup — for a number with no account at all.
 *
 * ---------------------------------------------------------------------------
 * WHY AN EXISTING NUMBER IS REFUSED RATHER THAN UPGRADED
 * ---------------------------------------------------------------------------
 * One person CAN now be both a rider and a driver — but not through this
 * endpoint, which is unauthenticated and hands back a token pair on success.
 * Attaching a driver profile to an existing account here would mean anyone who
 * knows a rider's mobile number could type it in and be logged into that
 * person's account. That is not a signup, it is account takeover.
 *
 * So an existing number is told to sign in, and the upgrade happens on
 * applyForUser() below, behind a verified session. The error code is what the
 * app keys off to route them to the OTP screen instead of showing a dead end.
 */
async function register({ name, phone, email, licenceNumber, licenceExpiry = null }, meta = {}) {
  const existing = await findUserByMobile(phone);

  if (existing) {
    if (existing.driver) {
      throw ApiError.conflict(
        'A driver account already exists for this number. Please sign in instead.',
        'DRIVER_EXISTS',
      );
    }
    throw ApiError.conflict(
      'An account already exists for this number. Sign in, then apply to drive from your profile.',
      'ACCOUNT_EXISTS',
    );
  }

  // Passwordless: drivers authenticate by OTP. Random hash keeps the NOT NULL
  // column satisfied while making password login impossible by construction.
  const hash = await bcrypt.hash(crypto.randomUUID(), BCRYPT_ROUNDS);

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: email || placeholderEmail(phone),
          phone,
          password: hash,
          role: 'DRIVER', // hard-coded — never from input
        },
        select: { id: true, name: true, email: true, phone: true, role: true },
      });

      await tx.driver.create({
        data: {
          userId: user.id,
          licenceNumber,
          licenceExpiry,
          // kycStatus omitted on purpose -> schema default PENDING.
        },
      });

      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw claimConflict(err);
    throw err;
  }

  const accessToken = tokens.signAccessToken({ userId: created.id, role: created.role });
  const refreshToken = tokens.signRefreshToken({ userId: created.id });

  await prisma.refreshToken.create({
    data: {
      userId: created.id,
      tokenHash: tokens.hashToken(refreshToken),
      expiresAt: tokens.refreshExpiryDate(),
      userAgent: (meta.userAgent || '').slice(0, 255) || null,
      ip: (meta.ip || '').slice(0, 45) || null,
    },
  });

  const driver = await requireDriver(created.id);
  return { driver, onboarding: await onboardingState(created.id), accessToken, refreshToken };
}

/* ------------------------------------------------------------------ *
 * Apply to drive  (authenticated — an existing rider adds a driver profile)
 * ------------------------------------------------------------------ */

/**
 * Adds a drivers row to an account that already exists, so one person can ride
 * and drive on the same login, the same number and the same trip history.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not touch users.role. The rider stays role USER and gains a driver
 * PROFILE; requireDriverProfile reads the profile, not the role (see
 * src/lib/accountRoles.js). Flipping the role would re-introduce exactly the
 * either/or this change exists to remove, and would quietly re-scope every
 * rider-facing query the moment someone applied.
 *
 * It does not touch kycStatus either — the schema default PENDING stands.
 * Applying is applying. An admin verifying the licence and activating the
 * vehicle is still the only path to being dispatchable, and allocation.service
 * will refuse to put this person on their own booking regardless.
 *
 * No tokens are issued: the caller already has a live session, which is the
 * whole point of doing this here rather than on the public endpoint.
 */
async function applyForUser(userId, { licenceNumber, licenceExpiry = null, name, email } = {}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, name: true, email: true },
  });
  if (!user) throw ApiError.notFound('Account not found', 'USER_NOT_FOUND');

  // Belt and braces — the route already runs requireSelfServiceAccount. A
  // dispatcher who could also be dispatched is not a role combination anyone
  // designed for.
  if (isStaffRole(user.role)) {
    throw ApiError.forbidden(
      'Staff accounts cannot hold a driver profile',
      'STAFF_ACCOUNT',
    );
  }

  const existing = await prisma.driver.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (existing) {
    throw ApiError.conflict(
      'You already have a driver profile on this account.',
      'DRIVER_PROFILE_EXISTS',
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Only fill gaps. A rider who already gave us a real name and address
      // should not have them overwritten by whatever the driver form collected.
      const patch = {};
      if (name && !user.name) patch.name = name;
      if (email && isPlaceholderEmail(user.email)) patch.email = email;
      if (Object.keys(patch).length > 0) {
        await tx.user.update({ where: { id: userId }, data: patch });
      }

      await tx.driver.create({
        data: {
          userId,
          licenceNumber,
          licenceExpiry,
          // kycStatus omitted on purpose -> schema default PENDING.
        },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw claimConflict(err);
    throw err;
  }

  const driver = await requireDriver(userId);
  return { driver, onboarding: await onboardingState(userId) };
}

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

async function getMe(userId) {
  const driver = await requireDriver(userId);
  return { driver, onboarding: await onboardingState(userId) };
}

async function updateMe(userId, data) {
  const driver = await requireDriver(userId);

  const { name, email, ...driverFields } = data;
  const touchesIdentity =
    'licenceNumber' in driverFields ||
    'licenceExpiry' in driverFields ||
    'aadhaarLast4' in driverFields;

  if (touchesIdentity && !EDITABLE_KYC.includes(driver.kycStatus)) {
    throw ApiError.conflict(
      'Verified licence details can only be changed by support',
      'KYC_LOCKED',
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (name || email) {
        await tx.user.update({
          where: { id: userId },
          data: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
        });
      }
      if (Object.keys(driverFields).length > 0) {
        await tx.driver.update({ where: { userId }, data: driverFields });
      }
      return tx.driver.findUnique({ where: { userId }, select: DRIVER_SELF_SELECT });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw claimConflict(err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

async function saveDriverDocument(userId, docType, file) {
  const driver = await requireDriver(userId);

  if (!EDITABLE_KYC.includes(driver.kycStatus)) {
    throw ApiError.conflict(
      'Your documents are already verified. Contact support to replace one.',
      'KYC_LOCKED',
    );
  }
  if (!file || !file.buffer) {
    throw ApiError.badRequest('No file was uploaded', 'FILE_REQUIRED');
  }

  const uploaded = await storageService.uploadImage(file.buffer, {
    folder: `drivers/${userId}`,
    mimetype: file.mimetype,
  });

  const documents = { ...(driver.documents || {}) };
  const previous = documents[docType];

  documents[docType] = {
    url: uploaded.url,
    publicId: uploaded.publicId,
    uploadedAt: new Date().toISOString(),
  };

  const updated = await prisma.driver.update({
    where: { userId },
    data: { documents },
    select: DRIVER_SELF_SELECT,
  });

  if (previous?.publicId) {
    storageService
      .destroy(previous.publicId)
      .catch((e) => console.warn('[driverSelf] could not remove old document:', e.message));
  }

  return { driver: updated, onboarding: await onboardingState(userId) };
}

/** Uploads vehicle paperwork (RC / INSURANCE / PUC / FITNESS / PERMIT). */
async function saveVehicleDocument(userId, vehicleId, docType, file, expiry = null) {
  const vehicle = await requireOwnedVehicle(userId, vehicleId);

  // Once an admin has activated the vehicle, its paperwork is locked.
  if (vehicle.isActive) {
    throw ApiError.conflict(
      'This vehicle is already approved. Contact support to replace a document.',
      'VEHICLE_LOCKED',
    );
  }
  if (!file || !file.buffer) {
    throw ApiError.badRequest('No file was uploaded', 'FILE_REQUIRED');
  }

  const uploaded = await storageService.uploadImage(file.buffer, {
    folder: `vehicles/${vehicleId}`,
    mimetype: file.mimetype,
  });

  const documents = { ...(vehicle.documents || {}) };
  const previous = documents[docType];

  documents[docType] = {
    url: uploaded.url,
    publicId: uploaded.publicId,
    uploadedAt: new Date().toISOString(),
  };

  const EXPIRY_COLUMN = {
    INSURANCE: 'insuranceExpiry',
    PUC: 'pucExpiry',
    FITNESS: 'fitnessExpiry',
    PERMIT: 'permitExpiry',
  };
  const expiryPatch = expiry && EXPIRY_COLUMN[docType] ? { [EXPIRY_COLUMN[docType]]: expiry } : {};

  const updated = await prisma.vehicle.update({
    where: { id: vehicleId },
    data: { documents, ...expiryPatch },
    select: VEHICLE_SELF_SELECT,
  });

  if (previous?.publicId) {
    storageService
      .destroy(previous.publicId)
      .catch((e) => console.warn('[driverSelf] could not remove old document:', e.message));
  }

  return { vehicle: updated, onboarding: await onboardingState(userId) };
}

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

/** The vehicle must be the one linked to the caller (drivers.assignedVehicleId). */
async function requireOwnedVehicle(userId, vehicleId) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: { assignedVehicleId: true },
  });
  if (!driver) throw ApiError.notFound('Driver profile not found', 'DRIVER_NOT_FOUND');
  if (driver.assignedVehicleId !== vehicleId) {
    throw ApiError.forbidden('This vehicle is not yours', 'VEHICLE_NOT_YOURS');
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: VEHICLE_SELF_SELECT,
  });
  if (!vehicle) throw ApiError.notFound('Vehicle not found');
  return vehicle;
}

/**
 * Registers a vehicle the driver owns. Creates the Vehicle INACTIVE (kept out of
 * every dispatch/fleet query) and links it to the driver via assignedVehicleId.
 * An admin activating it (isActive=true / status=AVAILABLE) is what makes it
 * usable — a driver cannot self-certify a car.
 */
async function registerOwnVehicle(userId, data) {
  await requireDriver(userId);

  const existing = await prisma.vehicle.findUnique({
    where: { registrationNumber: data.registrationNumber },
    select: { id: true },
  });
  if (existing) {
    throw ApiError.conflict(
      'That vehicle is already on the platform.',
      'VEHICLE_EXISTS',
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.create({
        data: {
          ...data,
          status: 'INACTIVE', // not dispatchable until an admin approves it
          isActive: false,
        },
        select: VEHICLE_SELF_SELECT,
      });

      await tx.driver.update({
        where: { userId },
        data: { assignedVehicleId: vehicle.id },
      });

      return { vehicle };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw claimConflict(err);
    throw err;
  }
}

/**
 * Fleet-vehicle claims are not part of this deployment's schema (no claim
 * table). Drivers register their own vehicle via registerOwnVehicle instead.
 */
async function claimFleetVehicle() {
  throw ApiError.badRequest(
    'Vehicle claiming is not available. Please register your vehicle instead.',
    'CLAIMS_DISABLED',
  );
}

async function withdrawClaim() {
  throw ApiError.badRequest('Vehicle claiming is not available.', 'CLAIMS_DISABLED');
}

/** The driver's own vehicle (0 or 1), shaped like the app expects. */
async function listMyVehicles(userId, { page = 1, limit = 20 } = {}) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: { assignedVehicle: { select: VEHICLE_SELF_SELECT } },
  });

  const vehicle = driver?.assignedVehicle || null;
  const items = vehicle
    ? [{
        claimId: null,
        isOwner: true,
        status: vehicle.isActive ? 'APPROVED' : 'PENDING',
        vehicle,
      }]
    : [];

  return paginated(items, { page, limit, total: items.length });
}

/* ------------------------------------------------------------------ *
 * Onboarding state + submit for review
 * ------------------------------------------------------------------ */

async function onboardingState(userId) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: {
      kycStatus: true,
      documents: true,
      assignedVehicleId: true,
      assignedVehicle: { select: VEHICLE_SELF_SELECT },
    },
  });
  if (!driver) throw ApiError.notFound('Driver profile not found', 'DRIVER_NOT_FOUND');

  const meta = readMeta(driver.documents);
  const vehicle = driver.assignedVehicle || null;
  const hasVehicle = !!driver.assignedVehicleId && !!vehicle;

  const driverDocsMissing = missingDocs(driver.documents, REQUIRED_DRIVER_DOCS);
  const vehicleDocsMissing = hasVehicle
    ? missingDocs(vehicle.documents, REQUIRED_VEHICLE_DOCS)
    : [];

  const complete = driverDocsMissing.length === 0 && vehicleDocsMissing.length === 0 && hasVehicle;

  return {
    kycStatus: driver.kycStatus,
    submittedAt: meta.submittedAt || null,
    rejectionReason: meta.rejectionReason || null,
    hasVehicle,
    requiredDriverDocs: REQUIRED_DRIVER_DOCS,
    requiredVehicleDocs: REQUIRED_VEHICLE_DOCS,
    missingDriverDocs: driverDocsMissing,
    missingVehicleDocs: vehicleDocsMissing,
    canSubmit: complete && ['PENDING', 'REJECTED'].includes(driver.kycStatus),
    // Dispatchable only when an admin has verified the driver AND activated the
    // vehicle.
    isApproved: driver.kycStatus === 'VERIFIED' && hasVehicle && vehicle.isActive,
    vehicles: hasVehicle
      ? [{ claimId: null, isOwner: true, status: vehicle.isActive ? 'APPROVED' : 'PENDING', vehicle }]
      : [],
  };
}

async function submitForReview(userId) {
  const state = await onboardingState(userId);

  if (state.kycStatus === 'VERIFIED') {
    throw ApiError.conflict('Your account is already verified', 'ALREADY_VERIFIED');
  }
  if (state.kycStatus === 'SUSPENDED') {
    throw ApiError.forbidden('Your account is suspended. Please contact support.', 'ACCOUNT_SUSPENDED');
  }
  if (!state.hasVehicle) {
    throw ApiError.badRequest('Register a vehicle before submitting', 'VEHICLE_REQUIRED');
  }
  if (state.missingDriverDocs.length || state.missingVehicleDocs.length) {
    throw ApiError.badRequest(
      `Missing documents: ${[...state.missingDriverDocs, ...state.missingVehicleDocs].join(', ')}`,
      'DOCUMENTS_INCOMPLETE',
    );
  }

  // No submittedAt/rejectionReason columns exist — record the submission marker
  // inside the documents JSON blob under a reserved __meta key.
  const current = await prisma.driver.findUnique({
    where: { userId },
    select: { documents: true },
  });
  const documents = { ...(current?.documents || {}) };
  documents.__meta = {
    ...(documents.__meta && typeof documents.__meta === 'object' ? documents.__meta : {}),
    submittedAt: new Date().toISOString(),
    rejectionReason: null,
  };

  const driver = await prisma.driver.update({
    where: { userId },
    data: {
      kycStatus: 'PENDING', // a rejected application returns to the queue
      documents,
    },
    select: DRIVER_SELF_SELECT,
  });

  return { driver, onboarding: await onboardingState(userId) };
}

module.exports = {
  register,
  applyForUser,
  getMe,
  updateMe,
  saveDriverDocument,
  saveVehicleDocument,
  registerOwnVehicle,
  claimFleetVehicle,
  withdrawClaim,
  listMyVehicles,
  onboardingState,
  submitForReview,
};