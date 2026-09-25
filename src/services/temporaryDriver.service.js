'use strict';

/**
 * src/services/temporaryDriver.service.js
 *
 * Onboarding a hired-in driver and their vehicle in one step, for when demand
 * outruns the owned fleet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CREATES FOUR ROWS AND NOT A "TEMP DRIVER" TABLE
 * ---------------------------------------------------------------------------
 * A separate table would have been simpler to write and impossible to
 * dispatch. `allocations.vehicleId` and `.driverId` are foreign keys into
 * `vehicles` and `drivers`, and the GiST exclusion constraint that stops two
 * bookings holding the same car at the same time is keyed on vehicleId. A temp
 * vehicle outside that table could not be allocated, could not appear on the
 * dispatch board, and would be the only vehicle in the fleet with no
 * double-booking protection.
 *
 * So a temporary hire creates: a users row (role DRIVER), its drivers
 * extension, a vehicles row, and the link between them. Every downstream
 * system — dispatch, trip events, invoicing, live tracking — then works with
 * no special cases at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT COLLECTED
 * ---------------------------------------------------------------------------
 * No licence number, no KYC, no police verification, no insurance or fitness
 * dates. The client is hiring a car and a driver for a day because the
 * alternative is refusing the booking, and demanding documents at that moment
 * would make the feature useless.
 *
 * That is a real risk, not an oversight, and MVAG requires those records for
 * the fleet proper. `isTemporary` is what lets a compliance report exclude
 * them honestly rather than show the fleet as 40% unverified.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const audit = require('./audit.service');

/**
 * Registration numbers are compared, so they are stored comparably.
 *
 * "KA 01 AB 1234", "ka01ab1234" and "KA-01-AB-1234" are one vehicle. Without
 * normalising, the same car gets onboarded three times across three days and
 * each copy can be dispatched independently — which defeats the overlap
 * constraint that is the entire reason these are real rows.
 */
function normaliseRegistration(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length < 6 || cleaned.length > 16) {
    throw ApiError.badRequest(
      'Enter a valid vehicle registration number',
      'INVALID_REGISTRATION',
    );
  }
  return cleaned;
}

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw ApiError.badRequest('Enter a valid mobile number', 'INVALID_PHONE');
  }
  return `+${digits.length === 10 ? `91${digits}` : digits}`;
}

/**
 * Onboard a temporary driver and their vehicle.
 *
 * One transaction. A users row without its drivers extension, or a driver
 * without the vehicle they were hired with, is a half-built record that
 * authenticates and then fails at dispatch — worse than not existing.
 */
async function create(input, actor, meta = {}) {
  const phone = normalisePhone(input.mobile);
  const registrationNumber = normaliseRegistration(input.vehicleNumber);

  /*
   * The phone is the collision risk, and it is worth failing loudly on.
   *
   * users.phone is UNIQUE (added for the WhatsApp bot). If this number already
   * belongs to a customer, silently reusing that account would make a rider a
   * driver and hand them driver permissions. If it belongs to a driver, this
   * is almost certainly the same person being onboarded twice.
   */
  const phoneOwner = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, name: true, role: true },
  });

  if (phoneOwner) {
    if (phoneOwner.role === 'DRIVER') {
      throw ApiError.conflict(
        `${phoneOwner.name} is already registered as a driver on this number`,
        'DRIVER_EXISTS',
      );
    }
    throw ApiError.conflict(
      'That mobile number already belongs to another account',
      'PHONE_IN_USE',
    );
  }

  const vehicleOwner = await prisma.vehicle.findUnique({
    where: { registrationNumber },
    select: { id: true, isTemporary: true, isActive: true },
  });

  if (vehicleOwner && vehicleOwner.isActive) {
    throw ApiError.conflict(
      `Vehicle ${registrationNumber} is already on the fleet`,
      'VEHICLE_EXISTS',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name.trim(),
        phone,
        /*
         * A synthetic email, because users.email is required and unique while
         * a temp driver gives us only a phone.
         *
         * `.invalid` is the RFC 2606 reserved TLD — it can never be
         * registered, so nothing addressed here can ever be delivered to a
         * stranger who bought the domain.
         */
        email: `${phone.replace('+', '')}@temp-driver.invalid`,
        /*
         * An unusable password rather than a blank one. A temp driver has no
         * login today, but the column is NOT NULL, and bcrypt-comparing
         * against a predictable hash is how "sign in as any temp driver" gets
         * discovered later.
         */
        password: await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10),
        role: 'DRIVER',
      },
      select: { id: true, name: true, phone: true },
    });

    const vehicle = vehicleOwner
      ? await tx.vehicle.update({
          // Re-hiring a vehicle that was retired earlier. Reactivating beats
          // failing on the unique registration, and keeps its trip history.
          where: { id: vehicleOwner.id },
          data: {
            isActive: true,
            isTemporary: true,
            status: 'AVAILABLE',
            vehicleClass: input.vehicleClass,
            cityId: input.cityId ?? null,
          },
        })
      : await tx.vehicle.create({
          data: {
            registrationNumber,
            vehicleClass: input.vehicleClass,
            seatingCapacity: input.seatingCapacity ?? 4,
            cityId: input.cityId ?? null,
            isTemporary: true,
            status: 'AVAILABLE',
          },
        });

    const driver = await tx.driver.create({
      data: {
        userId: user.id,
        /*
         * A placeholder licence, because the column is unique and NOT NULL.
         *
         * Prefixed TEMP- so it can never be mistaken for a real licence in a
         * report or an audit, and suffixed with the user id so two temp
         * drivers onboarded in the same second cannot collide.
         */
        licenceNumber: `TEMP-${user.id.slice(0, 8).toUpperCase()}`,
        isTemporary: true,
        // Left PENDING, honestly. Nobody verified this person.
        kycStatus: 'PENDING',
        assignedVehicleId: vehicle.id,
        isOnline: true,
        inductedAt: new Date(),
      },
      select: { userId: true, licenceNumber: true, assignedVehicleId: true },
    });

    return { user, vehicle, driver };
  });

  audit.recordAsync({
    actor,
    action: 'TEMP_DRIVER_CREATED',
    entityType: 'driver',
    entityId: created.user.id,
    after: {
      name: created.user.name,
      phone: created.user.phone,
      registrationNumber,
      vehicleClass: input.vehicleClass,
    },
    meta,
  });

  return shape(created);
}

