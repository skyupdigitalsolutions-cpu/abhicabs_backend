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
// Owns the city-card-beats-state-card rule. Required here rather than
// reimplemented, because a second copy of that rule would silently stop
// finding statewide cards the day one of them changed.
const fareLookup = require('./fareLookup.service');
const surgeService = require('./surge.service');
const maps = require('./maps.service');
const fare = require('./fare.service');
const geo = require('../lib/geo');
const { ApiError } = require('../utils/helpers');
const gst = require('./gst.service');
const M = require('../lib/money');
const serviceArea = require('../lib/serviceArea');
const india = require('../lib/india');
const { normaliseReturnDate, returnDateIsValid } = require('../lib/returnDate');

/*
 * NO DISTANCE CAP.
 *
 * MAX_TRIP_KM (1500 km straight line) used to live here. It was removed
 * because it answered the wrong question: it refused Bengaluru–Delhi, which is
 * a trip the fleet runs, and accepted Bengaluru–Colombo, which has no road.
 *
 * What bounds a trip is the coastline, not a number, so assertWithinIndia
 * below is the only limit on how far a customer may go. If a cap is ever
 * genuinely wanted — a commercial one, say "nothing over 2000 km without an
 * admin" — it belongs in the fare config as a per-city setting an admin can
 * change, not as an environment variable that needs a redeploy.
 */

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
 * Fallback city-limits radius, in km, for a city row that predates the
 * local_radius_km column — or, more realistically, for one still being served
 * from a cache entry written before the migration ran.
 *
 * Matches the schema default. Deliberately NOT a fallback to radiusKm: that is
 * the bug this whole change exists to fix, and a stale cache must not be able
 * to reintroduce it.
 */
const DEFAULT_LOCAL_RADIUS_KM = 25;

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
function cityLimitsKm(city) {
  /*
   * localRadiusKm, NOT radiusKm. The two answer different questions and using
   * the wrong one is what made this function wrong for months:
   *
   *   radiusKm       service REACH — "will we send a car here?" Deliberately
   *                  generous; Bengaluru is 60 km so outskirts pickups work.
   *   localRadiusKm  city LIMITS   — "is this still the same city?" Must be
   *                  tight, because anything past the urban edge is a real
   *                  outstation trip.
   *
   * With the 60 km service radius standing in for city limits, every satellite
   * town read as "inside Bengaluru": Hoskote 25 km, Nelamangala 26 km,
   * Attibele 28 km, Bidadi 30 km, Anekal 31 km, Devanahalli 33 km, Hosur 36 km
   * (a different STATE), Malur 38 km, Magadi 40 km, Ramanagara 44 km,
   * Kanakapura 51 km, Chikkaballapur 54 km. A rider booking Bengaluru → Hosur
   * was told their pickup and drop were in the same city and silently
   * downgraded to a local rental.
   *
   * The fallback matters: `city` is read through a long-lived cache, so an
   * entry cached before the column existed would yield undefined here. Falling
   * back to the schema default rather than to radiusKm means a stale cache
   * cannot resurrect the bug — it just uses a slightly generic city size.
   */
  const local = Number(city.localRadiusKm);
  if (Number.isFinite(local) && local > 0) {
    // Never wider than what we actually serve. A "city" bigger than the
    // service area is meaningless and would re-widen this test.
    return Math.min(local, Number(city.radiusKm));
  }
  return Math.min(DEFAULT_LOCAL_RADIUS_KM, Number(city.radiusKm));
}

/**
 * Is this trip entirely inside the operating city?
 *
 * BOTH endpoints are tested, not just the drop.
 *
 * Checking only the drop got the reverse case wrong in exactly the same way:
 * a pickup in Ramanagara with a drop in Koramangala is an inbound outstation
 * trip, but the drop is inside the city, so it was downgraded to a local
 * rental — a product that cannot serve it, since the car has to travel 44 km
 * before the meter starts. A trip is local only when it starts AND ends in
 * town.
 */
