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
// Decides whether two addresses name the same town, independently of whether
// that town has a row in `cities`. See the header of lib/locality.js.
const locality = require('../lib/locality');
// Owns the empty-means-all rule for vehicle_catalog.trip_types. Required here
// rather than reimplemented: a second copy of that rule is a copy that reads
// an empty list as "bookable for nothing" the first time someone forgets.
const vehicleCatalog = require('./vehicleCatalog.service');
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

/* ------------------------------------------------------------------ *
 * Same-city detection that does not need a `cities` row
 * ------------------------------------------------------------------ */

/**
 * How far apart two points may be and still count as one town.
 *
 * The locality test below compares NAMES, and a name has no size. Google
 * sometimes answers with administrative_area_level_2 — a district, not a city
 * — when a village has no locality of its own, and a district can be 150 km
 * across. Without a ceiling, two villages at opposite ends of one district
 * would read as a local trip and be sold a four-hour rental that cannot
 * possibly serve them.
 *
 * 60 km is wider than any Indian metro end to end (Bengaluru is ~50 km across
 * at its longest) and well short of a district. It bounds the NAME test only;
 * the radius test below has the city's own localRadiusKm to bound it.
 */
const MAX_LOCAL_TRIP_KM = 60;

/**
 * The town a point is in, or null.
 *
 * Prefers what resolveLocation already attached, because that came from a
 * geocode we have already paid for. Falls back to a reverse lookup, which is
 * Redis-cached for 30 days and is therefore free on every repeat of a popular
 * pickup.
 *
 * NEVER THROWS. A provider outage must degrade local-trip detection to the
 * radius test, not fail the quote — the rider still has a trip to take.
 */
async function localityOf(point) {
  if (!point) return null;
  if (point.city) return point.city;

  const reverse = await maps.reverseGeocode(point.lat, point.lng).catch(() => null);
  // A 'fallback' row is maps.service's synthetic answer for a dead provider.
  // It carries coordinates as the address and no components, so believing it
  // would cache a null town against this coordinate for a month.
  if (!reverse || reverse.provider === 'fallback') return null;
  return reverse.city || null;
}

/**
 * The nearest active city row to a point, whether or not it is priced.
 *
 * Deliberately NOT resolveOperatingCity. That one answers "whose rate card
 * applies", and it will happily skip past a nearer city to find a priced one —
 * correct for pricing, wrong here. The question this answers is geometric:
 * which configured city, if any, is this point actually in.
 */
async function activeCityById(id) {
  const cities = await cache.getOrSet(
    cache.keys.citiesActive(),
    () => prisma.city.findMany({ where: { isActive: true } }),
    { ttl: cache.TTL.STATIC },
  );
  return cities.find((c) => Number(c.id) === Number(id)) || null;
}

async function nearestActiveCity(point) {
  const cities = await cache.getOrSet(
    cache.keys.citiesActive(),
    () => prisma.city.findMany({ where: { isActive: true } }),
    { ttl: cache.TTL.STATIC },
  );
  if (!cities.length) return null;

  let best = null;
  let bestKm = Infinity;
  for (const candidate of cities) {
    const km = geo.haversineKm(point, {
      lat: Number(candidate.centreLat),
      lng: Number(candidate.centreLng),
    });
    if (km < bestKm) {
      bestKm = km;
      best = candidate;
    }
  }
  return best;
}

/**
 * Is this outstation request actually a trip within one town?
 *
 * TWO INDEPENDENT SIGNALS, NAME FIRST.
 *
 * 1. THE LOCALITY NAMES MATCH. Works in any town in India, including one the
 *    business has never priced and has no row for. This is the signal that
 *    was missing, and its absence is the whole bug: a Hyderabad pickup with a
 *    Hyderabad drop fell through to the Bengaluru row — the only row there is
 *    — sat 500 km outside it, and was sold as an outstation one-way.
 *
 * 2. BOTH POINTS INSIDE A CONFIGURED CITY'S LIMITS. The original test, kept
 *    because it catches what the first one misses: a suburb the geocoder
 *    names as its own locality. Whitefield and Koramangala come back as
 *    different localities and are plainly one Bengaluru trip, and only the
 *    radius knows that.
 *
 * Either one is enough. Requiring both would reintroduce the row dependency
 * through the back door.
 *
 * @returns {Promise<{cityName: string, reason: string, apartKm: number}|null>}
 */
