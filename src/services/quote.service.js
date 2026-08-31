'use strict';

/**
 * src/services/quote.service.js
 *
 * Orchestration. Turns a customer's request into a priced quote by combining
 * the three pieces that are each pure or cached on their own:
 *
 *   1. validate the pickup is inside the service area   (arithmetic, free)
 *   2. resolve addresses to coordinates                 (maps, cached 30 days)
 *   3. get road distance and duration                   (maps, cached 24h)
 *   4. load the rate card                               (Postgres, cached 6h)
 *   5. compute the fare                                 (pure function)
 *
 * fare.service stays pure because this file does all the I/O. That separation
 * is what makes a fare reproducible from its inputs six months later.
 */

const { prisma } = require('../config/prisma');
const cache = require('./cache.service');
const maps = require('./maps.service');
const fare = require('./fare.service');
const geo = require('../lib/geo');
const { ApiError } = require('../utils/helpers');

const MAX_TRIP_KM = Number(process.env.MAX_TRIP_KM || 1500);

/* ------------------------------------------------------------------ *
 * Config loading
 * ------------------------------------------------------------------ */

/**
 * The active rate card for a city, vehicle class and trip type.
 *
 * Cached for 6 hours with jitter. Invalidated on write by the admin fare
 * endpoints, so a rate change takes effect immediately rather than waiting out
 * the TTL.
 */
async function getFareConfig(cityId, vehicleClass, tripType) {
  const key = `fare:cfg:${cityId}:${vehicleClass}:${tripType}`;

  const config = await cache.getOrSet(
    key,
    async () =>
      prisma.fareConfig.findFirst({
        where: {
          cityId: Number(cityId),
          vehicleClass,
          tripType,
          isActive: true,
          effectiveFrom: { lte: new Date() },
        },
        // Most recent effective row wins, so a future-dated rate card can be
        // staged in advance and activates by itself.
        orderBy: { effectiveFrom: 'desc' },
      }),
    { ttl: cache.TTL.STATIC, cacheNull: false }
  );

  if (!config) {
    throw ApiError.badRequest(
      `No ${tripType === 'ROUND_TRIP' ? 'round trip' : 'one-way'} fare configured for ${vehicleClass}`,
      'FARE_CONFIG_MISSING'
    );
  }
  return config;
}

async function getCity(cityId) {
  const city = await cache.getOrSet(
    `city:${cityId}`,
    () => prisma.city.findFirst({ where: { id: Number(cityId), isActive: true } }),
    { ttl: cache.TTL.STATIC, cacheNull: false }
  );
  if (!city) throw ApiError.badRequest('City is not serviced', 'CITY_NOT_SERVICED');
  return city;
}

/** Invalidate after an admin edits a rate card. */
async function invalidateFareConfig(cityId, vehicleClass) {
  await cache.delByPrefix(`fare:cfg:${cityId}:${vehicleClass}:`);
}

/* ------------------------------------------------------------------ *
 * Resolving a location
 * ------------------------------------------------------------------ */

/**
 * Accepts either coordinates or an address string.
 *
 * Coordinates are preferred and cost nothing. An address costs a geocode —
 * cached for 30 days, so the same office lobby is paid for once a month at most.
 */
async function resolveLocation(input, label) {
  if (input.lat != null && input.lng != null) {
    const point = { lat: Number(input.lat), lng: Number(input.lng) };
    if (!geo.isValidCoordinate(point)) {
      throw ApiError.badRequest(`Invalid ${label} coordinates`, 'INVALID_COORDINATES');
    }
    return { ...point, formattedAddress: input.address || null, source: 'coordinates' };
  }

  if (input.address) {
    const g = await maps.geocode(input.address);
    return { lat: g.lat, lng: g.lng, formattedAddress: g.formattedAddress, source: 'geocoded' };
  }

  throw ApiError.badRequest(`Provide ${label} coordinates or an address`, 'LOCATION_REQUIRED');
}

/* ------------------------------------------------------------------ *
 * Quote
 * ------------------------------------------------------------------ */

