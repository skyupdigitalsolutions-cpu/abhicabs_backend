'use strict';

/**
 * src/services/dispatch.service.js   — Day 9
 *
 * Read models for the dispatch board — the operator's single screen of "what
 * needs a car, what is running, and what is free to give". All three are
 * driven off the partial indexes Day 1 created (idx_bookings_pending,
 * idx_vehicles_available), so the board stays cheap as the tables grow.
 */

const { prisma } = require('../config/prisma');
const cache = require('./cache.service');

const PENDING_STATUSES = ['PENDING', 'CONFIRMED'];
const LIVE_STATUSES = ['ALLOCATED', 'EN_ROUTE', 'ONGOING'];

/**
 * Bookings waiting for a car: created or confirmed but not yet allocated.
 * Ordered by pickup time so the most urgent sit at the top.
 */
async function pendingBookings(cityId = null) {
  return prisma.booking.findMany({
    where: {
      status: { in: PENDING_STATUSES },
      ...(cityId ? { cityId: Number(cityId) } : {}),
    },
    orderBy: { pickupAt: 'asc' },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      vehicleClass: true,
      tripType: true,
      pickupAddress: true,
      dropAddress: true,
      pickupAt: true,
      returnAt: true,
      estimatedFare: true,
      cityId: true,
      customer: { select: { user: { select: { name: true, phone: true } } } },
    },
  });
}

/**
 * Trips currently in motion (allocated through ongoing), with the vehicle and
 * driver bound to each via the active allocation.
 */
async function liveTrips(cityId = null) {
  return prisma.booking.findMany({
    where: {
      status: { in: LIVE_STATUSES },
      ...(cityId ? { cityId: Number(cityId) } : {}),
    },
    orderBy: { pickupAt: 'asc' },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      vehicleClass: true,
      pickupAddress: true,
      dropAddress: true,
      pickupAt: true,
      allocations: {
        where: { status: 'ACTIVE' },
        take: 1,
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          acceptedAt: true,
          vehicle: { select: { registrationNumber: true, makeModel: true } },
          driver: { select: { user: { select: { name: true, phone: true } } } },
        },
      },
    },
  });
}

/**
 * Vehicles free to assign right now: in service and AVAILABLE. Uses the
 * idx_vehicles_available partial index.
 */
async function availableVehicles(cityId = null, vehicleClass = null) {
  // Day 14: cache the available-fleet list. It changes when a vehicle is
  // allocated or released, so the TTL is SHORT and allocation.service invalidates
  // the city's key on every assign/release (see cache.keys.vehiclesAvailable).
  // The dispatch board reads this on every poll, so even a 30-60s cache turns a
  // per-poll table scan into an occasional one.
  const key = cache.keys.vehiclesAvailable(cityId || 'all', vehicleClass || 'all');
  return cache.getOrSet(
    key,
    () => prisma.vehicle.findMany({
      where: {
        status: 'AVAILABLE',
        isActive: true,
        ...(cityId ? { cityId: Number(cityId) } : {}),
        ...(vehicleClass ? { vehicleClass } : {}),
      },
      orderBy: { odometerKm: 'asc' },
      select: {
        id: true,
        registrationNumber: true,
        vehicleClass: true,
        makeModel: true,
        seatingCapacity: true,
        status: true,
        cityId: true,
      },
    }),
    { ttl: cache.TTL.SHORT, cacheNull: false }
  );
}

/** The whole board in one call. */
async function board(cityId = null) {
  const [pending, live, vehicles] = await Promise.all([
    pendingBookings(cityId),
    liveTrips(cityId),
    availableVehicles(cityId),
  ]);
  return {
    pending: { count: pending.length, bookings: pending },
    live: { count: live.length, trips: live },
    vehicles: { count: vehicles.length, available: vehicles },
  };
}

module.exports = { board, pendingBookings, liveTrips, availableVehicles };