async function detectSameCityTrip(tripType, pickupPoint, dropPoint, operatingCity) {
  if (!REQUIRES_OUTSTATION_DROP.has(tripType)) return null;
  if (!pickupPoint || !dropPoint) return null;

  const apartKm = geo.haversineKm(pickupPoint, dropPoint);

  /* -- signal 1: the geocoder named the same town at both ends -- */

  // Only worth paying for when the trip is short enough to BE local. A
  // 400 km run cannot be, so there is no reason to reverse-geocode it.
  if (apartKm <= MAX_LOCAL_TRIP_KM) {
    const [pickupCity, dropCity] = await Promise.all([
      localityOf(pickupPoint),
      localityOf(dropPoint),
    ]);

    // sameCity returns null — not false — when either name is missing, which
    // is why this is an explicit `=== true`. An unknown must fall through to
    // the radius test rather than being read as "different towns".
    if (locality.sameCity(pickupCity, dropCity) === true) {
      return {
        cityName: locality.displayName(pickupCity, dropCity),
        reason: 'SAME_LOCALITY',
        apartKm: Number(apartKm.toFixed(1)),
      };
    }
  }

  /* -- signal 2: both ends inside one configured city's limits -- */

  /*
   * The OPERATING city is tried first, then the geographically nearest row.
   *
   * They are usually the same. They differ when resolveOperatingCity skipped
   * past the nearest city because it had no rate card for this trip type —
   * and in that case the nearest row is the one that actually knows where the
   * town ends.
   */
  const candidates = [];
  if (operatingCity) candidates.push(operatingCity);
  const nearest = await nearestActiveCity(pickupPoint);
  if (nearest && (!operatingCity || nearest.id !== operatingCity.id)) candidates.push(nearest);

  for (const candidate of candidates) {
    if (isSameCityTrip(pickupPoint, dropPoint, candidate)) {
      return {
        cityName: candidate.name,
        reason: 'INSIDE_CITY_LIMITS',
        apartKm: Number(apartKm.toFixed(1)),
      };
    }
  }

  return null;
}

/**
 * Which city's rental packages can serve a local trip here.
 *
 * rental_packages is keyed on cityId with NO statewide fallback, unlike
 * fare_configs — which fareLookup resolves city-then-state. So a town with a
 * city row but no packages had nothing to switch to and the quote died with
 * LOCAL_UNAVAILABLE, and a town with no row at all never got this far.
 *
 * Order: the operating city, then the nearest city IN THE SAME STATE that has
 * packages, then nothing. The state boundary is deliberate — packages encode
 * local hourly rates and a permit regime, and borrowing Karnataka's package
 * prices for a Telangana trip would quote a rate nobody set.
 *
 * @returns {Promise<object|null>} a city row, or null when nowhere can serve it
 */
async function resolveRentalCity(city) {
  const own = await prisma.rentalPackage.count({
    where: { cityId: Number(city.id), isActive: true },
  });
  if (own > 0) return city;

  if (!city.state) return null;

  const siblings = await prisma.city.findMany({
    where: {
      isActive: true,
      state: city.state,
      id: { not: Number(city.id) },
      rentalPackages: { some: { isActive: true } },
    },
  });
  if (!siblings.length) return null;

  const centre = { lat: Number(city.centreLat), lng: Number(city.centreLng) };
  siblings.sort(
    (a, b) =>
      geo.haversineKm(centre, { lat: Number(a.centreLat), lng: Number(a.centreLng) }) -
      geo.haversineKm(centre, { lat: Number(b.centreLat), lng: Number(b.centreLng) }),
  );
  return siblings[0];
}