/**
 * @param {object} input
 *   cityId, vehicleClass, tripType
 *   pickup   { lat, lng } or { address }
 *   drop     { lat, lng } or { address }
 *   pickupAt ISO
 *   returnAt ISO   (round trip)
 *   waitingMinutes, surge
 */
async function getQuote(input) {
  const {
    cityId,
    vehicleClass,
    tripType,
    pickup,
    drop,
    pickupAt,
    returnAt = null,
    waitingMinutes = 0,
    surge = 1,
    rentalPackageId = null,
    rentalHours = null,
  } = input;

  if (tripType === 'ROUND_TRIP' && !returnAt) {
    throw ApiError.badRequest('A round trip needs a return date and time', 'RETURN_TIME_REQUIRED');
  }
  if (tripType === 'HOURLY' && !rentalPackageId && !rentalHours) {
    throw ApiError.badRequest('An hourly rental needs a package or a number of hours', 'RENTAL_TERMS_REQUIRED');
  }
  if (returnAt && new Date(returnAt) <= new Date(pickupAt)) {
    throw ApiError.badRequest('Return time must be after pickup', 'INVALID_RETURN_TIME');
  }

  /* -- 1. city + service area, before spending anything -- */

  const city = await getCity(cityId);

  // HOURLY (local rental) has no fixed destination. If no drop was given, use the
  // pickup as a placeholder so downstream code has coordinates; the fare comes
  // from the package, not the pickup→drop distance, so distance is set to 0.
  const isHourly = tripType === 'HOURLY';
  const effectiveDrop = drop || (isHourly ? pickup : drop);

  const [pickupPoint, dropPoint] = await Promise.all([
    resolveLocation(pickup, 'pickup'),
    resolveLocation(effectiveDrop, 'drop'),
  ]);

  const serviceable = maps.isServiceable(pickupPoint, city);
  if (!serviceable.ok) {
    throw ApiError.badRequest(
      `Pickup is outside the ${city.name} service area (${serviceable.distanceKm} km from centre, limit ${serviceable.radiusKm} km)`,
      'OUTSIDE_SERVICE_AREA'
    );
  }

  /* -- 2. distance -- */

  // HOURLY prices from the package/hours, not the route, so we skip the distance
  // call entirely (which also avoids the SAME_LOCATION check when drop==pickup).
  const route = isHourly
    ? { distanceKm: 0, durationMin: 0, provider: 'none', estimated: false }
    : await maps.getDistance(pickupPoint, dropPoint, { maxKm: MAX_TRIP_KM });

  // A round trip covers the route twice. The engine expects the TOTAL.
  const distanceKm = tripType === 'ROUND_TRIP' ? route.distanceKm * 2 : route.distanceKm;
  const durationMin = tripType === 'ROUND_TRIP' ? route.durationMin * 2 : route.durationMin;

  /* -- 3. rate card + pure computation -- */

  const config = await getFareConfig(cityId, vehicleClass, tripType);

  // HOURLY: load the chosen fixed package (if any) so the engine can price it.
  let rentalPackage = null;
  if (tripType === 'HOURLY' && rentalPackageId) {
    // The app stores a representative package id (from whichever class it listed
    // first). Resolve it to THIS booking's class: find the stored row to learn
    // its duration label, then match the same label for the booked class. So
    // "4hr/40km" works whatever class the user chooses.
    const requested = await prisma.rentalPackage.findFirst({
      where: { id: Number(rentalPackageId), cityId: Number(cityId), isActive: true },
    });
    rentalPackage = requested && requested.vehicleClass === vehicleClass
      ? requested
      : requested
        ? await prisma.rentalPackage.findFirst({
            where: { cityId: Number(cityId), vehicleClass, label: requested.label, isActive: true },
          })
        : null;
    if (!rentalPackage) {
      throw ApiError.badRequest('That rental package is not available', 'RENTAL_PACKAGE_NOT_FOUND');
    }
  }

  // The city's IANA timezone decides the night window and the calendar-day
  // count. Without it the fare would follow the SERVER's timezone, so the same
  // booking would price differently on a Bengaluru laptop and a UTC server.
  const priced = fare.computeFare(
    {
      tripType, distanceKm, durationMin, pickupAt, returnAt, waitingMinutes, surge,
      rentalPackage, rentalHours,
      timeZone: city.timezone,
    },
    config
  );

  return {
    quote: priced,
    // The rental package actually applied (resolved to this booking's class), so
    // the caller persists the correct class-specific id, not the raw app input.
    rentalPackageId: rentalPackage ? rentalPackage.id : null,
    rentalHours: rentalHours || null,
    trip: {
      tripType,
      vehicleClass,
      cityId: city.id,
      cityName: city.name,
      pickup: { ...pickupPoint },
      drop: { ...dropPoint },
      pickupAt,
      returnAt,
      oneWayKm: route.distanceKm,
      totalKm: distanceKm,
      durationMin,
    },
    routing: {
      provider: route.provider,
      estimated: route.estimated,
      cached: route.cached || false,
      ...(route.fallbackReason ? { fallbackReason: route.fallbackReason } : {}),
    },
  };
}

