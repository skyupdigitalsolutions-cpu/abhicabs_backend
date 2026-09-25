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
const surgeService = require('./surge.service');
const maps = require('./maps.service');
const fare = require('./fare.service');
const geo = require('../lib/geo');
const { ApiError } = require('../utils/helpers');
const serviceArea = require('../lib/serviceArea');

/** Longest trip the router will price. Guards against an absurd destination. */
const MAX_TRIP_KM = Number(process.env.MAX_TRIP_KM || 1500);

/*
 * Surge now lives in surge.service, keyed on WHERE the pickup is as well as
 * how soon it is.
 *
 * The constants that used to sit here — a 30-minute window and a flat 5% —
 * priced a village pickup exactly like a city-centre one. They were also two
 * environment variables, so changing a commercial percentage meant a redeploy
 * and left no record of who changed it. Both now live in surge_rules, per
 * tier, editable from the admin panel.
 */

/**
 * How far apart pickup and drop must be before a trip counts as a real journey.
 *
 * 250 m rather than a few metres. Two pins dropped at opposite ends of one mall
 * or airport terminal are ~150 m apart and are still the same place — a rider
 * who did that has made a mistake, not a booking. Below this a driver would be
 * dispatched to earn the minimum fare for a walk.
 */
const MIN_TRIP_SEPARATION_KM = 0.25;

/**
 * Trip types that must have a distinct destination.
 *
 * ONE_WAY and AIRPORT are point-to-point: same pickup and drop is meaningless.
 *
 * ROUND_TRIP is deliberately NOT here — "take me to the airport and back" is a
 * legitimate booking whose drop equals its pickup, and the return leg is what is
 * being paid for. HOURLY is not here either: a local rental has no destination
 * at all, and the pipeline sets drop = pickup on purpose so the rest of the code
 * has coordinates to work with.
 */
const REQUIRES_DISTINCT_DROP = new Set(['ONE_WAY', 'AIRPORT']);

/**
 * Reject a point-to-point trip that does not actually go anywhere.
 *
 * This lives here, before routing, rather than relying on the SAME_LOCATION
 * check inside getDistance. That one is a side effect of measuring a single
 * leg, so it is skipped entirely once the trip has stops — pickup → stop → back
 * to the same pickup would route fine and quote a fare. Checking the endpoints
 * explicitly catches that, and it also saves a maps API call on a request that
 * can never succeed.
 */
function assertDistinctEndpoints(tripType, pickupPoint, dropPoint) {
  if (!REQUIRES_DISTINCT_DROP.has(tripType)) return;

  const apartKm = geo.haversineKm(
    pickupPoint.lat, pickupPoint.lng,
    dropPoint.lat, dropPoint.lng
  );

  if (apartKm < MIN_TRIP_SEPARATION_KM) {
    throw ApiError.badRequest(
      tripType === 'AIRPORT'
        ? 'Pickup and drop are the same place. Set the airport as one end of the trip.'
        : 'Pickup and drop are the same place. Choose a different destination.',
      'SAME_LOCATION'
    );
  }
}

/**
 * Trip types that must END OUTSIDE the pickup city — the outstation products.
 *
 * ONE_WAY and ROUND_TRIP are sold as intercity travel. Their whole rate card is
 * built for it: returnEmptyPct pays for the driver's empty return leg,
 * minKmPerDay bills a car held for days, driverAllowance is the per-day bata for
 * a driver away from home. None of those make sense inside one city.
 *
 * AIRPORT and HOURLY are the local products and are deliberately absent. An
 * airport run is a city trip by definition, and a local rental never leaves.
 * Between them they cover everything a rider needs within the city, which is
 * what makes restricting these two coherent rather than merely restrictive.
 */
const REQUIRES_OUTSTATION_DROP = new Set(['ONE_WAY', 'ROUND_TRIP']);

/**
 * Is this drop inside the pickup city?
 *
 * "Same city" is decided by the pickup city's own service radius, not by
 * comparing address strings. The cities table already carries centreLat,
 * centreLng and radiusKm, and isServiceable uses exactly that circle to decide
 * whether a pickup is accepted — so the same boundary defines what counts as
 * leaving. One definition of a city in the system, not two that can disagree.
 *
 * The alternative — reverse-geocoding the drop and comparing locality names —
 * would cost an API call per quote and then hinge on whether a provider spells
 * a suburb as its own locality or as part of the parent city.
 */