/**
 * An outstation request that never leaves town is answered with a LOCAL
 * rental instead of an error.
 *
 * Rejecting would be easier and worse. The rider has a real, serviceable
 * journey in mind — they have simply chosen the wrong product for it, usually
 * because Outstation is the tab they happened to land on. An error asks them
 * to work out which tab they should have used; switching answers the question
 * they were actually asking and tells them what changed.
 *
 * ---------------------------------------------------------------------------
 * THREE OUTCOMES, AND THE THIRD IS THE NEW ONE
 * ---------------------------------------------------------------------------
 *   null                      not a local trip. Price what was asked for.
 *   { applied: true, ... }    switch to HOURLY. Needs a package, or has one.
 *   { applied: false, ... }   it IS a local trip, but no rental product exists
 *                             to serve it. Price what was asked for, and SAY
 *                             SO in the response.
 *
 * The third case used to throw LOCAL_UNAVAILABLE, and that was the wrong
 * trade. A town the client genuinely serves but has not yet given rental
 * packages would have every short trip in it refused outright — a configuration
 * gap turned into an outage, visible to the rider as "we cannot take you
 * 8 km". Pricing it as asked is imperfect (an outstation card on a city hop
 * overcharges) but it is a sale, it is what happens today, and the notice in
 * the response plus the server-side warning is what gets the packages added.
 *
 * ---------------------------------------------------------------------------
 * THE RIDER CHOOSES THE PACKAGE. WE DO NOT.
 * ---------------------------------------------------------------------------
 * This once picked the shortest active package and quoted on it. A rental is
 * sold by DURATION, and the shortest one is only right if the rider happens to
 * be done in four hours. Nobody asked them. So with no package chosen the
 * switch is reported with the available packages attached and the app asks;
 * the answer comes back as chosenPackageId on the next quote.
 */