/**
 * Prices the same trip both ways so the customer can compare.
 *
 * Runs one distance lookup and reuses it for both, rather than two — the route
 * is identical, only the pricing model differs.
 */
async function compareTripTypes(input) {
  const city = await getCity(input.cityId);

  const [pickupPoint, dropPoint] = await Promise.all([
    resolveLocation(input.pickup, 'pickup'),
    resolveLocation(input.drop, 'drop'),
  ]);

  const serviceable = maps.isServiceable(pickupPoint, city);
  if (!serviceable.ok) {
    throw ApiError.badRequest('Pickup is outside the service area', 'OUTSIDE_SERVICE_AREA');
  }

  const route = await maps.getDistance(pickupPoint, dropPoint, { maxKm: MAX_TRIP_KM });

  const [oneWayConfig, roundConfig] = await Promise.all([
    getFareConfig(input.cityId, input.vehicleClass, 'ONE_WAY').catch(() => null),
    getFareConfig(input.cityId, input.vehicleClass, 'ROUND_TRIP').catch(() => null),
  ]);

  const returnAt =
    input.returnAt ||
    new Date(new Date(input.pickupAt).getTime() + 10 * 3600 * 1000).toISOString();

  return {
    trip: {
      vehicleClass: input.vehicleClass,
      cityName: city.name,
      oneWayKm: route.distanceKm,
      durationMin: route.durationMin,
      pickup: pickupPoint,
      drop: dropPoint,
    },
    oneWay: oneWayConfig
      ? fare.computeFare(
          {
            tripType: 'ONE_WAY',
            distanceKm: route.distanceKm,
            durationMin: route.durationMin,
            pickupAt: input.pickupAt,
            surge: input.surge,
            timeZone: city.timezone,
          },
          oneWayConfig
        )
      : null,
    roundTrip: roundConfig
      ? fare.computeFare(
          {
            tripType: 'ROUND_TRIP',
            distanceKm: route.distanceKm * 2,
            durationMin: route.durationMin * 2,
            pickupAt: input.pickupAt,
            returnAt,
            waitingMinutes: input.waitingMinutes || 0,
            surge: input.surge,
            timeZone: city.timezone,
          },
          roundConfig
        )
      : null,
    routing: { provider: route.provider, estimated: route.estimated },
  };
}

