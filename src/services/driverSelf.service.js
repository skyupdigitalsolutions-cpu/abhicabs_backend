'use strict';

/**
 * src/services/driverSelf.service.js
 *
 * Driver SELF-service: sign up, complete a profile, upload documents, register
 * or claim a vehicle, submit for review.
 *
 * The whole file rests on one rule: nothing here may make a driver dispatchable.
 * A driver becomes dispatchable only when an admin sets kycStatus = VERIFIED and
 * approves a vehicle claim, both of which live in the admin services. So:
 *
 *   - role is hard-coded DRIVER on create (never read from input)
 *   - kycStatus is never writable through this file
 *   - drivers.assignedVehicleId is never written here; approving a VehicleClaim
 *     is the only thing that sets it
 *   - a self-registered Vehicle is inserted with verificationStatus PENDING
 *
 * Every function keys off the caller's own userId. There is no :id parameter to
 * tamper with, the same guarantee customer.routes.js relies on.
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
  submittedAt: true,
  rejectionReason: true,
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
  verificationStatus: true,
  verifiedAt: true,
  rejectionReason: true,
  insuranceExpiry: true,
  fitnessExpiry: true,
  permitExpiry: true,
  pucExpiry: true,
  documents: true,
  ownerDriverId: true,
};

const CLAIM_SELECT = {
  id: true,
  vehicleId: true,
  isOwner: true,
  status: true,
  note: true,
  rejectionReason: true,
  requestedAt: true,
  decidedAt: true,
  vehicle: { select: VEHICLE_SELF_SELECT },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Placeholder email keeps users.email UNIQUE satisfiable for phone-first signup. */
const placeholderEmail = (phone) => `phone_${phone}@placeholder.local`;

/** Which of `required` are missing from a documents JSON blob. */
function missingDocs(documents, required) {
  const docs = documents && typeof documents === 'object' ? documents : {};
  return required.filter((k) => !docs[k] || !docs[k].url);
}

/**
 * Turn the partial unique indexes from the migration into clean 409s.
 * Prisma does not always populate meta.target for a partial index, so we match
 * the index name in the message too — same fallback style as isExclusionViolation.
 */
