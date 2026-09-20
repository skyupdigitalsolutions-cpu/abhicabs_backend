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

async function register({ name, phone, email, licenceNumber, licenceExpiry = null }, meta = {}) {
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
