'use strict';

/**
 * src/services/driver.service.js
 *
 * Driver roster: list / read / onboard / update / activate-deactivate.
 *
 * A driver is a User (role DRIVER) plus a Driver row. Onboarding creates both
 * in one transaction — if the Driver insert fails (e.g. a duplicate licence),
 * the User is rolled back too, so we never leave an orphan account behind.
 * The password / placeholder-email handling mirrors OTP signup: drivers
 * authenticate by OTP, so a random password keeps the NOT NULL column
 * satisfied without granting a guessable login.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');

const BCRYPT_ROUNDS = 12;

// Never selects User.password.
const DRIVER_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
};

const DRIVER_SELECT = {
  userId: true,
  licenceNumber: true,
  licenceExpiry: true,
  aadhaarLast4: true, // last 4 only — the full number is never stored
  kycStatus: true,
  ratingAvg: true,
  ratingCount: true,
  isOnline: true,
  lastPingAt: true,
  assignedVehicleId: true,
  createdAt: true,
  updatedAt: true,
  user: { select: DRIVER_USER_SELECT },
};

const VEHICLE_MINI_SELECT = {
  id: true,
  registrationNumber: true,
  vehicleClass: true,
  status: true,
};

/** Turn a Prisma P2002 into the right client-facing conflict. */
function conflictFor(err) {
  const target = err?.meta?.target;
  const fields = Array.isArray(target) ? target.join(',') : String(target || '');
  if (fields.includes('licence')) {
    return ApiError.conflict('A driver with that licence number already exists', 'LICENCE_TAKEN');
  }
  if (fields.includes('email')) {
    return ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');
  }
  return ApiError.conflict('A driver with those details already exists', 'DRIVER_CONFLICT');
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

async function list({ page, limit, search, status, kycStatus, sortBy, order }) {
  const where = {};

  if (status) where.isOnline = status === 'online';
  if (kycStatus) where.kycStatus = kycStatus;

  if (search) {
    where.OR = [
      { licenceNumber: { contains: search, mode: 'insensitive' } },
      { user: { name: { contains: search, mode: 'insensitive' } } },
      { user: { phone: { contains: search } } },
    ];
  }

  const orderBy = { [sortBy || 'createdAt']: order || 'desc' };

  const [total, items] = await Promise.all([
    prisma.driver.count({ where }),
    prisma.driver.findMany({
      where,
      select: DRIVER_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

async function findById(userId) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: {
      ...DRIVER_SELECT,
      documents: true,
      kycVerifiedAt: true,
      policeVerifiedAt: true,
      medicalCheckedAt: true,
      inductedAt: true,
      assignedVehicle: { select: VEHICLE_MINI_SELECT },
    },
  });

  if (!driver) throw ApiError.notFound('Driver not found');
  return driver;
}

/* ------------------------------------------------------------------ *
 * Onboard  (User + Driver, one transaction)
 * ------------------------------------------------------------------ */

async function create(data) {
  const {
    name,
    phone,
    email,
    password,
    licenceNumber,
    licenceExpiry = null,
    aadhaarLast4 = null,
    kycStatus,
    assignedVehicleId = null,
  } = data;

  // Random password when none is supplied — keeps the NOT NULL column filled;
  // the driver logs in by OTP.
  const plain = password || crypto.randomBytes(32).toString('base64');
  const hash = await bcrypt.hash(plain, BCRYPT_ROUNDS);

  // Placeholder email keeps the unique (email) constraint satisfiable for a
  // phone-first driver account; replaced when a real email is provided.
  const userEmail = email || `phone_${phone}@placeholder.local`;

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: userEmail,
          phone,
          password: hash,
          role: 'DRIVER', // hard-coded — never from input
        },
        select: { id: true },
      });

      await tx.driver.create({
        data: {
          userId: user.id,
          licenceNumber,
          licenceExpiry,
          aadhaarLast4,
          ...(kycStatus ? { kycStatus } : {}),
          assignedVehicleId,
        },
      });

      return tx.driver.findUnique({ where: { userId: user.id }, select: DRIVER_SELECT });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflictFor(err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Update  (splits fields across User and Driver)
 * ------------------------------------------------------------------ */

const USER_FIELDS = ['name', 'phone', 'email'];

async function update(userId, data) {
  const exists = await prisma.driver.findUnique({ where: { userId }, select: { userId: true } });
  if (!exists) throw ApiError.notFound('Driver not found');

  const userPatch = {};
  const driverPatch = {};
  for (const [k, v] of Object.entries(data)) {
    if (USER_FIELDS.includes(k)) userPatch[k] = v;
    else driverPatch[k] = v;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (Object.keys(userPatch).length) {
        await tx.user.update({ where: { id: userId }, data: userPatch });
      }
      if (Object.keys(driverPatch).length) {
        await tx.driver.update({ where: { userId }, data: driverPatch });
      }
      return tx.driver.findUnique({ where: { userId }, select: DRIVER_SELECT });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflictFor(err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Activate / deactivate
 *
 * Toggles the linked User's isActive flag (the account lifecycle). Deactivating
 * also forces the driver offline so a disabled account can't linger in the
 * dispatch pool.
 * ------------------------------------------------------------------ */

async function setActive(userId, active) {
  const driver = await prisma.driver.findUnique({ where: { userId }, select: { userId: true } });
  if (!driver) throw ApiError.notFound('Driver not found');

  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { isActive: active } });
    if (!active) {
      await tx.driver.update({ where: { userId }, data: { isOnline: false } });
    }
    return tx.driver.findUnique({ where: { userId }, select: DRIVER_SELECT });
  });
}

module.exports = { list, findById, create, update, setActive };