/**
 * End a temporary hire.
 *
 * Deactivates rather than deletes, and refuses while the driver still holds a
 * live allocation — releasing a car mid-trip would leave a rider with a
 * booking whose driver no longer exists.
 */
async function release(userId, actor, meta = {}) {
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: { userId: true, isTemporary: true, assignedVehicleId: true, user: { select: { name: true } } },
  });

  if (!driver) throw ApiError.notFound('Driver not found', 'DRIVER_NOT_FOUND');
  if (!driver.isTemporary) {
    throw ApiError.badRequest(
      'That is a permanent driver. Deactivate them from the drivers screen instead.',
      'NOT_TEMPORARY',
    );
  }

  const live = await prisma.allocation.count({
    where: { driverId: userId, status: 'ACTIVE' },
  });
  if (live > 0) {
    throw ApiError.badRequest(
      `${driver.user.name} is on ${live} live trip(s). Complete or reassign those first.`,
      'DRIVER_ON_TRIP',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.driver.update({ where: { userId }, data: { isOnline: false } });
    await tx.user.update({ where: { id: userId }, data: { isActive: false } });
    if (driver.assignedVehicleId) {
      await tx.vehicle.update({
        where: { id: driver.assignedVehicleId },
        data: { isActive: false, status: 'INACTIVE' },
      });
    }
  });

  audit.recordAsync({
    actor,
    action: 'TEMP_DRIVER_RELEASED',
    entityType: 'driver',
    entityId: userId,
    meta,
  });

  return { released: true, name: driver.user.name };
}

/** Every temporary driver currently hired. */
async function list({ includeReleased = false } = {}) {
  const drivers = await prisma.driver.findMany({
    where: {
      isTemporary: true,
      ...(includeReleased ? {} : { user: { isActive: true } }),
    },
    select: {
      userId: true,
      licenceNumber: true,
      isOnline: true,
      inductedAt: true,
      user: { select: { name: true, phone: true, isActive: true } },
      assignedVehicle: {
        select: { id: true, registrationNumber: true, vehicleClass: true, status: true },
      },
    },
    orderBy: { inductedAt: 'desc' },
  });

  return drivers.map((d) => ({
    userId: d.userId,
    name: d.user.name,
    mobile: d.user.phone,
    isActive: d.user.isActive,
    isOnline: d.isOnline,
    hiredAt: d.inductedAt,
    vehicle: d.assignedVehicle,
  }));
}

function shape({ user, vehicle, driver }) {
  return {
    userId: user.id,
    name: user.name,
    mobile: user.phone,
    licenceNumber: driver.licenceNumber,
    vehicle: {
      id: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      vehicleClass: vehicle.vehicleClass,
      status: vehicle.status,
    },
  };
}

module.exports = { create, release, list, normaliseRegistration, normalisePhone };