/** Every vehicle class priced for one trip — powers the class picker. */
async function quoteAllClasses(input) {
  const city = await getCity(input.cityId);

  const isHourly = input.tripType === 'HOURLY';
  // HOURLY has no fixed destination — default drop to pickup if absent.
  const effectiveDrop = input.drop || (isHourly ? input.pickup : input.drop);

  const [pickupPoint, dropPoint] = await Promise.all([
    resolveLocation(input.pickup, 'pickup'),
    resolveLocation(effectiveDrop, 'drop'),
  ]);

  const serviceable = maps.isServiceable(pickupPoint, city);
  if (!serviceable.ok) {
    throw ApiError.badRequest('Pickup is outside the service area', 'OUTSIDE_SERVICE_AREA');
  }

  // HOURLY needs a package or an hours commitment, same rule as a single quote.
  if (isHourly && !input.rentalPackageId && !input.rentalHours) {
    throw ApiError.badRequest(
      'An hourly rental needs a package or a number of hours',
      'RENTAL_TERMS_REQUIRED'
    );
  }

  // HOURLY prices from the package, so skip the distance lookup (and its
  // SAME_LOCATION guard when drop==pickup).
  const route = isHourly
    ? { distanceKm: 0, durationMin: 0, provider: 'none', estimated: false }
    : await maps.getDistance(pickupPoint, dropPoint, { maxKm: MAX_TRIP_KM });

  const configs = await prisma.fareConfig.findMany({
    where: {
      cityId: Number(input.cityId),
      tripType: input.tripType,
      isActive: true,
      effectiveFrom: { lte: new Date() },
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  // One row per class — the most recent effective card for each.
  const seen = new Set();
  const latest = configs.filter((c) => {
    if (seen.has(c.vehicleClass)) return false;
    seen.add(c.vehicleClass);
    return true;
  });

  // A round trip covers the route twice; the engine expects the TOTAL distance.
  // HOURLY and AIRPORT use the one-way distance (the engine adds their own
  // package/surcharge logic on top).
  const multiplier = input.tripType === 'ROUND_TRIP' ? 2 : 1;

  // HOURLY with a fixed package: load the package PER vehicle class, since each
  // class has its own package fares. Done once up front to avoid N queries.
  let packagesByClass = null;
  if (input.tripType === 'HOURLY' && input.rentalPackageId) {
    const pkgs = await prisma.rentalPackage.findMany({
      where: { id: Number(input.rentalPackageId), cityId: Number(input.cityId), isActive: true },
    });
    packagesByClass = new Map(pkgs.map((p) => [p.vehicleClass, p]));
  }

  const options = latest
    .map((config) => {
      const rentalPackage = packagesByClass ? packagesByClass.get(config.vehicleClass) || null : null;
      // If a specific package was requested but this class doesn't offer it, skip
      // the class rather than mis-pricing it.
      if (input.tripType === 'HOURLY' && input.rentalPackageId && !rentalPackage) return null;

      return {
        vehicleClass: config.vehicleClass,
        ...fare.computeFare(
          {
            tripType: input.tripType,
            distanceKm: route.distanceKm * multiplier,
            durationMin: route.durationMin * multiplier,
            pickupAt: input.pickupAt,
            returnAt: input.returnAt,
            waitingMinutes: input.waitingMinutes || 0,
            surge: input.surge,
            rentalPackage,
            rentalHours: input.rentalHours || null,
            timeZone: city.timezone,
          },
          config
        ),
      };
    })
    .filter(Boolean);

  options.sort((a, b) => Number(a.total) - Number(b.total));

  return {
    trip: {
      tripType: input.tripType,
      cityName: city.name,
      oneWayKm: route.distanceKm,
      totalKm: route.distanceKm * multiplier,
      durationMin: route.durationMin * multiplier,
      pickup: pickupPoint,
      drop: dropPoint,
    },
    options,
    routing: { provider: route.provider, estimated: route.estimated },
  };
}

/**
 * List the active local-rental packages for a city (e.g. 4hr/40km, 8hr/80km,
 * 12hr/120km), grouped so the app can render a package picker. Optionally
 * filtered to one vehicle class. Cached briefly since packages change rarely.
 */
async function listRentalPackages({ cityId, vehicleClass = null }) {
  const packages = await prisma.rentalPackage.findMany({
    where: {
      cityId: Number(cityId),
      isActive: true,
      ...(vehicleClass ? { vehicleClass } : {}),
    },
    orderBy: [{ vehicleClass: 'asc' }, { sortOrder: 'asc' }, { includedHours: 'asc' }],
  });

  return packages.map((p) => ({
    id: p.id,
    cityId: p.cityId,
    vehicleClass: p.vehicleClass,
    label: p.label,
    includedHours: p.includedHours,
    includedKm: p.includedKm,
    packageFare: p.packageFare.toString(),
    extraPerHour: p.extraPerHour.toString(),
    extraPerKm: p.extraPerKm.toString(),
  }));
}

module.exports = {
  getQuote,
  compareTripTypes,
  quoteAllClasses,
  listRentalPackages,
  getFareConfig,
  getCity,
  invalidateFareConfig,
  resolveLocation,
  MAX_TRIP_KM,
};