function claimConflict(err) {
  const text = `${err?.message || ''} ${violatedFields(err).join(',')}`;
  if (text.includes('uniq_pending_claim_per_driver')) {
    return ApiError.conflict(
      'You already have a vehicle request awaiting review. Withdraw it before submitting another.',
      'CLAIM_ALREADY_PENDING',
    );
  }
  if (text.includes('uniq_pending_claim_per_vehicle')) {
    return ApiError.conflict(
      'Another driver has already requested this vehicle and is awaiting review.',
      'VEHICLE_CLAIM_CONTENDED',
    );
  }
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
 * Self-signup from the driver app. Creates User(role DRIVER) + Driver(PENDING)
 * in one transaction so a duplicate licence cannot leave an orphan User behind
 * — the same transactional shape as driver.service.create.
 *
 * Tokens are issued immediately even though the account is unverified: the
 * driver needs an authenticated session to finish onboarding (upload documents,
 * register a vehicle). Being logged in is not being approved — every
 * trip-bearing path checks kycStatus separately.
 */
async function register({ name, phone, email, licenceNumber, licenceExpiry = null }, meta = {}) {
  /**
   * One phone, one identity. authOtp.verifyAndLogin resolves a login with
   * findFirst({ phone, role: in [USER, DRIVER] }, orderBy createdAt asc), so if
   * the same number held both a rider and a driver account it would always log
   * into whichever was created first — the driver could never reach their own
   * account. Refuse up front rather than create an unreachable login.
   */
  const clash = await prisma.user.findFirst({
    where: { phone, role: { in: ['USER', 'DRIVER'] } },
    select: { id: true, role: true },
  });
  if (clash) {
    throw ApiError.conflict(
      clash.role === 'DRIVER'
        ? 'A driver account already exists for this number. Please sign in instead.'
        : 'This number is already registered as a rider. Please use a different number for your driver account.',
      clash.role === 'DRIVER' ? 'DRIVER_EXISTS' : 'PHONE_TAKEN',
    );
  }

  // Passwordless: drivers authenticate by OTP. An unguessable random hash keeps
  // the NOT NULL column satisfied while making password login impossible by
  // construction (no plaintext exists anywhere).
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
 * Profile
 * ------------------------------------------------------------------ */

/**
 * The driver app's home screen payload: who am I, where am I in onboarding,
 * and what is still missing. Returning the checklist server-side keeps the
 * "can I submit yet" rule in exactly one place.
 */
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

  // Once an admin has verified the paperwork, the driver may still fix their
  // contact details but not the identity fields those checks were run against.
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

/**
 * Uploads one driver-side document (LICENCE / AADHAAR / PHOTO) and records its
 * storage reference under drivers.documents[docType].
 *
 * Only the last 4 digits of an Aadhaar are ever stored as data
 * (drivers.aadhaarLast4); this stores the scan itself, nothing more.
 */
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

  // Best-effort cleanup of the replaced file. Never fail the request over it —
  // the new document is already safely recorded.
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

  if (vehicle.verificationStatus === 'VERIFIED') {
    throw ApiError.conflict(
      'This vehicle is already verified. Contact support to replace a document.',
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

  // Keep the typed expiry columns in step with the uploaded document, so the
  // existing compliance reports keep working without reading the JSON blob.
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

/**
 * The vehicle must be one the caller owns, or one they have an open/approved
 * claim on. Prevents a driver reading or editing a fleet car by guessing a uuid.
 */
async function requireOwnedVehicle(userId, vehicleId) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: VEHICLE_SELF_SELECT,
  });
  if (!vehicle) throw ApiError.notFound('Vehicle not found');

  if (vehicle.ownerDriverId === userId) return vehicle;

  const claim = await prisma.vehicleClaim.findFirst({
    where: { driverId: userId, vehicleId, status: { in: ['PENDING', 'APPROVED'] } },
    select: { id: true },
  });
  if (!claim) throw ApiError.forbidden('This vehicle is not yours', 'VEHICLE_NOT_YOURS');

  return vehicle;
}

/**
 * Registers a vehicle the driver owns. Creates the Vehicle (PENDING, owned by
 * this driver) AND the VehicleClaim(isOwner) in one transaction, so the admin
 * has a single queue covering both driver-owned and fleet-claimed cars.
 *
 * The vehicle is inserted INACTIVE as well as PENDING: verificationStatus keeps
 * it out of the new allocation guard, and isActive=false keeps it out of every
 * pre-existing fleet query that predates this feature. Belt and braces, because
 * an unchecked car being offered a passenger is the worst failure here.
 */
async function registerOwnVehicle(userId, data) {
  const driver = await requireDriver(userId);

  const existing = await prisma.vehicle.findUnique({
    where: { registrationNumber: data.registrationNumber },
    select: { id: true, ownerDriverId: true },
  });
  if (existing) {
    throw ApiError.conflict(
      'That vehicle is already on the platform. If you drive it, submit a claim instead.',
      'VEHICLE_EXISTS',
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.create({
        data: {
          ...data,
          ownerDriverId: driver.userId,
          // Both hard-coded: a driver cannot self-certify a car.
          verificationStatus: 'PENDING',
          isActive: false,
        },
        select: VEHICLE_SELF_SELECT,
      });

      const claim = await tx.vehicleClaim.create({
        data: { driverId: userId, vehicleId: vehicle.id, isOwner: true },
        select: CLAIM_SELECT,
      });

      return { vehicle, claim };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw claimConflict(err);
    throw err;
  }
}

/**
 * Claims an existing fleet vehicle by registration number. Does not touch the
 * Vehicle row at all — it only files a request. An admin approving it is what
 * links the driver to the car.
 */
async function claimFleetVehicle(userId, { registrationNumber, note = null }) {
  await requireDriver(userId);

  const vehicle = await prisma.vehicle.findUnique({
    where: { registrationNumber },
    select: { id: true, isActive: true, ownerDriverId: true, verificationStatus: true },
  });
  if (!vehicle) {
    throw ApiError.notFound(
      'No vehicle found with that registration number. Register it instead if it is yours.',
      'VEHICLE_NOT_FOUND',
    );
  }
  if (!vehicle.isActive) {
    throw ApiError.conflict('That vehicle is not in service', 'VEHICLE_OUT_OF_SERVICE');
  }
  if (vehicle.ownerDriverId && vehicle.ownerDriverId !== userId) {
    throw ApiError.conflict(
      'That vehicle is registered to another driver',
      'VEHICLE_OWNED_BY_OTHER',
    );
  }

  try {
    return await prisma.vehicleClaim.create({
      data: { driverId: userId, vehicleId: vehicle.id, isOwner: false, note },
      select: CLAIM_SELECT,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw claimConflict(err);
    throw err;
  }
}

/** Lets a driver take back a request that has not been decided yet. */
async function withdrawClaim(userId, claimId) {
  const result = await prisma.vehicleClaim.updateMany({
    where: { id: claimId, driverId: userId, status: 'PENDING' },
    data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });
  if (result.count === 0) {
    throw ApiError.notFound('No pending request found to withdraw', 'CLAIM_NOT_PENDING');
  }
  return prisma.vehicleClaim.findUnique({ where: { id: claimId }, select: CLAIM_SELECT });
}

async function listMyVehicles(userId, { page = 1, limit = 20 } = {}) {
  const where = { driverId: userId };
  const [total, items] = await Promise.all([
    prisma.vehicleClaim.count({ where }),
    prisma.vehicleClaim.findMany({
      where,
      select: CLAIM_SELECT,
      orderBy: { requestedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return paginated(items, { page, limit, total });
}

/* ------------------------------------------------------------------ *
 * Onboarding state + submit for review
 * ------------------------------------------------------------------ */

/**
 * The single source of truth for "is this application complete". The driver app
 * renders a checklist from this and the submit endpoint enforces it, so the two
 * can never disagree.
 */
async function onboardingState(userId) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: { kycStatus: true, submittedAt: true, rejectionReason: true, documents: true },
  });
  if (!driver) throw ApiError.notFound('Driver profile not found', 'DRIVER_NOT_FOUND');

  const claims = await prisma.vehicleClaim.findMany({
    where: { driverId: userId, status: { in: ['PENDING', 'APPROVED'] } },
    select: { id: true, isOwner: true, status: true, vehicle: { select: VEHICLE_SELF_SELECT } },
  });

  const driverDocsMissing = missingDocs(driver.documents, REQUIRED_DRIVER_DOCS);

  // Vehicle paperwork is only ours to complete for a car we registered
  // ourselves. On a fleet claim the company already holds the RC and insurance.
  const owned = claims.filter((c) => c.isOwner);
  const vehicleDocsMissing = owned.length
    ? missingDocs(owned[0].vehicle.documents, REQUIRED_VEHICLE_DOCS)
    : [];

  const hasVehicle = claims.length > 0;
  const complete = driverDocsMissing.length === 0 && vehicleDocsMissing.length === 0 && hasVehicle;

  return {
    kycStatus: driver.kycStatus,
    submittedAt: driver.submittedAt,
    rejectionReason: driver.rejectionReason,
    hasVehicle,
    requiredDriverDocs: REQUIRED_DRIVER_DOCS,
    requiredVehicleDocs: REQUIRED_VEHICLE_DOCS,
    missingDriverDocs: driverDocsMissing,
    missingVehicleDocs: vehicleDocsMissing,
    canSubmit: complete && ['PENDING', 'REJECTED'].includes(driver.kycStatus),
    // Convenience for the app: a driver is only dispatchable when an admin has
    // verified them AND approved a vehicle.
    isApproved:
      driver.kycStatus === 'VERIFIED' &&
      claims.some((c) => c.status === 'APPROVED' && c.vehicle.verificationStatus === 'VERIFIED'),
    vehicles: claims.map((c) => ({ claimId: c.id, isOwner: c.isOwner, status: c.status, vehicle: c.vehicle })),
  };
}

/**
 * Hands the application to the admin queue. Sets submittedAt, which is what
 * distinguishes "awaiting a decision" from "still filling in the form".
 * Re-submitting after a rejection is allowed and clears the previous reason.
 */
async function submitForReview(userId) {
  const state = await onboardingState(userId);

  if (state.kycStatus === 'VERIFIED') {
    throw ApiError.conflict('Your account is already verified', 'ALREADY_VERIFIED');
  }
  if (state.kycStatus === 'SUSPENDED') {
    throw ApiError.forbidden('Your account is suspended. Please contact support.', 'ACCOUNT_SUSPENDED');
  }
  if (!state.hasVehicle) {
    throw ApiError.badRequest(
      'Register or claim a vehicle before submitting',
      'VEHICLE_REQUIRED',
    );
  }
  if (state.missingDriverDocs.length || state.missingVehicleDocs.length) {
    throw ApiError.badRequest(
      `Missing documents: ${[...state.missingDriverDocs, ...state.missingVehicleDocs].join(', ')}`,
      'DOCUMENTS_INCOMPLETE',
    );
  }

  const driver = await prisma.driver.update({
    where: { userId },
    data: {
      kycStatus: 'PENDING', // a rejected application returns to the queue
      submittedAt: new Date(),
      rejectionReason: null,
    },
    select: DRIVER_SELF_SELECT,
  });

  return { driver, onboarding: await onboardingState(userId) };
}

module.exports = {
  register,
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