function isDropInsideCity(dropPoint, city) {
  return geo.isWithinRadius(
    dropPoint.lat, dropPoint.lng,
    city.centreLat, city.centreLng,
    Number(city.radiusKm)
  );
}

/**
 * An outstation request whose drop is inside the pickup city is answered with a
 * LOCAL rental instead of an error.
 *
 * Rejecting would be easier and worse. The rider has a real, serviceable
 * journey in mind — they have simply chosen the wrong product for it, usually
 * because Outstation is the tab they happened to land on. An error asks them to
 * work out which tab they should have used; switching answers the question they
 * were actually asking and tells them what changed.
 *
 * The switch needs terms, because a rental is sold by duration rather than
 * distance. The SHORTEST active package for the city is chosen — the smallest
 * commitment that can serve the trip. Picking a larger one would quietly sell
 * them more hours than they asked for.
 *
 * Returns null when no switch applies, so callers can treat it as "did anything
 * change?" rather than having to know the rules.
 */
async function resolveLocalSwitch(tripType, dropPoint, city) {
  if (!REQUIRES_OUTSTATION_DROP.has(tripType)) return null;
  if (!isDropInsideCity(dropPoint, city)) return null;

  const pkg = await prisma.rentalPackage.findFirst({
    where: { cityId: Number(city.id), isActive: true },
    orderBy: [{ includedHours: 'asc' }, { packageFare: 'asc' }],
  });

  if (!pkg) {
    // A city with no rental packages cannot serve a local trip at all, so there
    // is nothing to switch TO. Saying so is better than switching to a product
    // that will fail at the next step.
    throw ApiError.badRequest(
      `Pickup and drop are both in ${city.name}, and no local rental is available here yet.`,
      'LOCAL_UNAVAILABLE'
    );
  }

  return {
    from: tripType,
    to: 'HOURLY',
    reason: 'DROP_INSIDE_PICKUP_CITY',
    // Copy for the app to show. Written here rather than in the client so every
    // surface says the same thing.
    title: 'Switched to Local',
    message:
      `Since your pickup and drop-off are both in ${city.name}, ` +
      `we've switched your outstation trip to a local ride.`,
    rentalPackageId: pkg.id,
    rentalPackageLabel: pkg.label,
    rentalHours: pkg.includedHours,
  };
}


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
/*
 * Versioned so a deploy that changes rate cards in a MIGRATION takes effect at
 * once. The admin endpoints invalidate on write, but a migration writes to the
 * database behind the cache's back — and without a new key, booking creation
 * (which reads through here) would keep pricing from the old cached row for up
 * to six hours while the fare list (which reads the database directly) showed
 * the new one. The rider would be quoted one total and booked at another.
 *
 * Bump this whenever a migration changes fare_configs.
 *   v2 — 20260928090000_oneway_full_return (return_empty_pct -> 100)
 */
const FARE_CFG_CACHE_VERSION = 'v2';
const fareCfgPrefix = (cityId, vehicleClass) =>
  `fare:cfg:${FARE_CFG_CACHE_VERSION}:${cityId}:${vehicleClass}:`;

