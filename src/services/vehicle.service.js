'use strict';

/**
 * src/services/vehicle.service.js
 *
 * Full-fleet vehicle management. This is the counterpart to dispatch's
 * available-only view: here every vehicle is visible regardless of status, and
 * create / update / (soft) delete live here too.
 *
 * DELETE is a soft delete — a vehicle is referenced by allocations and
 * bookings, so removing the row would break those foreign keys. Instead we flip
 * isActive to false and status to INACTIVE, which takes it out of every
 * dispatch and fleet query while preserving its trip history.
 */

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');

const CITY_MINI_SELECT = { id: true, name: true, state: true };

const VEHICLE_SELECT = {
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

// Never selects the linked User's password.
const DRIVER_MINI_SELECT = {
  userId: true,
  licenceNumber: true,
  kycStatus: true,
  isOnline: true,
  ratingAvg: true,
  user: { select: { id: true, name: true, phone: true, email: true } },
};

// A vehicle that is out on a job must not be removed from the fleet.
const BLOCKS_DELETE = new Set(['ON_TRIP', 'ASSIGNED']);

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

async function list({ page, limit, search, status, vehicleClass, cityId, isActive, sortBy, order }) {
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
      select: VEHICLE_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

async function findById(id) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id },
    select: {
      ...VEHICLE_SELECT,
      documents: true,
      drivers: { select: DRIVER_MINI_SELECT },
    },
  });

  if (!vehicle) throw ApiError.notFound('Vehicle not found');
  return vehicle;
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

async function create(data) {
  try {
    return await prisma.vehicle.create({ data, select: VEHICLE_SELECT });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(
        'A vehicle with that registration number already exists',
        'REGISTRATION_TAKEN'
      );
    }
    throw err;
  }
}

async function update(id, data) {
  // Fail fast with a clean 404 rather than Prisma's P2025.
  const exists = await prisma.vehicle.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw ApiError.notFound('Vehicle not found');

  try {
    return await prisma.vehicle.update({ where: { id }, data, select: VEHICLE_SELECT });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(
        'A vehicle with that registration number already exists',
        'REGISTRATION_TAKEN'
      );
    }
    throw err;
  }
}

/**
 * Soft delete. Refuses if the vehicle is mid-job (ON_TRIP / ASSIGNED), since
 * taking it out of the fleet then would strand an active allocation.
 */
async function softDelete(id) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id },
    select: { id: true, status: true, isActive: true },
  });
  if (!vehicle) throw ApiError.notFound('Vehicle not found');

  if (BLOCKS_DELETE.has(vehicle.status)) {
    throw ApiError.conflict(
      `Vehicle is currently ${vehicle.status} and cannot be removed until the trip ends`,
      'VEHICLE_IN_USE'
    );
  }

  return prisma.vehicle.update({
    where: { id },
    data: { isActive: false, status: 'INACTIVE' },
    select: VEHICLE_SELECT,
  });
}

module.exports = { list, findById, create, update, softDelete };