'use strict';

/**
 * src/services/areaRadius.service.js
 *
 * Working out how big a place is, so an admin does not have to guess.
 *
 * ---------------------------------------------------------------------------
 * WHY A DERIVED RADIUS IS ONLY HALF AN ANSWER
 * ---------------------------------------------------------------------------
 * Google's `bounds` for a locality is its ADMINISTRATIVE footprint. That is a
 * fact about the place. A service radius is a commercial decision — how far
 * the client is willing to send a car — and the map has no view on it.
 *
 * The two differ by more than rounding. Bengaluru's bounds give roughly 25–30
 * km from the centre. Kempegowda airport sits at 28.5 km and Devanahalli at
 * 32.7 km, and quote.service refuses a pickup outside the radius BEFORE any
 * maps call. So a purely derived radius would put the airport on the boundary
 * or outside it, and airport bookings would start failing with
 * OUTSIDE_SERVICE_AREA — a bug that costs a day to trace because the error
 * names geography rather than configuration.
 *
 * Hence: derive, then WIDEN to cover everything the business has already said
 * it serves, and tell the admin what was added and why. The number that
 * appears in the form is safe to accept blindly, which is the only kind of
 * default worth having.
 */

const { prisma } = require('../config/prisma');
const maps = require('./maps.service');
const geo = require('../lib/geo');
const { ApiError } = require('../utils/helpers');

/**
 * Smallest radius we will suggest.
 *
 * A village geocodes to a point with no bounds at all, and a 0 km service area
 * serves nobody. Five kilometres is a walkable-to-drivable minimum that keeps
 * a hamlet usable.
 */
const MIN_RADIUS_KM = 5;

/**
 * Largest, before the admin has to say so deliberately.
 *
 * A radius this size stops being a city and becomes a region: it swallows
 * neighbouring towns, and on the surge map it would claim every village
 * inside it — the nearest-centre tie-break protects tier matching, but a
 * 200 km "city" is a data-entry error worth refusing.
 */
const MAX_RADIUS_KM = 200;

/** Headroom on the derived figure. */
const PADDING_RATIO = 0.1;

/**
 * Half the diagonal of a bounding box, in km.
 *
 * The CORNER, not the edge midpoint: a place is only fully covered by a circle
 * that reaches its furthest point, and the corner is that point. Using the
 * edge would leave the four corners of the footprint outside the radius.
 */
function radiusFromBox(centre, box) {
  if (!box) return null;
  const corners = [
    { lat: box.northeast.lat, lng: box.northeast.lng },
    { lat: box.southwest.lat, lng: box.southwest.lng },
    { lat: box.northeast.lat, lng: box.southwest.lng },
    { lat: box.southwest.lat, lng: box.northeast.lng },
  ];
  return Math.max(...corners.map((c) => geo.haversineKm(centre, c)));
}

/**
 * Places the business has already committed to serving from this centre.
 *
 * Airports first, because they are the ones that bite: they sit outside city
 * limits by design — that is why there is space for a runway — and they are
 * the single most common pickup that a tight radius silently excludes.
 *
 * Then existing service areas, so classifying a village as a taluka and then
 * adding the city cannot leave that village outside the city that contains it.
 */
async function pointsThatMustBeInside(centre, cityName) {
  const musts = [];

  // Airports near the centre. Cached 30 days by maps.service, and it returns
  // [] rather than throwing — a maps outage must not block adding a city.
  try {
    const airports = await maps.airports({ lat: centre.lat, lng: centre.lng, radiusKm: 120 });
    for (const a of airports) {
      if (a.isTerminal) continue; // the parent's coordinates are enough
      musts.push({
        name: a.airportName,
        kind: 'airport',
        distanceKm: geo.haversineKm(centre, { lat: a.lat, lng: a.lng }),
      });
    }
  } catch {
    // Deliberately silent: a suggestion is better than a failed form.
  }

  const areas = await prisma.serviceArea.findMany({
    where: { isActive: true },
    select: { name: true, tier: true, centreLat: true, centreLng: true, radiusKm: true },
  });

  for (const area of areas) {
    if (area.name.toLowerCase() === String(cityName || '').toLowerCase()) continue;
    const areaCentre = { lat: Number(area.centreLat), lng: Number(area.centreLng) };
    // Its FAR edge, not its centre — an area is only covered when all of it is.
    const distance = geo.haversineKm(centre, areaCentre) + area.radiusKm;
    musts.push({ name: area.name, kind: area.tier.toLowerCase(), distanceKm: distance });
  }

  return musts;
}

/**
 * Suggest a centre and radius for a named place.
 *
 * Returns the derived figure, the final suggestion, and WHAT WIDENED IT. That
 * last part matters: an admin who sees "widened to 31 km to include Kempegowda
 * International Airport" understands the number and can argue with it. A bare
 * 31 is something they either trust blindly or override arbitrarily.
 */
async function suggest({ name, state }) {
  const query = state ? `${name}, ${state}` : name;

  let place;
  try {
    place = await maps.geocode(query);
  } catch {
    throw ApiError.badRequest(
      `Could not find "${query}" on the map. Check the spelling, or enter the centre manually.`,
      'PLACE_NOT_FOUND',
    );
  }

  const centre = { lat: place.lat, lng: place.lng };

  /*
   * bounds, then viewport, then the floor.
   *
   * viewport is a display hint — padded so a map looks right — so it
   * overstates the place. It is used only when bounds is absent, which is the
   * case for a village that geocodes to a single point, and the result is
   * flagged so the caller knows the figure is softer.
   */
  const fromBounds = radiusFromBox(centre, place.bounds);
  const fromViewport = radiusFromBox(centre, place.viewport);

  const derivedRaw = fromBounds ?? fromViewport ?? MIN_RADIUS_KM;
  const source = fromBounds ? 'bounds' : fromViewport ? 'viewport' : 'minimum';

  let radiusKm = Math.ceil(derivedRaw * (1 + PADDING_RATIO));
  const derivedKm = radiusKm;

  /* ---- widen to cover what is already served ---- */

  const musts = await pointsThatMustBeInside(centre, name);
  const excluded = musts
    .filter((m) => m.distanceKm > radiusKm && m.distanceKm <= MAX_RADIUS_KM)
    .sort((a, b) => b.distanceKm - a.distanceKm);

  if (excluded.length) {
    radiusKm = Math.ceil(excluded[0].distanceKm * (1 + PADDING_RATIO));
  }

  radiusKm = Math.min(Math.max(radiusKm, MIN_RADIUS_KM), MAX_RADIUS_KM);

  return {
    name,
    state: place.state ?? state ?? null,
    centre,
    formattedAddress: place.formattedAddress,
    radiusKm,
    derived: {
      radiusKm: derivedKm,
      // 'viewport' means Google had no administrative footprint, so the figure
      // is a display rectangle and worth a second look.
      source,
    },
    /** What forced the radius wider, in the order that did it. */
    widenedFor: excluded.map((m) => ({
      name: m.name,
      kind: m.kind,
      distanceKm: Number(m.distanceKm.toFixed(1)),
    })),
    /** One line the admin form can show verbatim. */
    explanation: excluded.length
      ? `${derivedKm} km covers ${name} itself; widened to ${radiusKm} km to include ${excluded[0].name} at ${excluded[0].distanceKm.toFixed(1)} km.`
      : `${radiusKm} km, from the map's boundary for ${name}.`,
  };
}

module.exports = { suggest, radiusFromBox, MIN_RADIUS_KM, MAX_RADIUS_KM };