async function getFareConfig(cityId, vehicleClass, tripType) {
  const key = `${fareCfgPrefix(cityId, vehicleClass)}${tripType}`;

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
  await cache.delByPrefix(fareCfgPrefix(cityId, vehicleClass));
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
 * Service states
 * ------------------------------------------------------------------ */

/**
 * Refuse a route that touches a state the fleet does not operate in.
 *
 * Checked SEPARATELY from maps.isServiceable, which asks a different question:
 * that one measures distance from a city centre, which is right for a local
 * ride and wrong for an outstation drop. Bengaluru to Hyderabad is 570 km from
 * any centre and is a trip the fleet runs; Bengaluru to Chennai is closer and
 * is not, because there is no presence in Tamil Nadu. Radius cannot express
 * that — the constraint is permits and recovery, not geometry.
 *
 * Throws OUTSIDE_SERVICE_STATES, a code the app keys on to offer "send a
 * booking request" instead of a fare. The offending state and the allowlist
 * both travel in `details`, so the app can name them without hardcoding a list
 * that would drift the day a fifth state opens.
 */
async function assertWithinServiceStates(points) {
  const offending = [];

  for (const { label, point } of points) {
    if (!point) continue;
    const check = await serviceArea.checkPlace(point);
    if (!check.ok) offending.push({ label, state: check.state });
  }

  if (offending.length === 0) return;

  const allowed = await serviceArea.allowedStateNames();
  const named = offending
    .map((o) => (o.state ? `${o.label} (${o.state})` : o.label))
    .join(' and ');

  throw new ApiError(
    400,
    'OUTSIDE_SERVICE_STATES',
    `We do not operate in that area yet — ${named}. We currently serve ${allowed.join(', ')}. ` +
      'You can send this as a booking request and our team will get back to you.',
    { offending, allowedStates: allowed, canRequest: true },
  );
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
    stops = [],
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

  // A point-to-point trip must actually go somewhere. Checked before any
  // routing call, so a request that can never succeed costs no maps quota.
  assertDistinctEndpoints(tripType, pickupPoint, dropPoint);

  // Intermediate stops (ignored for HOURLY, which prices by package not route).
  const stopPoints = isHourly
    ? []
    : await Promise.all((stops || []).map((s, i) => resolveLocation(s, `stop ${i + 1}`)));

  // Jurisdiction before geometry: a route into a state we do not serve is
  // refused here, with a code the app turns into "send a booking request".
  await assertWithinServiceStates([
    { label: 'pickup', point: pickupPoint },
    // null for HOURLY, which has no destination — checkPlace skips it.
    { label: 'drop', point: dropPoint || null },
  ]);

  const serviceable = maps.isServiceable(pickupPoint, city);
  if (!serviceable.ok) {
    throw ApiError.badRequest(
      `Pickup is outside the ${city.name} service area (${serviceable.distanceKm} km from centre, limit ${serviceable.radiusKm} km)`,
      'OUTSIDE_SERVICE_AREA'
    );
  }

  // An outstation request that never leaves the city becomes a local rental
  // rather than an error. Everything below then prices the LOCAL product, and
  // the switch is reported back so the app can say what changed.
  // Server-decided, never taken on trust from the request.
  /*
   * Classified on the PICKUP point, not the drop.
   *
   * The premium pays for getting a car to the rider, so it is the pickup's
   * supply that matters. A village-to-metro trip is hard to serve; the same
   * trip reversed is not.
   */
  const surgeInfo = await surgeService.resolveSurge({
    pickupPoint,
    pickupAt,
    requestedSurge: surge,
  });

  const localSwitch = await resolveLocalSwitch(tripType, dropPoint, city);
  const effectiveTripType = localSwitch ? localSwitch.to : tripType;
  const effectivePackageId = localSwitch ? localSwitch.rentalPackageId : rentalPackageId;
  const effectiveHours = localSwitch ? null : rentalHours;
  const isHourlyNow = effectiveTripType === 'HOURLY';

  /* -- 2. distance -- */

  // HOURLY prices from the package/hours, not the route, so we skip the distance
  // call entirely (which also avoids the SAME_LOCATION check when drop==pickup).
  // With stops, the route is pickup → stop₁ → … → drop. getPathDistance sums the
  // legs, each Redis-cached exactly like a plain pickup→drop lookup.
  // isHourlyNow, not isHourly: a switched trip is priced as a rental, so the
  // route lookup is skipped and its SAME_LOCATION guard along with it.
  const route = isHourlyNow
    ? { distanceKm: 0, durationMin: 0, provider: 'none', estimated: false }
    : stopPoints.length
      ? await maps.getPathDistance([pickupPoint, ...stopPoints, dropPoint], { maxKm: MAX_TRIP_KM })
      : await maps.getDistance(pickupPoint, dropPoint, { maxKm: MAX_TRIP_KM });

  // A round trip covers the route twice. The engine expects the TOTAL. A round
  // trip that switched to local no longer has two legs, so it is excluded.
  const doubled = effectiveTripType === 'ROUND_TRIP';
  const distanceKm = doubled ? route.distanceKm * 2 : route.distanceKm;
  const durationMin = doubled ? route.durationMin * 2 : route.durationMin;

  /* -- 3. rate card + pure computation -- */

  const config = await getFareConfig(cityId, vehicleClass, effectiveTripType);

  /* -- HOURLY: resolve which rental product is actually being bought -- */

  let rentalPackage = null;
  let matchedPackage = false;

  if (isHourlyNow && effectivePackageId) {
    // The app stores a representative package id (from whichever class it listed
    // first). Resolve it to THIS booking's class: find the stored row to learn
    // its duration label, then match the same label for the booked class. So
    // "4hr/40km" works whatever class the user chooses.
    const requested = await prisma.rentalPackage.findFirst({
      where: { id: Number(effectivePackageId), cityId: Number(cityId), isActive: true },
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
  } else if (isHourlyNow && effectiveHours) {
    /**
     * Flexible hours that happen to equal a package.
     *
     * The rider used the stepper rather than tapping a package card, but asked
     * for a duration a package already covers — 4, 8, 12 hours. Priced by the
     * hourly rate that would usually cost MORE than the bundle for the exact
     * same product, which the rider cannot see because the two options sit
     * behind a toggle and are never compared.
     *
     * So an exact match on includedHours is priced as the package. Charging
     * more for the identical thing because of which control was tapped is not
     * a pricing decision, it is an accident of the UI.
     *
     * Only an EXACT match counts. 5 hours does not become the 4-hour package
     * (the rider would be short an hour) and does not become the 8-hour one
     * (they would be billed for three hours they did not ask for). Anything
     * without a package falls through to the hourly rate, unchanged.
     */
    rentalPackage = await prisma.rentalPackage.findFirst({
      where: {
        cityId: Number(cityId),
        vehicleClass,
        includedHours: Number(effectiveHours),
        isActive: true,
      },
      // Cheapest wins if a city ever seeds two packages of the same duration.
      orderBy: { packageFare: 'asc' },
    });
    matchedPackage = Boolean(rentalPackage);
  }

  // The city's IANA timezone decides the night window and the calendar-day
  // count. Without it the fare would follow the SERVER's timezone, so the same
  // booking would price differently on a Bengaluru laptop and a UTC server.
  const priced = fare.computeFare(
    {
      tripType: effectiveTripType,
      distanceKm, durationMin, pickupAt,
      // A switched trip has no return leg to price.
      returnAt: localSwitch ? null : returnAt,
      waitingMinutes,
      surge: surgeInfo.surge,
      rentalPackage,
      rentalHours: effectiveHours,
      timeZone: city.timezone,
    },
    config
  );

  return {
    quote: priced,
    // The rental package actually applied (resolved to this booking's class), so
    // the caller persists the correct class-specific id, not the raw app input.
    // This is also set when the rider asked for flexible hours that happen to
    // match a package — the booking then records the package it was priced as,
    // not the stepper value, so the frozen fare stays explainable.
    rentalPackageId: rentalPackage ? rentalPackage.id : null,
    rentalHours: rentalHours || null,
    // True only when a flexible-hours request was upgraded to a package. Lets
    // the app tell the rider they got the bundle rate instead of silently
    // showing a lower number than the one they were quoted a moment ago.
    rentalPackageMatched: matchedPackage,
    rentalPackageLabel: rentalPackage ? rentalPackage.label : null,
    // Non-null only when an outstation request was answered with a local ride.
    // Carries the copy for the dialog and the terms the app must adopt.
    switchedToLocal: localSwitch,
    /**
     * Why the price carries a premium, so the app can say so rather than
     * leaving the rider to notice a number they cannot account for.
     */
    surge: {
      multiplier: surgeInfo.surge,
      /** The figure to show a rider: 5, 10, 15 — not 1.05. */
      pct: surgeInfo.pct,
      /** METRO | TALUKA | VILLAGE, and the named area it matched. */
      tier: surgeInfo.tier,
      area: surgeInfo.area,
      /** False when no configured area contained the pickup — see FALLBACK_TIER. */
      matched: surgeInfo.matched,
      immediate: surgeInfo.immediate,
      // Kept under the old name too: the app already reads `imminent`, and
      // renaming it in the same change that alters the pricing would make a
      // display bug look like a pricing bug.
      imminent: surgeInfo.immediate,
      minutesToPickup: surgeInfo.minutesToPickup,
      reason: surgeInfo.reason,
    },
    trip: {
      // What was PRICED, which may differ from what was asked for.
      tripType: effectiveTripType,
      requestedTripType: tripType,
      vehicleClass,
      cityId: city.id,
      cityName: city.name,
      pickup: { ...pickupPoint },
      drop: { ...dropPoint },
      stops: stopPoints.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        address: p.formattedAddress || null,
      })),
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

  // This endpoint compares ONE_WAY against ROUND_TRIP for the same route, so a
  // same-place request is meaningless for the half of the comparison that is
  // point-to-point. Guarded as ONE_WAY.
  assertDistinctEndpoints('ONE_WAY', pickupPoint, dropPoint);

  // Jurisdiction before geometry: a route into a state we do not serve is
  // refused here, with a code the app turns into "send a booking request".
  await assertWithinServiceStates([
    { label: 'pickup', point: pickupPoint },
    // null for HOURLY, which has no destination — checkPlace skips it.
    { label: 'drop', point: dropPoint || null },
  ]);

  const serviceable = maps.isServiceable(pickupPoint, city);
  if (!serviceable.ok) {
    throw ApiError.badRequest('Pickup is outside the service area', 'OUTSIDE_SERVICE_AREA');
  }

  // This endpoint exists to compare ONE_WAY against ROUND_TRIP for one route.
  // Both are outstation products, so a same-city drop leaves nothing to
  // compare — and unlike a quote there is no single answer to switch TO.
  if (isDropInsideCity(dropPoint, city)) {
    throw ApiError.badRequest(
      `Both points are in ${city.name}. Ask for a local rental quote instead.`,
      'DROP_INSIDE_PICKUP_CITY'
    );
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
            surge: surgeInfo.surge,
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
            surge: surgeInfo.surge,
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

  // A point-to-point trip must actually go somewhere. Checked before any
  // routing call, so a request that can never succeed costs no maps quota.
  assertDistinctEndpoints(input.tripType, pickupPoint, dropPoint);

  // Jurisdiction before geometry: a route into a state we do not serve is
  // refused here, with a code the app turns into "send a booking request".
  await assertWithinServiceStates([
    { label: 'pickup', point: pickupPoint },
    // null for HOURLY, which has no destination — checkPlace skips it.
    { label: 'drop', point: dropPoint || null },
  ]);

  const serviceable = maps.isServiceable(pickupPoint, city);
  if (!serviceable.ok) {
    throw ApiError.badRequest('Pickup is outside the service area', 'OUTSIDE_SERVICE_AREA');
  }

  // An outstation request that never leaves the city becomes a local rental.
  // Everything below prices the LOCAL product and the switch is reported back.
  // One decision for the whole list — every class on the screen must show the
  // same urgency, or the surge looks like it depends on the car.
  const surgeInfo = await surgeService.resolveSurge({
    pickupPoint,
    pickupAt: input.pickupAt,
    requestedSurge: input.surge,
  });

  const localSwitch = await resolveLocalSwitch(input.tripType, dropPoint, city);
  const effectiveTripType = localSwitch ? localSwitch.to : input.tripType;
  const effectivePackageId = localSwitch ? localSwitch.rentalPackageId : input.rentalPackageId;
  const effectiveHours = localSwitch ? null : input.rentalHours;
  const isHourlyNow = effectiveTripType === 'HOURLY';

  // A switched request arrives with no rental terms by definition, so this only
  // guards a request that asked for HOURLY in the first place.
  if (isHourlyNow && !localSwitch && !effectivePackageId && !effectiveHours) {
    throw ApiError.badRequest(
      'An hourly rental needs a package or a number of hours',
      'RENTAL_TERMS_REQUIRED'
    );
  }

  // HOURLY prices from the package, so skip the distance lookup (and its
  // SAME_LOCATION guard when drop==pickup).
  const route = isHourlyNow
    ? { distanceKm: 0, durationMin: 0, provider: 'none', estimated: false }
    : await maps.getDistance(pickupPoint, dropPoint, { maxKm: MAX_TRIP_KM });

  /*
   * Only classes a rider can SEE — an ACTIVE vehicle_catalog row.
   *
   * This list used to be "every class with a rate card". Rate cards outlive
   * the catalogue on purpose (old bookings and airport pricing still need
   * them), so a class retired from the catalogue — the old generic Sedan and
   * SUV — kept appearing on the fare screen next to the real cars, with no
   * photo and a placeholder name. The catalogue is what the business sells;
   * a rate card is only how it is priced.
   */
  const [configs, visible] = await Promise.all([
    prisma.fareConfig.findMany({
      where: {
        cityId: Number(input.cityId),
        tripType: effectiveTripType,
        isActive: true,
        effectiveFrom: { lte: new Date() },
      },
      orderBy: { effectiveFrom: 'desc' },
    }),
    prisma.vehicleCatalog.findMany({ where: { isActive: true }, select: { key: true } }),
  ]);
  const visibleClasses = new Set(visible.map((v) => v.key));

  // One row per class — the most recent effective card for each.
  const seen = new Set();
  const latest = configs.filter((c) => {
    if (!visibleClasses.has(c.vehicleClass)) return false;
    if (seen.has(c.vehicleClass)) return false;
    seen.add(c.vehicleClass);
    return true;
  });

  // A round trip covers the route twice; the engine expects the TOTAL distance.
  // HOURLY and AIRPORT use the one-way distance (the engine adds their own
  // package/surcharge logic on top).
  const multiplier = effectiveTripType === 'ROUND_TRIP' ? 2 : 1;

  // HOURLY with a fixed package: load the package PER vehicle class, since each
  // class has its own package fares. Done once up front to avoid N queries.
  let packagesByClass = null;
  if (isHourlyNow && effectivePackageId) {
    // Resolve by LABEL, not by id. A package id belongs to one vehicle class,
    // but this endpoint prices every class — so find the chosen package's label
    // and fetch that same product for each class.
    const chosen = await prisma.rentalPackage.findFirst({
      where: { id: Number(effectivePackageId), cityId: Number(input.cityId), isActive: true },
    });
    const pkgs = chosen
      ? await prisma.rentalPackage.findMany({
          where: { cityId: Number(input.cityId), label: chosen.label, isActive: true },
        })
      : [];
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
            surge: surgeInfo.surge,
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
      // What was PRICED, which may differ from what was asked for.
      tripType: effectiveTripType,
      requestedTripType: input.tripType,
      cityName: city.name,
      oneWayKm: route.distanceKm,
      totalKm: route.distanceKm * multiplier,
      durationMin: route.durationMin * multiplier,
      pickup: pickupPoint,
      drop: dropPoint,
    },
    options,
    routing: { provider: route.provider, estimated: route.estimated },
    // Non-null only when an outstation request was answered with a local ride.
    switchedToLocal: localSwitch,
    /**
     * Why the price carries a premium, so the app can say so rather than
     * leaving the rider to notice a number they cannot account for.
     */
    surge: {
      multiplier: surgeInfo.surge,
      /** The figure to show a rider: 5, 10, 15 — not 1.05. */
      pct: surgeInfo.pct,
      /** METRO | TALUKA | VILLAGE, and the named area it matched. */
      tier: surgeInfo.tier,
      area: surgeInfo.area,
      /** False when no configured area contained the pickup — see FALLBACK_TIER. */
      matched: surgeInfo.matched,
      immediate: surgeInfo.immediate,
      // Kept under the old name too: the app already reads `imminent`, and
      // renaming it in the same change that alters the pricing would make a
      // display bug look like a pricing bug.
      imminent: surgeInfo.immediate,
      minutesToPickup: surgeInfo.minutesToPickup,
      reason: surgeInfo.reason,
    },
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