'use strict';

/**
 * src/services/fleet.service.js
 *
 * Read-only fleet queries used by the ops/fleet dashboard: list and fetch
 * vehicles and drivers. This is distinct from dispatch.service, which only
 * surfaces *free, matching* vehicles for allocation — here you see the whole
 * fleet regardless of status.
 *
 * Driver rows join through to their User for name/phone/email, so the selects
 * below are explicit: the password hash must never leave this layer.
 */

const { prisma } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');

/* ------------------------------------------------------------------ *
 * Selects — explicit so nothing sensitive leaks and payloads stay lean
 * ------------------------------------------------------------------ */

const CITY_MINI_SELECT = { id: true, name: true, state: true };

const VEHICLE_LIST_SELECT = {
  id: true,
  registrationNumber: true,
  vehicleClass: true,
  makeModel: true,
  year: true,
  colour: true,
  seatingCapacity: true,
  status: true,
  cityId: true,
  isActive: true,
  insuranceExpiry: true,
  fitnessExpiry: true,
  permitExpiry: true,
  pucExpiry: true,
  odometerKm: true,
  createdAt: true,
  updatedAt: true,
  city: { select: CITY_MINI_SELECT },
};

// Never selects User.password.
const DRIVER_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
};

const DRIVER_LIST_SELECT = {
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

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

async function listVehicles({
  page,
  limit,
  search,
  status,
  vehicleClass,
  cityId,
  isActive,
  sortBy,
  order,
}) {
  const where = {};

  if (status) where.status = status;
  if (vehicleClass) where.vehicleClass = vehicleClass;
  if (cityId) where.cityId = cityId;
  if (isActive !== undefined) where.isActive = isActive;

  if (search) {
    where.OR = [
      { registrationNumber: { contains: search, mode: 'insensitive' } },
      { makeModel: { contains: search, mode: 'insensitive' } },
    ];
  }

  const orderBy = { [sortBy || 'createdAt']: order || 'desc' };

  const [total, items] = await Promise.all([
    prisma.vehicle.count({ where }),
    prisma.vehicle.findMany({
      where,
      select: VEHICLE_LIST_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

async function getVehicleById(id) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id },
    select: {
      ...VEHICLE_LIST_SELECT,
      documents: true,
      // Drivers currently assigned to this vehicle.
      drivers: {
        select: {
          userId: true,
          licenceNumber: true,
          kycStatus: true,
          isOnline: true,
          ratingAvg: true,
          user: { select: DRIVER_USER_SELECT },
        },
      },
    },
  });

  if (!vehicle) throw ApiError.notFound('Vehicle not found');
  return vehicle;
}

/* ------------------------------------------------------------------ *
 * Drivers
 * ------------------------------------------------------------------ */

async function listDrivers({ page, limit, search, kycStatus, isOnline, sortBy, order }) {
  const where = {};

  if (kycStatus) where.kycStatus = kycStatus;
  if (isOnline !== undefined) where.isOnline = isOnline;

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
      select: DRIVER_LIST_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

async function getDriverById(userId) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: {
      ...DRIVER_LIST_SELECT,
      documents: true,
      kycVerifiedAt: true,
      policeVerifiedAt: true,
      medicalCheckedAt: true,
      inductedAt: true,
      assignedVehicle: { select: VEHICLE_LIST_SELECT },
    },
  });

  if (!driver) throw ApiError.notFound('Driver not found');
  return driver;
}

module.exports = {
  listVehicles,
  getVehicleById,
  listDrivers,
  getDriverById,
};