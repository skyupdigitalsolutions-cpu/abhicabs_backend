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
    // The mock pretends everything is in Karnataka so the dev flow is the
    // SERVICEABLE one by default. Put a state name in the address string to
    // exercise the out-of-area path: geocode('Chennai, Tamil Nadu').
    state: 'Karnataka',
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
    state: 'Karnataka',
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

/**
 * Airports, mocked.
 *
 * Terminal-level entries are included because the rider flow depends on them —
 * a mock that returns only parent airports would let a broken terminal picker
 * pass every local test.
 */
const MOCK_AIRPORTS = [
  { name: 'Kempegowda International Airport', city: 'Bengaluru', lat: 13.1986, lng: 77.7066,
    terminals: [
      { name: 'Kempegowda International Airport Terminal 1', lat: 13.1979, lng: 77.7063 },
      { name: 'Kempegowda International Airport Terminal 2', lat: 13.2020, lng: 77.7050 },
    ] },
  { name: 'Rajiv Gandhi International Airport', city: 'Hyderabad', lat: 17.2403, lng: 78.4294,
    terminals: [] },
  { name: 'Chhatrapati Shivaji Maharaj International Airport', city: 'Mumbai', lat: 19.0896, lng: 72.8656,
    terminals: [
      { name: 'Chhatrapati Shivaji Maharaj International Airport Terminal 1', lat: 19.0887, lng: 72.8679 },
      { name: 'Chhatrapati Shivaji Maharaj International Airport Terminal 2', lat: 19.0980, lng: 72.8747 },
    ] },
];

async function searchAirports({ query } = {}) {
  const q = String(query || '').toLowerCase().trim();
  return MOCK_AIRPORTS
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.city.toLowerCase().includes(q))
    .map((a) => ({
      placeId: `mock_airport_${a.name.replace(/\s+/g, '_').toLowerCase()}`,
      name: a.name,
      address: `${a.city}, India`,
      lat: a.lat,
      lng: a.lng,
      provider: NAME,
    }));
}

async function searchTerminals(airportName) {
  const parent = MOCK_AIRPORTS.find((a) =>
    airportName.toLowerCase().includes(a.name.toLowerCase().slice(0, 12)));
  if (!parent) return [];
  return parent.terminals.map((t) => ({
    placeId: `mock_term_${t.name.replace(/\s+/g, '_').toLowerCase()}`,
    name: t.name,
    address: `${parent.city}, India`,
    lat: t.lat,
    lng: t.lng,
    provider: NAME,
  }));
}

module.exports = {
  name: NAME,
  getDistanceMatrix,
  getRoute,
  geocode,
  reverseGeocode,
  autocomplete,
  searchAirports,
  searchTerminals,
};