async function resolveLocalSwitch(tripType, pickupPoint, dropPoint, city, chosenPackageId) {
  const detected = await detectSameCityTrip(tripType, pickupPoint, dropPoint, city);
  if (!detected) return null;

  const cityName = detected.cityName || city.name;

  /*
   * WHICH city's packages, which is not necessarily the operating one.
   *
   * See resolveRentalCity: packages have no statewide fallback, so a town
   * priced by a state card can easily have rate cards and no packages.
   */
  const rentalCity = await resolveRentalCity(city);

  if (!rentalCity) {
    console.warn(
      `[quote] ${cityName} is a local trip (${detected.reason}, ${detected.apartKm} km apart) ` +
      `but no active rental packages exist for ${city.name}${city.state ? `, ${city.state}` : ''}. ` +
      `Pricing as ${tripType}. Add rental packages for this city to enable the local product.`,
    );

    return {
      applied: false,
      unavailable: true,
      from: tripType,
      to: 'HOURLY',
      reason: detected.reason,
      cityName,
      title: 'Local trip',
      message:
        `Both your pickup and drop-off are in ${cityName}. We do not offer a local ` +
        `rental here yet, so this is priced as an outstation trip.`,
      packages: [],
      needsPackage: false,
      rentalPackageId: null,
      rentalPackageLabel: null,
      rentalHours: null,
    };
  }

  // Distinct labels, cheapest row per label, shortest first — the same shape
  // the rental picker already renders, so the app can show these directly.
  const packages = await prisma.rentalPackage.findMany({
    where: { cityId: Number(rentalCity.id), isActive: true },
    orderBy: [{ includedHours: 'asc' }, { packageFare: 'asc' }],
  });

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

  const chosen = chosenPackageId
    ? byLabel.find((p) => p.rentalPackageId === Number(chosenPackageId)) ?? null
    : null;

  const base = {
    applied: true,
    unavailable: false,
    from: tripType,
    to: 'HOURLY',
    /*
     * WHY it switched, not just that it did. SAME_LOCALITY means the geocoder
     * named one town at both ends; INSIDE_CITY_LIMITS means both pins fell
     * inside a configured city's radius. When a rider disputes a switch, this
     * is the field that explains it without re-running the trip.
     */
    reason: detected.reason,
    cityName,
    /*
     * The city whose packages and HOURLY rate card price this, which is NOT
     * always the city the trip is in — see resolveRentalCity. Returned so the
     * booking call can send it back and the two steps cannot disagree.
     */
    rentalCityId: rentalCity.id,
    rentalCityName: rentalCity.name,
    // Copy for the app to show. Written here rather than in the client so
    // every surface says the same thing.
    title: 'Switched to Local',
    message:
      `Both your pickup and drop-off are in ${cityName}, so this is a ` +
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
 * active city that can actually PRICE the trip wins, and its rate cards price
 * the journey. A pickup inside the requested city keeps using it, so nothing
 * changes for a normal booking.
 *
 * ---------------------------------------------------------------------------
 * WHY "NEAREST" ALONE WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * This used to take the nearest active city unconditionally, with no regard
 * for whether that city had a single rate card. A city row is created from the
 * admin panel and `copyFromCityId` is OPTIONAL, so an admin opening Telangana
 * by adding a Hyderabad row — the obvious, correct-looking thing to do —
 * produced a city with no rate cards and no statewide Telangana card behind
 * it.
 *
 * Every Hyderabad pickup then resolved to that empty city, the fare-options
 * query over [city:hyderabad, state:telangana] matched nothing, and
 * quoteAllClasses returned `options: []` with a 200. The rider app has no way
 * to tell an empty list from a priced one, so it rendered "No rides available
 * for this route right now" — geography, for what was a pricing-coverage
 * problem. The reverse direction (Bengaluru pickup) kept working, because that
 * pickup is inside Bengaluru's own radius and never reached this function.
 *
 * So the nearest city is now the nearest city WITH COVERAGE for the trip type
 * being priced: its own CITY card, or a STATE card for its state. A pickup in
 * a serviced state is always priced by something rather than silently falling
 * into a hole. If nothing anywhere is priced for that trip type, the plain
 * nearest city is returned and the caller raises FARE_CONFIG_MISSING, which
 * names the problem instead of hiding it.
 *
 * WHAT THIS DOES NOT SOLVE, and someone should decide on it:
 * dispatch assigns vehicles by cityId. A Mysuru pickup priced against
 * Bengaluru will look for a Bengaluru vehicle, and that driver has 126 km to
 * travel before the trip starts. For an outstation operator that may be
 * exactly right. For a local one it is not, and the answer is a Mysuru city
 * row with its own fleet and rate cards.
 */

/**
 * Active cities that have a live rate card for `tripType` — their own, or one
 * scoped to their state.
 *
 * Resolved in JS against a distinct list of scope keys rather than per city,
 * because the whole point is to answer "which of these twenty cities can quote
 * an ONE_WAY right now" in one round trip. Cached for the same 50 seconds as
 * priceableSets, and for the same reason: a rate card added in the admin panel
 * must become bookable within the minute without a restart, and
 * invalidateFareConfig clears it explicitly anyway.
 */
const PRICED_CITIES_KEY = (tripType) => `fare:pricedcities:v1:${tripType}`;

async function citiesWithPricing(tripType) {
  return cache.getOrSet(
    PRICED_CITIES_KEY(tripType),
    async () => {
      const [cities, cards] = await Promise.all([
        prisma.city.findMany({
          where: { isActive: true },
          select: { id: true, state: true },
        }),
        prisma.fareConfig.findMany({
          where: { tripType, isActive: true, effectiveFrom: { lte: new Date() } },
          select: { scopeKey: true },
          distinct: ['scopeKey'],
        }),
      ]);

      const keys = new Set(cards.map((c) => c.scopeKey));

      return cities
        .filter(
          (c) =>
            keys.has(fareLookup.cityScopeKey(c.id)) ||
            (c.state && keys.has(fareLookup.stateScopeKey(c.state))),
        )
        .map((c) => c.id);
    },
    { ttl: 50 },
  );
}

/**
 * @param {object}      pickupPoint
 * @param {object}      requestedCity
 * @param {string|null} tripType  the product being priced. Omitted only by
 *   callers that genuinely do not know it yet; without it the old
 *   nearest-city-wins behaviour applies.
 */
async function resolveOperatingCity(pickupPoint, requestedCity, tripType = null) {
  if (maps.isServiceable(pickupPoint, requestedCity).ok) {
    return { city: requestedCity, switched: false, distanceKm: 0, pricedFallback: false };
  }

  const cities = await cache.getOrSet(
    cache.keys.citiesActive(),
    () => prisma.city.findMany({ where: { isActive: true } }),
    { ttl: cache.TTL.STATIC },
  );

  if (!cities.length) {
    throw ApiError.badRequest('No service cities are configured', 'NO_SERVICE_CITY');
  }

  const ranked = cities
    .map((candidate) => ({
      city: candidate,
      km: geo.haversineKm(pickupPoint, {
        lat: Number(candidate.centreLat),
        lng: Number(candidate.centreLng),
      }),
    }))
    .sort((a, b) => a.km - b.km);

  let chosen = ranked[0];
  let pricedFallback = false;

  if (tripType) {
    const priced = new Set(await citiesWithPricing(tripType));
    const nearestPriced = ranked.find((r) => priced.has(r.city.id));

    /*
     * Only overrides when the nearest city genuinely cannot quote. A priced
     * nearest city is still the nearest city, and skipping past one because a
     * farther one is "more priced" would reprice trips for no reason.
     */
    if (nearestPriced && nearestPriced.city.id !== chosen.city.id) {
      chosen = nearestPriced;
      pricedFallback = true;
    }
  }

  return {
    city: chosen.city,
    // True whenever the trip is priced by a city other than the one asked for,
    // so the response can say so rather than a rider wondering why a Mysuru
    // trip quotes Bengaluru rates.
    switched: chosen.city.id !== requestedCity.id,
    distanceKm: Number(chosen.km.toFixed(1)),
    /*
     * True when the geographically nearest city had no rate cards and pricing
     * fell through to a farther one. Distinct from `switched`, which only says
     * the city differs from the one the app asked for — this says WHY, and it
     * is the line to look at when a quote comes back at a surprising rate.
     */
    pricedFallback,
  };
}

/**
 * Refuse a class that is not offered for this trip type.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FARE LIST FILTERING IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * quoteAllClasses already hides a restricted class from the picker, so a rider
 * tapping through the app cannot reach this. That is exactly the argument for
 * checking here as well: the only requests that CAN reach it are the ones
 * that did not come from the picker — a stale app screen opened before the
 * rule changed, a saved deep link, a repeat of yesterday's booking, or
 * someone posting straight at the API.
 *
 * Without this, every one of those books a 33-seat coach for an airport
 * transfer at a rate card that still exists, and the first anyone knows is a
 * dispatcher with no vehicle to send.
 *
 * A DISTINCT ERROR CODE, not FARE_CONFIG_MISSING. "That vehicle is not
 * offered for this trip" and "nobody has priced it here" need different
 * fixes by different people, and conflating them is what sent someone
 * hunting through rate cards for the airport bug last time.
 */
async function assertClassAllowedForTripType(vehicleClass, tripType) {
  const allowed = await vehicleCatalog.allowedClassesFor(tripType);

  /*
   * An unknown class passes THROUGH, not out.
   *
   * `allowed` only contains classes with an active catalogue row, so a class
   * that was retired — or one that never had a row, which old rate cards
   * still have — would be rejected here with a message about trip types that
   * has nothing to do with why. getFareConfig a few lines later is the right
   * place for that refusal and already words it correctly.
   */
  const known = await vehicleCatalog.list();
  if (!known.some((v) => v.key === vehicleClass)) return;

  if (!allowed.has(vehicleClass)) {
    const label = {
      ONE_WAY: 'one-way',
      ROUND_TRIP: 'round trip',
      AIRPORT: 'airport',
      HOURLY: 'local rental',
    }[tripType] || String(tripType).toLowerCase();

    const name = known.find((v) => v.key === vehicleClass)?.name || vehicleClass;

    throw ApiError.badRequest(
      `${name} is not available for ${label} trips. Choose another vehicle.`,
      'VEHICLE_CLASS_NOT_ALLOWED',
    );
  }
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
  /*
   * The per-trip-type coverage set too. It decides WHICH city prices an
   * out-of-radius pickup, so a rate card added for a new city has to clear it
   * — otherwise the city stays invisible to resolveOperatingCity for up to a
   * minute after the admin can plainly see the card in the panel.
   */
  await cache.delByPrefix('fare:pricedcities:v1:');
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
    /*
     * THE TOWN, for local-trip detection.
     *
     * Only ever filled by the reverse lookup below, because a coordinate
     * carries no locality and the label cannot be trusted to be one — "Office"
     * and "Home" are both valid saved-address labels. Left null when the
     * reverse call is skipped (the label already named a state) or failed,
     * and detectSameCityTrip then does its own lookup, which hits the same
     * 30-day Redis entry.
     */
    let city = null;

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
        city = reverse.city || null;
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
    return { ...point, formattedAddress, state, city, source: 'coordinates' };
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
      /*
       * THE TOWN, parsed by the provider from the same response and — like
       * `state` before it — thrown away here for months. Carrying it is what
       * lets detectSameCityTrip answer "are both ends in one city" without a
       * second billed lookup.
       */
      city: g.city || null,
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
    /*
     * FROM THE SESSION, never from the request body — see the note in
     * fare.controller.options. It decides whether GST is charged, so a client
     * that could name its own account type could name its way out of tax.
     * The controller reads it off the authenticated customer; anything else
     * reads as retail, which is the untaxed case.
     */
    accountType = null,
    /*
     * The recipient's GSTIN, used ONLY by resolveSplitKind and only when a
     * registration has splitByRecipientGstin switched on. It cannot turn tax
     * on — that is accountType's job — so accepting it from the body is safe.
     */
    gstin = null,
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
   *
   * tripType is passed so an unpriced city cannot be chosen — see
   * resolveOperatingCity. Note this is the REQUESTED trip type: localSwitch
   * has not run yet, and it cannot, because it needs the city this call
   * returns. A switch to HOURLY afterwards is still priced against a city that
   * was chosen for having cards, which is the property that matters.
   */
  const operating = await resolveOperatingCity(pickupPoint, city, tripType);
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

  /*
   * Three outcomes — see resolveLocalSwitch. `localNotice` carries all of
   * them; `localSwitch` is only the one that actually changes the product, so
   * every `if (localSwitch)` below still reads as "did the product change".
   *
   * The not-applied case (a local trip in a town with no rental packages) is
   * deliberately NOT a switch and NOT an error. It prices as asked and says so
   * in the response.
   */
  const localNotice = await resolveLocalSwitch(
    tripType, pickupPoint, dropPoint, city, rentalPackageId,
  );
  const localSwitch = localNotice && localNotice.applied ? localNotice : null;

  // See the matching guard in the fare-list path: a rental with no package has
  // no fare, and inventing one would quote terms the rider never chose.
  if (localSwitch && localSwitch.needsPackage) {
    throw new ApiError(409, 'LOCAL_PACKAGE_REQUIRED', localSwitch.message, {
      switchedToLocal: localSwitch,
    });
  }

  /*
   * A SWITCHED TRIP IS PRICED BY THE CITY THAT OWNS THE PACKAGES.
   *
   * resolveOperatingCity chose `city` for the REQUESTED trip type, which it
   * had to — the switch cannot be decided before a city is. Once the product
   * is HOURLY, the city that matters is the one holding the rental packages
   * and the HOURLY rate card, and resolveRentalCity has already found it.
   * Without this reassignment the package lookup below queries a city that
   * has none and throws RENTAL_PACKAGE_NOT_FOUND on a trip we just told the
   * rider we could serve.
   */
  if (localSwitch && Number(localSwitch.rentalCityId) !== Number(city.id)) {
    city = (await activeCityById(localSwitch.rentalCityId)) || city;
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

  /*
   * city.id, NOT the cityId off the request.
   *
   * `city` was reassigned to the operating city above. Reading the request's
   * cityId here meant the fare list and the booking disagreed about who was
   * pricing the trip: quoteAllClasses already queried the OPERATING city's
   * scope keys, while this priced the city the app happened to send. For a
   * Hyderabad pickup sent with cityId=Bengaluru that is two different rate
   * cards for one journey — the rider is shown one total on the fare screen
   * and charged against another at booking, and nothing in either response
   * says why.
   */
  // Before the rate card, because "we do not run that vehicle on this trip"
  // is a different answer from "that vehicle is not priced here" and the
  // rider should get the one that is true.
  await assertClassAllowedForTripType(vehicleClass, effectiveTripType);

  const config = await getFareConfig(city.id, vehicleClass, effectiveTripType);

  /* -- HOURLY: resolve which rental product is actually being bought -- */

  let rentalPackage = null;
  let matchedPackage = false;

  if (isHourlyNow && effectivePackageId) {
    // The app stores a representative package id (from whichever class it listed
    // first). Resolve it to THIS booking's class: find the stored row to learn
    // its duration label, then match the same label for the booked class. So
    // "4hr/40km" works whatever class the user chooses.
    const requested = await prisma.rentalPackage.findFirst({
      where: { id: Number(effectivePackageId), cityId: Number(city.id), isActive: true },
    });
    rentalPackage = requested && requested.vehicleClass === vehicleClass
      ? requested
      : requested
        ? await prisma.rentalPackage.findFirst({
            where: { cityId: Number(city.id), vehicleClass, label: requested.label, isActive: true },
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
        cityId: Number(city.id),
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

  /*
   * TAX ON THE SINGLE QUOTE TOO.
   *
   * quoteAllClasses has attached a per-option `tax` block since GST moved
   * into gst_config. This function never did — so /fares/estimate, which is
   * what a checkout screen calls once the vehicle is already chosen, returned
   * a total with no tax information of any kind. The GST was real and the
   * customer was billed it; there was simply nothing in the response for the
   * page to render, which is why adding a GSTIN appears to change nothing.
   *
   * Same resolver, same inputs, same supply state as the fare list and as
   * billing.service, so all three agree by construction rather than by three
   * copies staying in step.
   */
  const supplyState = pickupPoint?.state || city.state;
  const taxRate = await gst.resolveRate(effectiveTripType, supplyState, accountType);
  const splitKind = await gst.resolveSplitKind(
    supplyState,
    dropPoint?.state || null,
    gstin || null,
  );
  const appliedTax = gst.applyGst(priced.total, taxRate, splitKind);

  return {
    quote: priced,
    /**
     * What tax is on this fare, and what is therefore payable.
     *
     * `applies` false means no tax line at all — a retail account, or a state
     * with no registration. The app must branch on THAT rather than on the
     * amount being zero, because a zero-rated registration is a different
     * thing from an untaxed one and only the first should show a GST row.
     *
     * `payable` is the number to put next to "Total". On the live EXCLUSIVE
     * setting it is fare + rate; were an admin to switch a registration back
     * to inclusive it equals the fare, and the app needs no change either way.
     */
    tax: {
      ratePct: appliedTax.ratePct,
      isInclusive: appliedTax.isInclusive,
      applies: taxRate.applies,
      splitKind,
      state: supplyState,
      amount: M.toStr(appliedTax.tax),
      taxable: M.toStr(appliedTax.taxable),
      cgst: M.toStr(appliedTax.cgst),
      sgst: M.toStr(appliedTax.sgst),
      igst: M.toStr(appliedTax.igst),
      payable: M.toStr(appliedTax.total),
    },
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
    /*
     * Set when the trip IS local but no rental product exists to serve it, so
     * it was priced as the outstation product that was asked for. The app can
     * show the rider why the fare looks high; ops can see which city needs
     * rental packages. Null in every other case, including a successful
     * switch — that one is `switchedToLocal`.
     */
    localTripNotice: localNotice && !localNotice.applied ? localNotice : null,
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

  // Same rule as the single-class quote: nearest PRICED city prices it, the
  // state check decides whether we operate here at all. ONE_WAY is passed as
  // the coverage trip type because that is the half of the comparison that
  // must exist for the endpoint to mean anything.
  const operating = await resolveOperatingCity(pickupPoint, city, 'ONE_WAY');
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
    getFareConfig(city.id, input.vehicleClass, 'ONE_WAY').catch(() => null),
    getFareConfig(city.id, input.vehicleClass, 'ROUND_TRIP').catch(() => null),
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

  /*
   * Same rule as the single-class quote: the nearest city that can actually
   * PRICE this trip type prices it, and the state check above decides whether
   * we operate here at all.
   *
   * input.tripType is what makes the difference between a priced fare list and
   * the empty one that rendered "No rides available for this route right now"
   * on every Hyderabad pickup.
   */
  const operating = await resolveOperatingCity(pickupPoint, city, input.tripType);
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

  const localNotice = await resolveLocalSwitch(
    input.tripType, pickupPoint, dropPoint, city, input.rentalPackageId,
  );
  const localSwitch = localNotice && localNotice.applied ? localNotice : null;

  // Same reassignment as getQuote, for the same reason — the two must price
  // the identical trip against the identical city or the fare changes between
  // the list screen and the booking.
  if (localSwitch && Number(localSwitch.rentalCityId) !== Number(city.id)) {
    city = (await activeCityById(localSwitch.rentalCityId)) || city;
  }

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
    prisma.vehicleCatalog.findMany({
      where: { isActive: true },
      // tripTypes joins the select so the per-trip-type restriction is applied
      // in the same pass as the active check. Fetching keys and then asking
      // the catalogue service separately would be a second query on the
      // hottest endpoint in the system for data already in hand.
      select: { key: true, tripTypes: true },
    }),
  ]);

  /*
   * VISIBLE *AND* BOOKABLE FOR THIS TRIP TYPE.
   *
   * Two different retirements. `isActive` takes a class off every screen —
   * the generic sedan and SUV placeholders. `tripTypes` takes it off SOME
   * screens — a 33-seat coach is a real, active, bookable vehicle that has no
   * business appearing on an airport transfer.
   *
   * Filtered on effectiveTripType, not input.tripType: an outstation request
   * that switched to a local rental must be offered the classes that may be
   * RENTED, which is the wider list. Filtering on what was asked for would
   * hide the tempo from a rental it is perfectly suited to.
   */
  const visibleClasses = new Set(
    visible
      .filter((v) => vehicleCatalog.allowsTripType(v, effectiveTripType))
      .map((v) => v.key),
  );

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
      where: { id: Number(effectivePackageId), cityId: Number(city.id), isActive: true },
    });
    const pkgs = chosen
      ? await prisma.rentalPackage.findMany({
          where: { cityId: Number(city.id), label: chosen.label, isActive: true },
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
   * AN EMPTY LIST IS A FAILURE, NOT AN ANSWER.
   *
   * This used to return `{ options: [] }` with a 200. The rider app cannot
   * tell that apart from a route nobody drives, so it showed "No rides
   * available for this route right now" — a sentence about geography for what
   * is always a configuration problem, on a route the fleet runs daily. It
   * cost a day to trace, because nothing anywhere logged a reason.
   *
   * There are exactly two ways to get here with nothing:
   *   - the operating city has no live rate card for this trip type, and
   *     neither does its state (the Hyderabad case: a city row created with no
   *     `copyFromCityId` and no statewide Telangana card behind it)
   *   - every card that does exist prices a class retired from
   *     vehicle_catalog, so nothing is visible to a rider
   *
   * Both are fixed in the admin panel, and both need to SAY so. The details
   * carry the operating city, its state and the scope keys that were queried,
   * which is everything needed to find the missing card without opening a
   * database client.
   */
  if (!options.length) {
    throw new ApiError(
      400,
      'FARE_CONFIG_MISSING',
      `No ${String(effectiveTripType).toLowerCase().replace('_', '-')} fares are configured for ` +
        `${city.name}${city.state ? `, ${city.state}` : ''}. ` +
        'Add a rate card for this city, or a statewide card for its state.',
      {
        cityId: city.id,
        cityName: city.name,
        state: city.state || null,
        tripType: effectiveTripType,
        requestedTripType: input.tripType,
        requestedCityId: Number(input.cityId),
        scopeKeys,
        /*
         * How many cards matched before the vehicle_catalog filter. Non-zero
         * with an empty list means the cards exist and the CLASSES are
         * retired, which is a different fix in a different screen.
         */
        cardsBeforeCatalogFilter: configs.length,
        switchedCity: operating.switched,
        pricedFallback: operating.pricedFallback,
      },
    );
  }

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
  /*
   * THE PICKUP'S STATE, NOT THE PRICING CITY'S.
   *
   * This read `city.state`, and `city` is the OPERATING city — the nearest
   * one with a rate card, which for a pickup in a town with no city row is
   * somewhere else entirely. A Hyderabad pickup resolves to the Bengaluru
   * row, so this asked for the KARNATAKA registration on a Telangana trip.
   * Adding the Telangana row would not have fixed it: nothing would ever
   * have selected it.
   *
   * billing.service already bills on `booking.pickupState`, so the quote and
   * the invoice were resolving the registration two different ways — the
   * exact class of mismatch that puts one number on the fare screen and
   * another on the invoice.
   *
   * Falls back to the operating city's state when the geocoder returned no
   * state, which is what this did for every trip before.
   */
  const supplyState = pickupPoint?.state || city.state;

  const taxRate = await gst.resolveRate(effectiveTripType, supplyState, input.accountType);
  const splitKind = await gst.resolveSplitKind(
    supplyState,
    dropPoint?.state || null,
    input.gstin || null,
  );

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
      /*
       * The city that actually PRICED this list, which is not necessarily the
       * one the app sent. Returned so the booking call can send it back and
       * the two steps cannot disagree — and so a surprising rate is traceable
       * from the response alone.
       */
      cityId: city.id,
      cityName: city.name,
      requestedCityId: Number(input.cityId),
      switchedCity: operating.switched,
      pricedFallback: operating.pricedFallback,
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
    // See getQuote: a local trip in a city with no rental packages.
    localTripNotice: localNotice && !localNotice.applied ? localNotice : null,
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