function isSameCityTrip(pickupPoint, dropPoint, city) {
  const limit = cityLimitsKm(city);
  const inside = (p) =>
    p &&
    geo.isWithinRadius(p.lat, p.lng, city.centreLat, city.centreLng, limit);
  return inside(pickupPoint) && inside(dropPoint);
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
async function resolveLocalSwitch(tripType, pickupPoint, dropPoint, city, chosenPackageId) {
  if (!REQUIRES_OUTSTATION_DROP.has(tripType)) return null;
  if (!isSameCityTrip(pickupPoint, dropPoint, city)) return null;

  // Distinct labels, cheapest row per label, shortest first — the same shape
  // the rental picker already renders, so the app can show these directly.
  const packages = await prisma.rentalPackage.findMany({
    where: { cityId: Number(city.id), isActive: true },
    orderBy: [{ includedHours: 'asc' }, { packageFare: 'asc' }],
  });

  if (packages.length === 0) {
    // A city with no rental packages cannot serve a local trip at all, so there
    // is nothing to switch TO. Saying so is better than switching to a product
    // that will fail at the next step.
    throw ApiError.badRequest(
      `Pickup and drop are both in ${city.name}, and no local rental is available here yet.`,
      'LOCAL_UNAVAILABLE'
    );
  }

  const byLabel = [];
  const seen = new Set();
  for (const p of packages) {
    if (seen.has(p.label)) continue;
    seen.add(p.label);
    byLabel.push({
      rentalPackageId: p.id,
      label: p.label,
      includedHours: p.includedHours,
      includedKm: p.includedKm,
    });
  }

  /*
   * THE RIDER CHOOSES THE PACKAGE. WE DO NOT.
   *
   * This used to pick the shortest active package — 4 hrs / 40 km — and quote
   * on it. The reasoning was "the smallest commitment that can serve the trip",
   * but a rental is sold by DURATION, and the shortest one is only the right
   * answer if the rider happens to be done in four hours. Nobody asked them.
   * They landed on a fare for terms they had never seen, and the only clue was
   * one line of small print in a notice modal.
   *
   * So when no package has been chosen yet, we refuse to guess: the switch is
   * reported with the available packages attached and the app asks. Once the
   * rider picks one it comes back on the next quote as chosenPackageId and we
   * price it.
   *
   * `needsPackage` is what the client branches on, rather than having to infer
   * it from a null id.
   */
  const chosen = chosenPackageId
    ? byLabel.find((p) => p.rentalPackageId === Number(chosenPackageId)) ?? null
    : null;

  const base = {
    from: tripType,
    to: 'HOURLY',
    reason: 'TRIP_INSIDE_PICKUP_CITY',
    // Copy for the app to show. Written here rather than in the client so every
    // surface says the same thing.
    title: 'Switched to Local',
    message:
      `Both your pickup and drop-off are inside ${city.name}, so this is a ` +
      `local trip rather than an outstation one.`,
    packages: byLabel,
  };

  // A package the rider explicitly asked for (or one carried over from an
  // earlier quote in this flow). Price it.
  if (chosen || chosenPackageId) {
    return {
      ...base,
      needsPackage: false,
      rentalPackageId: chosen ? chosen.rentalPackageId : Number(chosenPackageId),
      rentalPackageLabel: chosen ? chosen.label : null,
      rentalHours: chosen ? chosen.includedHours : null,
    };
  }

  return {
    ...base,
    needsPackage: true,
    prompt: 'Choose how long you need the cab for.',
    rentalPackageId: null,
    rentalPackageLabel: null,
    rentalHours: null,
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
 *   v3 — 20260929090000_retire_base_fare   (base_fare -> 0)
 *   v4 — 20260929092000_disable_demand_pricing (min/max_surge -> 1)
 *   v5 — 20261006090000_min_km_oneway_rates_metro_surge
 *        (minimum_km added, minimum_fare -> 0, return_empty_pct -> 0,
 *         max_surge reopened to 2.00). This one moves real prices in both
 *         directions — one-way fares roughly halve — so a stale cached row
 *         would quote a rider one total and book them at another.
 */
/*
 * v6: statewide rate cards.
 *
 * The key is still per CITY — a card resolved for Mysuru is cached under
 * Mysuru whether it came from Mysuru's own card or from Karnataka's — but
 * WHICH row a given key resolves to has changed. A v5 entry written before
 * this deploy could hold "no card" for a city that a state card now prices,
 * and that negative is cached. Bumping the version retires every one of them
 * at once instead of waiting out thirty seconds of FARE_CONFIG_MISSING.
 */
const FARE_CFG_CACHE_VERSION = 'v6';
const fareCfgPrefix = (cityId, vehicleClass) =>
  `fare:cfg:${FARE_CFG_CACHE_VERSION}:${cityId}:${vehicleClass}:`;

/**
 * Every vehicleClass that any rate card prices, and every serviceable city id.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: BOUNDING THE CACHE KEYSPACE
 * ---------------------------------------------------------------------------
 * `vehicleClass` is free text from the request body — deliberately, so a class
 * added to the fleet needs no migration. But it is also part of a cache key,
 * which means an attacker choosing the string chooses the key.
 *
 * Negative caching stops those requests reaching Postgres. It does not stop
 * them reaching Redis: a loop of random classes writes a miss marker each, and
 * the flood moves from the database to the cache.
 *
 * Checking membership FIRST closes both. An unknown class is rejected before a
 * key is built, so it costs one lookup in an already-cached set and nothing
 * else. Known classes are unaffected.
 *
 * The set is derived from fare_configs, not from vehicle_catalog. Pricing is
 * what this function does, so the authority on "is this a real class" has to
 * be the table that prices it — otherwise a class with a rate card but no
 * catalogue row would be refused a quote it can legitimately be given.
 */
const PRICEABLE_KEY = 'fare:priceable:v1';

async function priceableSets() {
  return cache.getOrSet(
    PRICEABLE_KEY,
    async () => {
      const [classes, cities] = await Promise.all([
        prisma.fareConfig.findMany({
          where: { isActive: true },
          distinct: ['vehicleClass'],
          select: { vehicleClass: true },
        }),
        prisma.city.findMany({ where: { isActive: true }, select: { id: true } }),
      ]);
      return {
        classes: classes.map((c) => c.vehicleClass),
        cities: cities.map((c) => c.id),
      };
    },
    /*
     * ONE MINUTE, not the ten this started at.
     *
     * This set gates access, so its TTL is the worst case before something
     * newly added becomes quotable. Rate cards are covered by explicit
     * invalidation from fareConfig.service, but a CITY has no admin service
     * yet — it is seeded by migration — so nothing calls out to clear this
     * when one appears. A short TTL is what makes that safe without inventing
     * a hook for a service that does not exist.
     *
     * The cost is one small query a minute: two indexed reads returning a
     * handful of rows. Cheap enough that a longer TTL would be optimising the
     * wrong thing.
     *
     * 50 SECONDS, not 60. cache.set applies ±20% jitter — deliberately, so
     * ten thousand keys written in one second do not all expire in one second
     * — which turns a 60s TTL into 48–72s. Asking for "quotable within a
     * minute" and shipping a 72-second worst case would be a promise broken
     * one time in three. 50 gives 40–60.
     */
    { ttl: 50 },
  );
}

/**
 * Which city's rate cards should price a trip starting here.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED A HARD REJECTION
 * ---------------------------------------------------------------------------
 * Serviceability used to be a single test: is the pickup inside the requested
 * city's radius? Outside it, the quote was refused.
 *
 * That conflated two different questions. `service_states` already answers
 * the jurisdictional one — will we operate here at all — and a pickup in
 * Mysuru passes it. The radius answers an operational one: which depot's
 * prices apply. Refusing Mysuru because it is 126 km from the Bengaluru
 * centre told a customer in a state we serve that we do not serve them.
 *
 * So the radius now SELECTS a city rather than gating the trip: the nearest
 * active city wins, and its rate cards price the journey. A pickup inside the
 * requested city keeps using it, so nothing changes for a normal booking.
 *
 * WHAT THIS DOES NOT SOLVE, and someone should decide on it:
 * dispatch assigns vehicles by cityId. A Mysuru pickup priced against
 * Bengaluru will look for a Bengaluru vehicle, and that driver has 126 km to
 * travel before the trip starts. For an outstation operator that may be
 * exactly right. For a local one it is not, and the answer is a Mysuru city
 * row with its own fleet and rate cards.
 */
async function resolveOperatingCity(pickupPoint, requestedCity) {
  if (maps.isServiceable(pickupPoint, requestedCity).ok) {
    return { city: requestedCity, switched: false, distanceKm: 0 };
  }

  const cities = await cache.getOrSet(
    cache.keys.citiesActive(),
    () => prisma.city.findMany({ where: { isActive: true } }),
    { ttl: cache.TTL.STATIC },
  );

  if (!cities.length) {
    throw ApiError.badRequest('No service cities are configured', 'NO_SERVICE_CITY');
  }

  let nearest = null;
  let nearestKm = Infinity;

  for (const candidate of cities) {
    const km = geo.haversineKm(pickupPoint, {
      lat: Number(candidate.centreLat),
      lng: Number(candidate.centreLng),
    });
    if (km < nearestKm) {
      nearest = candidate;
      nearestKm = km;
    }
  }

  return {
    city: nearest,
    // True whenever the trip is priced by a city other than the one asked for,
    // so the response can say so rather than a rider wondering why a Mysuru
    // trip quotes Bengaluru rates.
    switched: nearest.id !== requestedCity.id,
    distanceKm: Number(nearestKm.toFixed(1)),
  };
}

async function getFareConfig(cityId, vehicleClass, tripType) {
  /*
   * Reject an unknown class BEFORE a cache key exists for it.
   *
   * The same ApiError as a genuinely missing rate card, on purpose: from the
   * caller's side "no such class" and "that class is not priced here" are the
   * same answer, and distinguishing them would tell a prober which classes are
   * real.
   */
  const { classes, cities } = await priceableSets();

  if (!classes.includes(vehicleClass) || !cities.includes(Number(cityId))) {
    throw ApiError.badRequest(
      `No fare configured for ${vehicleClass}`,
      'FARE_CONFIG_MISSING',
    );
  }

  const key = `${fareCfgPrefix(cityId, vehicleClass)}${tripType}`;

  const config = await cache.getOrSet(
    key,
    /*
     * TWO LEVELS, MOST SPECIFIC FIRST.
     *
     * fareLookup resolves the city's own card and, failing that, the card
     * scoped to its whole state. Within each level the most recent effective
     * row wins, so a future-dated rate card can be staged in advance and
     * activates by itself.
     *
     * The query used to live here inline. It moved because cancellation.service
     * had three near-copies of it that had already drifted, and a fourth copy
     * of a rule that now has a fallback step is a copy that quietly prices a
     * statewide city at nothing.
     */
    async () => fareLookup.findActiveCard({ cityId: Number(cityId), vehicleClass, tripType }),
    /*
     * cacheNull LEFT ON (the default), and that is the point.
     *
     * This key is `fare:cfg:{cityId}:{class}:{tripType}` and vehicleClass is
     * FREE TEXT from the request body — booking.schemas accepts any 2–24
     * character string, because a class added to the fleet must not need a
     * migration. So a loop posting random classes at /fares/options produces a
     * cache miss every time and a database query every time: textbook cache
     * penetration, on the hottest path in the system.
     *
     * Caching the "no such rate card" answer for 30 seconds turns a thousand
     * junk requests into one query. The short TTL is what makes it safe to
     * cache a negative at all — a rate card created in the admin panel is
     * live within half a minute even if the write-side invalidation were
     * somehow missed, and fareConfig.service invalidates explicitly anyway.
     */
    { ttl: cache.TTL.STATIC }
  );

  if (!config) {
    /*
     * Name the ACTUAL trip type.
     *
     * The old ternary said "one-way" for anything that was not a round trip,
     * so an AIRPORT booking with no rate card reported "No one-way fare
     * configured for sedan" — which sent whoever read it looking at the wrong
     * rate cards. That cost real time when airport trips first broke.
     */
    const label = {
      ONE_WAY: 'one-way',
      ROUND_TRIP: 'round trip',
      AIRPORT: 'airport',
      HOURLY: 'hourly rental',
    }[tripType] || String(tripType).toLowerCase();

    throw ApiError.badRequest(
      `No ${label} fare configured for ${vehicleClass}`,
      'FARE_CONFIG_MISSING'
    );
  }
  return config;
}

async function getCity(cityId) {
  /*
   * Same gate as getFareConfig, for the same reason: cityId is caller-supplied
   * and part of the key, so a sweep of arbitrary integers would mint a Redis
   * key per value. The set is tiny and already cached, so this costs nothing.
   */
  const { cities } = await priceableSets();
  if (!cities.includes(Number(cityId))) {
    throw ApiError.badRequest('City is not serviced', 'CITY_NOT_SERVICED');
  }

  const city = await cache.getOrSet(
    `city:${cityId}`,
    () => prisma.city.findFirst({ where: { id: Number(cityId), isActive: true } }),
    // Same reasoning as getFareConfig: cityId comes from the request, so a
    // sweep of arbitrary integers would otherwise reach the database on every
    // one. A 30-second negative answer closes it.
    { ttl: cache.TTL.STATIC }
  );
  if (!city) throw ApiError.badRequest('City is not serviced', 'CITY_NOT_SERVICED');
  return city;
}

/** Invalidate after an admin edits a rate card. */
/**
 * Clear the quotable-classes/cities gate.
 *
 * Exported so a city admin service — when one exists — can make a new city
 * quotable immediately rather than waiting out the TTL. Reaching for the key
 * name from another module would work and would rot the first time it changed.
 */
async function invalidatePriceable() {
  await cache.del(PRICEABLE_KEY);
}

/**
 * Clear the cached resolution for a rate card that just changed.
 *
 * @param {number|null} cityId        the card's city, for a CITY-scoped card
 * @param {string}      vehicleClass
 * @param {string}     [state]        the card's state, for a STATE-scoped card
 *
 * A STATEWIDE CARD HAS NO CACHE KEY OF ITS OWN. Keys are per city, because
 * that is what a quote asks for, so editing the Karnataka card has to clear
 * every Karnataka city individually — otherwise each of them serves the old
 * price for up to six hours and the admin sees their change take effect in
 * some cities and not others, which reads as a bug in the fare engine rather
 * than a cache.
 */
async function invalidateFareConfig(cityId, vehicleClass, state = null) {
  // A new class is quotable only once the gate knows about it, so this has to
  // go too — otherwise a rate card created in the admin panel is refused with
  // a message saying it does not exist.
  await invalidatePriceable();

  if (cityId != null) {
    await cache.delByPrefix(fareCfgPrefix(cityId, vehicleClass));
    return;
  }

  if (!state) return;

  const cities = await fareLookup.citiesInState(state, { includeInactive: true });
  await Promise.all(
    cities.map((c) => cache.delByPrefix(fareCfgPrefix(c.id, vehicleClass))),
  );
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
    /*
     * STATE, for assertPickupWithinServiceStates.
     *
     * A coordinate carries no state, so without this the point reached
     * serviceArea.checkPlace with `state` undefined and only the label to go
     * on. checkPlace falls back to substring-matching the formatted address,
     * which works right up until it does not: a label with no state in it
     * ("Kempegowda International Airport"), an abbreviation ("KA"), a name in
     * Kannada, or a point dropped on the map with no label at all. Every one
     * of those became OUTSIDE_SERVICE_STATES with `state: null` — a rider in
     * Koramangala told the fleet does not serve their area.
     *
     * THE LABEL IS TRIED FIRST, AND USUALLY ANSWERS.
     *
     * canonicalState is a local string match against the allowlist and costs
     * nothing. The app sends `address: p.address ?? p.label`, which for a
     * place picked from search normally contains the state already. Only when
     * that fails do we spend a billed reverse-geocode. Reversing
     * unconditionally would add a Google call to every quote for an answer we
     * already had in hand most of the time.
     *
     * The call is also what produces an HONEST refusal. A genuine pickup in
     * Tamil Nadu resolves to "Tamil Nadu" and the rider is told so by name,
     * rather than being shown the nonsense "pickup (null)".
     */
    /*
     * NOT named `label`. That is this function's own parameter ("pickup" /
     * "drop"), used by the INVALID_COORDINATES throw a few lines above; a
     * const of the same name in this block puts that reference in the
     * temporal dead zone and turns a clean 400 into a ReferenceError.
     */
    const addressLabel = input.address || null;
    let state = addressLabel ? await serviceArea.canonicalState(addressLabel) : null;
    let formattedAddress = addressLabel;

    if (!state) {
      /*
       * reverseGeocode does NOT throw on provider failure — it returns a
       * synthetic { provider: 'fallback' } row carrying the bare coordinates
       * as the address and NO state, and maps.service caches that for 30
       * days. So a try/catch here would catch nothing, and trusting the
       * result would poison this coordinate with a stateless answer for a
       * month after one transient Google error.
       *
       * Hence the provider check rather than a catch: a fallback row is
       * treated as "no answer" and leaves the label in place, which is
       * exactly the behaviour this path had before.
       */
      const reverse = await maps.reverseGeocode(point.lat, point.lng).catch(() => null);
      if (reverse && reverse.provider !== 'fallback') {
        state = reverse.state || null;
        // Only when it is a real address. The fallback's "12.93521, 77.62450"
        // would REPLACE a perfectly good human label with coordinates, and
        // checkPlace's own substring fallback would then have nothing to read.
        formattedAddress = reverse.formattedAddress || addressLabel;
      }
    }

    /*
     * `country` is deliberately absent. reverseGeocode returns no country
     * component, and assertWithinIndia already decides this path from the
     * bounding box. Inventing a null here changes nothing; claiming a country
     * we did not resolve would.
     */
    return { ...point, formattedAddress, state, source: 'coordinates' };
  }

  if (input.address) {
    const g = await maps.geocode(input.address);
    return {
      lat: g.lat,
      lng: g.lng,
      formattedAddress: g.formattedAddress,
      /*
       * THE STATE, which this function paid for and then threw away.
       *
       * google.maps.geocode already extracts administrative_area_level_1 from
       * the components of the response — the comment on the line below says
       * the country is carried "so the caller can decide" and the state was
       * extracted for exactly the same reason, but only the country was ever
       * returned. serviceArea.checkPlace was therefore left substring-matching
       * the formatted address for a value sitting right here, parsed and free.
       */
      state: g.state || null,
      // The geocoder already told us the country; carrying it lets
      // assertWithinIndia decide from the component rather than falling back
      // to parsing the address string or, worse, to the bounding box.
      country: g.country || null,
      source: 'geocoded',
    };
  }

  throw ApiError.badRequest(`Provide ${label} coordinates or an address`, 'LOCATION_REQUIRED');
}


/* ------------------------------------------------------------------ *
 * Service states
 * ------------------------------------------------------------------ */

/**
 * Refuse a trip that STARTS in a state the fleet does not operate in.
 *
 * ---------------------------------------------------------------------------
 * THE PICKUP IS THE GATE. THE DROP IS NOT.
 * ---------------------------------------------------------------------------
 * This used to check both endpoints, and refuse the route if either fell
 * outside the allowlist. That was the wrong shape of rule for what the
 * constraint actually is.
 *
 * What the allowlist encodes is where the fleet can SOURCE a car: where there
 * are drivers, a yard, permits taken out, and somewhere to recover a vehicle
 * that breaks down. All of that is a fact about the ORIGIN. A car starting in
 * Bengaluru can drive a customer to Chennai, Goa or Kochi and come back — it is
 * an outstation trip, the drivers do it, and the all-India permit already
 * covers it. Refusing it because Tamil Nadu is not on the list was turning
 * away revenue the fleet is equipped to earn.
 *
 * The reverse is not true and is why this check still exists. A pickup in
 * Chennai needs a car that is already in Chennai, and there is none, so no
 * quote can be honoured. That case still becomes a booking request, where an
 * admin can decide by hand whether to deadhead a car out to it.
 *
 * Checked SEPARATELY from maps.isServiceable, which asks a different question:
 * that one measures distance from a city centre, which is right for selecting
 * a rate card and wrong for deciding jurisdiction.
 *
 * Throws OUTSIDE_SERVICE_STATES, a code the app keys on to offer "send a
 * booking request" instead of a fare. The offending state and the allowlist
 * both travel in `details`, so the app can name them without hardcoding a list
 * that would drift the day a fifth state opens.
 *
 * @param {{lat:number, lng:number, formattedAddress?:string|null}} pickupPoint
 */
/**
 * Refuse a trip that leaves the country.
 *
 * THE ONLY LIMIT ON HOW FAR A TRIP MAY GO. The straight-line cap that used to
 * sit in maps.getDistance is gone — see src/lib/india.js for why a kilometre
 * number was the wrong rule. Bengaluru to Delhi, Kochi to Guwahati, anything
 * the customer wants: if both ends are in India the fare engine prices it.
 *
 * Checked for EVERY point, not just the drop. A stop is somewhere the car is
 * actually driven to, so a stop abroad makes the route as impossible as a drop
 * abroad would; omitting stops here would have left a hole that any route with
 * a waypoint could be pushed through.
 *
 * Deliberately NOT folded into assertPickupWithinServiceStates. That one says
 * where the fleet chooses to operate and an admin changes it from the admin
 * panel; this one says what is physically drivable and no admin should be able
 * to switch it off. They also fail differently: an out-of-state pickup offers a
 * booking request, and this offers nothing, because there is no road and no
 * amount of human follow-up creates one.
 *
 * @param {{label:string, point:object|null}[]} points
 */
function assertWithinIndia(points) {
  for (const { label, point } of points) {
    if (!point) continue;

    const check = india.checkInIndia(point);
    if (check.ok) continue;

    const where = check.country ? ` — it looks like ${check.country}` : '';
    throw new ApiError(
      400,
      'OUTSIDE_INDIA',
      `We only operate within India. Your ${label} is outside the country${where}. ` +
        'Please choose a location in India.',
      {
        /*
         * Same shape as OUTSIDE_SERVICE_STATES.details so the rider app can
         * name the offending endpoint with the component it already has. There
         * is no canRequest here on purpose: an admin cannot drive to Colombo
         * either, and offering a callback would be promising something nobody
         * can deliver.
         */
        offending: [{ label, state: check.country || null }],
        canRequest: false,
      },
    );
  }
}

async function assertPickupWithinServiceStates(pickupPoint) {
  if (!pickupPoint) return;

  const check = await serviceArea.checkPlace(pickupPoint);
  if (check.ok) return;

  const allowed = await serviceArea.allowedStateNames();

  /*
   * Still an ARRAY, still labelled "pickup".
   *
   * The rider app reads details.offending and renders "Your pickup (Tamil
   * Nadu) is outside our service area" from it, and bookingRequest.create
   * reads the same labels back. Collapsing it to a scalar here would have
   * meant a coordinated app release for a server-side rule change, and every
   * build already in the field would have rendered an empty sentence.
   */
  const offending = [{ label: 'pickup', state: check.state }];
  const named = check.state ? `pickup (${check.state})` : 'pickup';

  throw new ApiError(
    400,
    'OUTSIDE_SERVICE_STATES',
    `We do not pick up from that area yet — ${named}. We currently pick up in ` +
      `${allowed.join(', ')}, and can drop anywhere from there. ` +
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
    throw ApiError.badRequest('A round trip needs a return date', 'RETURN_TIME_REQUIRED');
  }
  if (tripType === 'HOURLY' && !rentalPackageId && !rentalHours) {
    throw ApiError.badRequest('An hourly rental needs a package or a number of hours', 'RENTAL_TERMS_REQUIRED');
  }

  /*
   * DATES, NOT INSTANTS.
   *
   * A round trip carries a return DATE now — the time picker is gone, because
   * nothing priced off it (the fare counts calendar days) and it could move
   * the night allowance on a round trip for no reason the rider could see.
   *
   * So the old `returnAt <= pickupAt` test is wrong twice over. It rejects a
   * same-day return, which is the commonest round trip there is; and the error
   * it produces talks about a return TIME the rider was never shown. The
   * comparison that matters is whether the return date is on or after the
   * pickup's date, in the city's own timezone.
   *
   * The city is not loaded yet at this point, so the check runs in the default
   * zone and the value is re-normalised against the real city timezone further
   * down, once `city` is resolved. Both markets are IST today, so the two
   * agree; the re-normalisation is what keeps that true if they ever do not.
   */
  if (returnAt && !returnDateIsValid(returnAt, pickupAt)) {
    throw ApiError.badRequest(
      'The return date cannot be before the pickup date',
      'INVALID_RETURN_DATE',
    );
  }

  /* -- 1. city + service area, before spending anything -- */

  let city = await getCity(cityId);

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

  /*
   * Two checks, in this order, before a single kilometre is looked up.
   *
   * COUNTRY first: it is synchronous, it needs no database, and a point
   * outside India fails every later assumption anyway. There is no distance
   * cap any more — this is what stops an absurd destination.
   *
   * STATE second: a trip STARTING where the fleet has no cars is refused with
   * a code the app turns into "send a booking request". The drop is
   * deliberately not state-checked — a car sourced from a state we serve may
   * drive anywhere in India, and refusing those was turning away outstation
   * work.
   */
  assertWithinIndia([
    { label: 'pickup', point: pickupPoint },
    // null for HOURLY, which has no destination — skipped.
    { label: 'drop', point: dropPoint || null },
    ...stopPoints.map((p, i) => ({ label: `stop ${i + 1}`, point: p })),
  ]);

  await assertPickupWithinServiceStates(pickupPoint);

  /*
   * The radius SELECTS a city now, it does not gate the trip.
   *
   * The state check above already decided whether we operate here. This picks
   * whose rate cards apply, falling back to the nearest active city when the
   * pickup is outside the one the app asked for.
   */
  const operating = await resolveOperatingCity(pickupPoint, city);
  city = operating.city;

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
  /*
   * The DROP travels too, for the corridor rules (surge_routes): a festival
   * premium is a property of the journey, not of the pickup. Null for HOURLY,
   * which has no destination — matchRoute returns null for that and the tier
   * premium is the only one that can apply.
   */
  const surgeInfo = await surgeService.resolveSurge({
    pickupPoint,
    dropPoint,
    pickupAt,
    requestedSurge: surge,
  });

  const localSwitch = await resolveLocalSwitch(
    tripType, pickupPoint, dropPoint, city, rentalPackageId,
  );

  // See the matching guard in the fare-list path: a rental with no package has
  // no fare, and inventing one would quote terms the rider never chose.
  if (localSwitch && localSwitch.needsPackage) {
    throw new ApiError(409, 'LOCAL_PACKAGE_REQUIRED', localSwitch.message, {
      switchedToLocal: localSwitch,
    });
  }

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
      ? await maps.getPathDistance([pickupPoint, ...stopPoints, dropPoint])
      : await maps.getDistance(pickupPoint, dropPoint);

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

  /*
   * The return date, pinned to a fixed hour on its own calendar day in the
   * CITY's timezone.
   *
   * Done here, after `city` is resolved, rather than trusting whatever instant
   * the client sent. Two things depend on it and both must agree with what is
   * eventually stored on the booking:
   *
   *   chargeableDays  counts calendar days between pickup and return, which
   *                   drives the driver allowance and the min-km-per-day
   *                   guarantee;
   *   touchesNight    asks whether either END of the trip falls in the night
   *                   window — and before this, an arbitrary client-supplied
   *                   time could put the return inside it and add a night
   *                   allowance to a trip that returns at noon.
   *
   * Normalising means an older app build still sending a full timestamp prices
   * a round trip identically to a new one that sends only a date.
   */
  const normalisedReturnAt =
    effectiveTripType === 'ROUND_TRIP'
      ? normaliseReturnDate(returnAt, city.timezone, pickupAt)
      : null;

  // The city's IANA timezone decides the night window and the calendar-day
  // count. Without it the fare would follow the SERVER's timezone, so the same
  // booking would price differently on a Bengaluru laptop and a UTC server.
  const priced = fare.computeFare(
    {
      tripType: effectiveTripType,
      distanceKm, durationMin, pickupAt,
      // A switched trip has no return leg to price.
      returnAt: localSwitch ? null : normalisedReturnAt,
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
      /** METRO | DISTRICT | TALUKA | VILLAGE, and the named area it matched. */
      tier: surgeInfo.tier,
      area: surgeInfo.area,
      /**
       * The corridor rule that set the price, when one did — so the app can
       * name the festival rather than showing an unexplained premium.
       */
      route: surgeInfo.route ?? null,
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
      /*
       * The NORMALISED return, not the raw input — this is the instant the
       * fare above was actually computed against, and the one the booking will
       * store. Echoing the client's own value back would let a quote and the
       * booking made from it disagree about when the trip ends, which is the
       * kind of discrepancy that only surfaces in a dispute months later.
       * Null for anything that is not a round trip.
       */
      returnAt: normalisedReturnAt ? normalisedReturnAt.toISOString() : null,
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
  let city = await getCity(input.cityId);

  const [pickupPoint, dropPoint] = await Promise.all([
    resolveLocation(input.pickup, 'pickup'),
    resolveLocation(input.drop, 'drop'),
  ]);

  // This endpoint compares ONE_WAY against ROUND_TRIP for the same route, so a
  // same-place request is meaningless for the half of the comparison that is
  // point-to-point. Guarded as ONE_WAY.
  assertDistinctEndpoints('ONE_WAY', pickupPoint, dropPoint);

  /*
   * Two checks, in this order, before a single kilometre is looked up.
   *
   * COUNTRY first: it is synchronous, it needs no database, and a point
   * outside India fails every later assumption anyway. There is no distance
   * cap any more — this is what stops an absurd destination.
   *
   * STATE second: a trip STARTING where the fleet has no cars is refused with
   * a code the app turns into "send a booking request". The drop is
   * deliberately not state-checked — a car sourced from a state we serve may
   * drive anywhere in India, and refusing those was turning away outstation
   * work.
   */
  assertWithinIndia([
    { label: 'pickup', point: pickupPoint },
    { label: 'drop', point: dropPoint || null },
  ]);

  await assertPickupWithinServiceStates(pickupPoint);

  // Same rule as the single-class quote: nearest city prices it, the state
  // check decides whether we operate here at all.
  const operating = await resolveOperatingCity(pickupPoint, city);
  city = operating.city;

  // This endpoint exists to compare ONE_WAY against ROUND_TRIP for one route.
  // Both are outstation products, so a same-city drop leaves nothing to
  // compare — and unlike a quote there is no single answer to switch TO.
  if (isDropInsideCity(dropPoint, city)) {
    throw ApiError.badRequest(
      `Both points are in ${city.name}. Ask for a local rental quote instead.`,
      'DROP_INSIDE_PICKUP_CITY'
    );
  }

  const route = await maps.getDistance(pickupPoint, dropPoint);

  /*
   * Surge, resolved exactly as getQuote and quoteAllClasses do — on the PICKUP
   * point. Both price lines below read surgeInfo.surge, but it was never
   * defined in this function, so every comparison request threw
   * "surgeInfo is not defined" (found by a no-undef lint pass; it had been
   * hidden behind the geocode failure that broke the same routes).
   */
  const surgeInfo = await surgeService.resolveSurge({
    pickupPoint,
    dropPoint,
    pickupAt: input.pickupAt,
    requestedSurge: input.surge,
  });

  const [oneWayConfig, roundConfig] = await Promise.all([
    getFareConfig(input.cityId, input.vehicleClass, 'ONE_WAY').catch(() => null),
    getFareConfig(input.cityId, input.vehicleClass, 'ROUND_TRIP').catch(() => null),
  ]);

  /*
   * This endpoint compares a one-way against a round trip for the same route,
   * so the round-trip half needs a return even when the caller is only asking
   * "what would the other product cost?" and has not chosen one.
   *
   * The fallback is the SAME DAY rather than the ten-hours-later instant it
   * used to invent. Ten hours past a 14:00 pickup is midnight, which crosses
   * into the next calendar day — and the fare counts calendar days, so the
   * comparison silently quoted TWO days of driver allowance and twice the
   * min-km-per-day guarantee against a one-way that got neither. The round
   * trip looked worse than it is, on a screen whose entire purpose is to
   * compare the two fairly.
   *
   * Normalised either way, so a caller-supplied return prices here exactly as
   * it will in getQuote.
   */
  const returnAt = normaliseReturnDate(
    input.returnAt || input.pickupAt,
    city.timezone,
    input.pickupAt,
  );

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
  let city = await getCity(input.cityId);

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

  /*
   * INTERMEDIATE STOPS — the same resolution the single-class quote() does.
   *
   * This function did not read input.stops at all. It priced pickup → drop in
   * a straight line while quote(), which runs at BOOKING time, routed through
   * every stop. So a trip with a stop was quoted on the direct distance and
   * then created at the real one, and the two numbers had no relationship the
   * rider could see.
   *
   * Hebbal → Gulbarga → Hubli is the case that exposed it: the fare list
   * showed 409 km (Hebbal to Hubli direct) and the booking was made at 948 km.
   * The rider agreed to Rs 15,525 and was charged against Rs 36,019.
   *
   * Ignored for HOURLY, which prices from the package rather than the route.
   */
  const stopPoints = isHourly
    ? []
    : await Promise.all(
        (input.stops || []).map((st, i) => resolveLocation(st, `stop ${i + 1}`))
      );

  /*
   * Two checks, in this order, before a single kilometre is looked up.
   *
   * COUNTRY first: it is synchronous, it needs no database, and a point
   * outside India fails every later assumption anyway. There is no distance
   * cap any more — this is what stops an absurd destination.
   *
   * STATE second: a trip STARTING where the fleet has no cars is refused with
   * a code the app turns into "send a booking request". The drop is
   * deliberately not state-checked — a car sourced from a state we serve may
   * drive anywhere in India, and refusing those was turning away outstation
   * work.
   */
  assertWithinIndia([
    { label: 'pickup', point: pickupPoint },
    // null for HOURLY, which has no destination — skipped.
    { label: 'drop', point: dropPoint || null },
    ...stopPoints.map((p, i) => ({ label: `stop ${i + 1}`, point: p })),
  ]);

  await assertPickupWithinServiceStates(pickupPoint);

  // Same rule as the single-class quote: nearest city prices it, the state
  // check decides whether we operate here at all.
  const operating = await resolveOperatingCity(pickupPoint, city);
  city = operating.city;

  // An outstation request that never leaves the city becomes a local rental.
  // Everything below prices the LOCAL product and the switch is reported back.
  // One decision for the whole list — every class on the screen must show the
  // same urgency, or the surge looks like it depends on the car.
  const surgeInfo = await surgeService.resolveSurge({
    pickupPoint,
    dropPoint,
    pickupAt: input.pickupAt,
    requestedSurge: input.surge,
  });

  const localSwitch = await resolveLocalSwitch(
    input.tripType, pickupPoint, dropPoint, city, input.rentalPackageId,
  );

  /*
   * A switch with no package chosen cannot be priced, because a rental's fare
   * IS its package. Rather than guess a package and show a fare for terms the
   * rider never agreed to, refuse and hand back everything the app needs to
   * ask: the notice copy and the list of packages.
   *
   * 409 rather than 400 — nothing about the request was malformed. It is a
   * conflict between the product asked for and the trip described, and it is
   * resolved by the rider answering one question, not by fixing a field.
   */
  if (localSwitch && localSwitch.needsPackage) {
    throw new ApiError(409, 'LOCAL_PACKAGE_REQUIRED', localSwitch.message, {
      switchedToLocal: localSwitch,
    });
  }

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

  /*
   * HOURLY prices from the package, so the distance lookup is skipped (and its
   * SAME_LOCATION guard when drop == pickup).
   *
   * With stops, the route is pickup → stop₁ → … → drop and getPathDistance
   * sums the legs — each leg Redis-cached exactly like a plain pickup→drop
   * lookup, so a multi-stop quote costs no more maps quota on a repeat.
   *
   * This mirrors quote() deliberately. The two functions answer the same
   * question for one class and for many, and any difference between them shows
   * up as a fare that changes between the screen and the booking.
   */
  const route = isHourlyNow
    ? { distanceKm: 0, durationMin: 0, provider: 'none', estimated: false }
    : stopPoints.length
      ? await maps.getPathDistance([pickupPoint, ...stopPoints, dropPoint])
      : await maps.getDistance(pickupPoint, dropPoint);

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
  /*
   * BOTH SCOPES, because this screen must show what the rider can actually
   * book — and in a city priced only by its state's cards, filtering on
   * cityId alone returns nothing and the fare screen comes up empty with no
   * error to explain it.
   *
   * `city` here is the OPERATING city resolved above, not input.cityId, which
   * may be the city the rider asked for rather than the one pricing the trip.
   */
  const scopeKeys = [fareLookup.cityScopeKey(city.id)];
  if (city.state) scopeKeys.push(fareLookup.stateScopeKey(city.state));

  const [configs, visible] = await Promise.all([
    prisma.fareConfig.findMany({
      where: {
        scopeKey: { in: scopeKeys },
        tripType: effectiveTripType,
        isActive: true,
        effectiveFrom: { lte: new Date() },
      },
      orderBy: { effectiveFrom: 'desc' },
    }),
    prisma.vehicleCatalog.findMany({ where: { isActive: true }, select: { key: true } }),
  ]);
  const visibleClasses = new Set(visible.map((v) => v.key));

  /*
   * One row per class: its own city card if it has one, otherwise the state
   * card. Sorted here rather than in SQL so the precedence rule is written in
   * the same words as fareLookup's — a city card wins outright, and dates only
   * break ties within one scope.
   */
  const ranked = configs
    .filter((c) => visibleClasses.has(c.vehicleClass))
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'CITY' ? -1 : 1;
      return new Date(b.effectiveFrom) - new Date(a.effectiveFrom);
    });

  const seen = new Set();
  const latest = ranked.filter((c) => {
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

  /*
   * Normalised ONCE, outside the loop, exactly as getQuote does it.
   *
   * This path and getQuote must agree to the rupee: this one prices the list
   * the rider chooses from, and getQuote prices the booking they then make. A
   * raw client timestamp here and a normalised one there would put the two
   * trips on different calendar-day counts, and the fare would change between
   * the screen and the confirmation for no reason the rider could see. That
   * class of mismatch is what the stops bug in this same function was.
   *
   * Outside the loop because the answer cannot vary by vehicle class, and
   * fifteen identical timezone conversions per request is work for nothing.
   */
  const normalisedReturnAt =
    effectiveTripType === 'ROUND_TRIP'
      ? normaliseReturnDate(input.returnAt, city.timezone, input.pickupAt)
      : null;

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
            returnAt: normalisedReturnAt,
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

  /*
   * TAX, PER OPTION.
   *
   * Attached at quote time so the rider can see what GST is embedded in the
   * price BEFORE booking, rather than meeting it for the first time on the
   * invoice. Resolved through gst.service, which is the same path
   * billing.service uses at invoice time — two copies of this arithmetic would
   * eventually disagree, and the one the customer saw would not be the one
   * they were billed.
   *
   * On the default INCLUSIVE setting `tax.total` equals the fare's own total,
   * so nothing about pricing changes; the tax is information, not an addition.
   * If an admin switches a rate to exclusive, `tax.total` is what is actually
   * payable and the app shows that.
   *
   * Resolved once per trip, not per option: the rate depends on trip type and
   * pickup state, neither of which varies across the vehicle list. Only the
   * amount differs, so applyGst is what runs per option.
   */
  const taxRate = await gst.resolveRate(effectiveTripType, city.state, input.accountType);
  const splitKind = await gst.resolveSplitKind(city.state, dropPoint?.state || null);

  for (const opt of options) {
    const applied = gst.applyGst(opt.total, taxRate, splitKind);
    opt.tax = {
      ratePct: applied.ratePct,
      isInclusive: applied.isInclusive,
      applies: taxRate.applies,
      splitKind,
      amount: M.toStr(applied.tax),
      taxable: M.toStr(applied.taxable),
      // What the rider actually pays. Same as opt.total when inclusive.
      payable: M.toStr(applied.total),
    };
  }

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
      /** METRO | DISTRICT | TALUKA | VILLAGE, and the named area it matched. */
      tier: surgeInfo.tier,
      area: surgeInfo.area,
      /**
       * The corridor rule that set the price, when one did — so the app can
       * name the festival rather than showing an unexplained premium.
       */
      route: surgeInfo.route ?? null,
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
  invalidatePriceable,
  resolveLocation,
};