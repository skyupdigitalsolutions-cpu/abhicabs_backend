'use strict';

/**
 * src/services/providers/mock.maps.js
 *
 * Offline maps provider. No API key, no network, no cost.
 *
 * Distances come from the haversine formula times a road-detour factor, which
 * is typically within 10-20% of a real routed distance for city trips. That is
 * more than good enough to develop and test the fare engine, the booking flow,
 * and dispatch against.
 *
 * This is the DEFAULT provider. Nothing in Days 4-12 is blocked on a maps
 * contract, and every downstream test runs without credentials.
 *
 * Every result carries estimated:true so a caller can tell a real route from a
 * derived one — and so the mock can never be mistaken for production data.
 */

const geo = require('../../lib/geo');

const NAME = 'mock';

/**
 * Average speeds by trip length. A short city hop crawls; a long outstation run
 * spends most of its distance on highway.
 */
function averageSpeedKmh(distanceKm) {
  if (distanceKm < 5) return 18;    // dense city, traffic-bound
  if (distanceKm < 20) return 25;   // city
  if (distanceKm < 60) return 40;   // suburban / ring road
  return 55;                        // highway
}

async function getDistanceMatrix(origin, destination) {
  const straightKm = geo.haversineKm(origin, destination);
  const distanceKm = Number((straightKm * geo.DETOUR_FACTOR).toFixed(2));
  const durationMin = Math.max(1, Math.round((distanceKm / averageSpeedKmh(distanceKm)) * 60));

  return {
    distanceKm,
    durationMin,
    provider: NAME,
    estimated: true,
    straightLineKm: Number(straightKm.toFixed(2)),
  };
}

/**
 * Deterministic pseudo-geocode.
 *
 * The same address string always resolves to the same coordinates, which is
 * what makes cache behaviour and repeated bookings testable. Anchored near
 * Bengaluru so mock results sit inside the seeded service area.
 */
async function geocode(address) {
  const seed = String(address)
    .toLowerCase()
    .split('')
    .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 100000, 7);

  // Spread within roughly +/-0.15 degrees of the city centre (~16 km).
  const lat = 12.9716 + ((seed % 300) - 150) / 1000;
  const lng = 77.5946 + ((Math.floor(seed / 300) % 300) - 150) / 1000;

  return {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    formattedAddress: String(address),
    placeId: `mock_${seed}`,
    provider: NAME,
    estimated: true,
  };
}

async function reverseGeocode(lat, lng) {
  return {
    lat: Number(lat),
    lng: Number(lng),
    formattedAddress: `Near ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}, Bengaluru`,
    placeId: `mock_rev_${geo.coordKey({ lat, lng })}`,
    provider: NAME,
    estimated: true,
  };
}

async function autocomplete(query) {
  const places = [
    'Koramangala', 'Indiranagar', 'Whitefield', 'HSR Layout', 'Jayanagar',
    'MG Road', 'Electronic City', 'Hebbal', 'Marathahalli', 'Yelahanka',
    'Kempegowda International Airport', 'Majestic Bus Station', 'Cubbon Park',
  ];

  const q = String(query).toLowerCase();
  return places
    .filter((p) => p.toLowerCase().includes(q))
    .slice(0, 5)
    .map((p) => ({
      description: `${p}, Bengaluru, Karnataka`,
      placeId: `mock_place_${p.replace(/\s+/g, '_').toLowerCase()}`,
      provider: NAME,
    }));
}

/** A trivial 2-point "route" (straight line) so mock mode still returns geometry. */
async function getRoute(origin, destination) {
  const dm = await getDistanceMatrix(origin, destination);
  return {
    points: [
      { lat: Number(origin.lat), lng: Number(origin.lng) },
      { lat: Number(destination.lat), lng: Number(destination.lng) },
    ],
    distanceKm: dm.distanceKm,
    durationMin: dm.durationMin,
    provider: NAME,
  };
}

module.exports = { name: NAME, getDistanceMatrix, getRoute, geocode, reverseGeocode, autocomplete };