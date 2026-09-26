'use strict';

/**
 * src/services/providers/google.maps.js
 *
 * Google Maps Platform adapter.
 *
 * COST WARNING: Distance Matrix and Places Autocomplete are billed per call and
 * are the two that run away. Autocomplete in particular fires on every
 * keystroke unless the client debounces — a single search box can generate
 * dozens of billable calls for one address. The caching in maps.service and a
 * 300ms debounce on the client are not optional at volume.
 *
 * Set MAPS_PROVIDER=google and MAPS_API_KEY to activate.
 */

const axios = require('axios');
const env = require('../../config/env');
// Both parsers come from serviceArea. cityFromComponents was called below but
// never imported or defined, so EVERY geocode threw "cityFromComponents is not
// defined" — the maps breaker then opened and typed addresses could not be
// located at all (GEOCODE_FAILED on every fare request).
const { stateFromComponents, cityFromComponents } = require('../../lib/serviceArea');

const NAME = 'google';
const BASE = 'https://maps.googleapis.com/maps/api';

/**
 * Keep-alive matters here. Without it every call repays the TLS handshake,
 * which on a cross-continent hop can exceed the request itself.
 */
const http = axios.create({
  baseURL: BASE,
  timeout: Number(env.maps.timeoutMs || 5000),
  headers: { 'Accept-Encoding': 'gzip' },
});

function assertOk(data, endpoint) {
  if (data.status === 'OK' || data.status === 'ZERO_RESULTS') return;
  const msg = data.error_message || data.status;
  throw new Error(`[maps:google] ${endpoint} returned ${msg}`);
}

async function getDistanceMatrix(origin, destination) {
  const { data } = await http.get('/distancematrix/json', {
    params: {
      origins: `${origin.lat},${origin.lng}`,
      destinations: `${destination.lat},${destination.lng}`,
      mode: 'driving',
      units: 'metric',
      // Live traffic. Costs more than the basic tier but matters for an ETA a
      // customer is standing on a pavement waiting for.
      departure_time: 'now',
      key: env.maps.apiKey,
    },
  });

  assertOk(data, 'distancematrix');

  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`[maps:google] no route found (${element?.status || 'no element'})`);
  }

  // duration_in_traffic is present only with departure_time; fall back cleanly.
  const seconds = element.duration_in_traffic?.value ?? element.duration.value;

  return {
    distanceKm: Number((element.distance.value / 1000).toFixed(2)),
    durationMin: Math.max(1, Math.round(seconds / 60)),
    provider: NAME,
    estimated: false,
    trafficAware: Boolean(element.duration_in_traffic),
  };
}

async function geocode(address) {
  const { data } = await http.get('/geocode/json', {
    params: {
      address,
      // Bias to India so "MG Road" resolves locally rather than somewhere else.
      components: 'country:IN',
      key: env.maps.apiKey,
    },
  });

  assertOk(data, 'geocode');
  const result = data.results?.[0];
  if (!result) throw new Error('[maps:google] address not found');

  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
    placeId: result.place_id,
    // administrative_area_level_1 — the state. Carried through so the caller
    // can decide serviceability without a second billed lookup.
    state: stateFromComponents(result.address_components),
    city: cityFromComponents(result.address_components),
    /*
     * The place's own extent, when Google has one.
     *
     * `bounds` is the administrative footprint and is absent for a street
     * address — only a locality, district or similar carries it. `viewport`
     * is always present but is a DISPLAY hint: what a map should show, padded
     * for legibility, which is larger than the place. Both are returned so the
     * caller can prefer bounds and fall back knowingly rather than treating
     * the padded rectangle as a boundary.
     */
    bounds: boxOf(result.geometry?.bounds),
    viewport: boxOf(result.geometry?.viewport),
    provider: NAME,
    estimated: false,
  };
}

/** Google's { northeast, southwest } as plain numbers, or null. */
function boxOf(box) {
  if (!box?.northeast || !box?.southwest) return null;
  return {
    northeast: { lat: box.northeast.lat, lng: box.northeast.lng },
    southwest: { lat: box.southwest.lat, lng: box.southwest.lng },
  };
}

async function reverseGeocode(lat, lng) {
  const { data } = await http.get('/geocode/json', {
    params: { latlng: `${lat},${lng}`, key: env.maps.apiKey },
  });

  assertOk(data, 'reverseGeocode');
  const result = data.results?.[0];

  return {
    lat: Number(lat),
    lng: Number(lng),
    formattedAddress: result?.formatted_address || `${lat}, ${lng}`,
    placeId: result?.place_id || null,
    state: stateFromComponents(result?.address_components),
    provider: NAME,
    estimated: false,
  };
}

/**
 * sessionToken groups the keystrokes of one search into a single billable
 * session. Omitting it means every keystroke bills separately — the difference
 * between one charge and fifteen for the same address lookup.
 */
async function autocomplete(query, { sessionToken, lat, lng } = {}) {
  const { data } = await http.get('/place/autocomplete/json', {
    params: {
      input: query,
      components: 'country:in',
      sessiontoken: sessionToken,
      ...(lat && lng ? { location: `${lat},${lng}`, radius: 50000 } : {}),
      key: env.maps.apiKey,
    },
  });

  assertOk(data, 'autocomplete');

  return (data.predictions || []).slice(0, 5).map((p) => ({
    description: p.description,
    placeId: p.place_id,
    provider: NAME,
  }));
}

/**
 * Airports and their terminals, from Places.
 *
 * Two different Places endpoints, because the question is two different
 * questions:
 *
 *   - no query  -> Nearby Search with type=airport. "What airports are near
 *                  this city?" Type-filtered, so it cannot drift onto an
 *                  airport-themed hotel.
 *   - a query   -> Text Search. The rider is typing a name, possibly of an
 *                  airport in another city they are flying out of, so the
 *                  location is a bias rather than a filter.
 *
 * `type: 'airport'` is NOT passed to Text Search on purpose. Google classifies
 * individual terminals as `point_of_interest`, not `airport`, so the filter
 * would hide exactly the terminal-level results this exists to surface.
 */
async function searchAirports({ query, lat, lng, radiusM = 80_000 } = {}) {
  const q = String(query || '').trim();

  const endpoint = q ? '/place/textsearch/json' : '/place/nearbysearch/json';
  const params = q
    ? {
        // "airport" appended so a bare "kempegowda" still lands on the airport
        // rather than the bus station of the same name.
        query: /airport|terminal/i.test(q) ? q : `${q} airport`,
        ...(lat && lng ? { location: `${lat},${lng}`, radius: radiusM } : {}),
        region: 'in',
        key: env.maps.apiKey,
      }
    : {
        location: `${lat},${lng}`,
        radius: radiusM,
        type: 'airport',
        key: env.maps.apiKey,
      };

  const { data } = await http.get(endpoint, { params });
  assertOk(data, q ? 'textsearch' : 'nearbysearch');

  return (data.results || []).filter(isRealAirport).map(toPlace);
}

/**
 * Places that are NOT an airport, however they are named or classified.
 *
 * Google's `type=airport` filter is far looser than it sounds: a Nearby Search
 * around Bengaluru returns a hotel on the airport road, a heliport on a hotel
 * roof, and at least one private individual's saved place, all tagged airport.
 * Filtering on the returned `types` is the only reliable way to drop them.
 */
const NOT_AN_AIRPORT = [
  'lodging', 'store', 'restaurant', 'cafe', 'food', 'bar', 'meal_takeaway',
  'shopping_mall', 'school', 'gym', 'bank', 'atm', 'parking',
  'travel_agency', 'car_rental', 'tourist_attraction', 'real_estate_agency',
];

/**
 * The name of a place that flies passengers.
 *
 * Indian airports are named "<something> Airport", near-universally, and the
 * search path appends the word anyway. Requiring it is what finally removes
 * the results Google tags `airport` with no other type to catch them by — a
 * private individual's saved place, a firm called "G Enterprises", a downtown
 * spot called "Banaras".
 */
const AIRPORT_NAME = /\b(airport|aerodrome|airfield|air\s?base|airstrip)\b/i;

/**
 * Names that contain an aviation word but are not somewhere a cab can drop you.
 *
 * Two kinds. Helipads, which Google files under `airport` and which no cab
 * passenger is catching a flight from. And businesses that sell aviation
 * services — "SAN AIRPORT SERVICES", "Aviationskybiz Pvt Ltd - helipad
 * consulting" — whose names pass AIRPORT_NAME but whose pins are an office
 * floor in the city.
 */
const NOT_A_TERMINAL_BUILDING =
  /\b(helipad|heliport|services|consulting|agency|travel|taxi|cab|transfer|parking|hotel|lounge|cargo|freight|academy|training|club)\b/i;

function isRealAirport(r) {
  const types = r.types || [];
  if (!types.includes('airport')) return false;
  if (types.some((t) => NOT_AN_AIRPORT.includes(t))) return false;

  const name = String(r.name || '');
  if (!AIRPORT_NAME.test(name)) return false;
  if (NOT_A_TERMINAL_BUILDING.test(name)) return false;

  return true;
}

/**
 * The terminals of one airport.
 *
 * Terminals are separate Places records ("Kempegowda International Airport
 * Terminal 1"), so this is a Text Search scoped tightly to the airport's own
 * coordinates. 8 km rather than the airport-search radius: a large airport is
 * a few km across, and anything further away belongs to a different airport.
 */
async function searchTerminals(airportName, { lat, lng } = {}) {
  const { data } = await http.get('/place/textsearch/json', {
    params: {
      query: `${airportName} terminal`,
      ...(lat && lng ? { location: `${lat},${lng}`, radius: 8_000 } : {}),
      region: 'in',
      key: env.maps.apiKey,
    },
  });
  assertOk(data, 'textsearch:terminals');

  return (data.results || []).filter(isTerminalRecord).map(toPlace);
}

/**
 * Is this record the terminal itself, rather than a shop inside it?
 *
 * Searching "<airport> terminal" returns every business whose address contains
 * a terminal — a coffee counter at T1 arrivals, a luggage shop at T2 departures.
 * Their names genuinely contain "T1" and "Terminal 2", so a name match alone
 * lets them through, and a rider sent to a coffee counter's pin is dropped at
 * the wrong door.
 *
 * Two tests, both of which must pass:
 *   1. the NAME names a terminal, not merely the address
 *   2. the TYPES do not mark it as a business
 */
function isTerminalRecord(r) {
  const name = String(r.name || '');
  if (!/\b(?:terminal[\s-]*[0-9A-Z]{1,2}|T[0-9]{1,2})\b/i.test(name)) return false;

  const types = r.types || [];
  if (types.some((t) => NOT_AN_AIRPORT.includes(t))) return false;
  if (NOT_A_TERMINAL_BUILDING.test(name)) return false;

  // A retailer's name reads "Brand - Airport T2": a brand, a SPACED separator,
  // then the location. The separator must be spaced — Google writes the real
  // thing as "Terminal-1", and matching a bare hyphen rejected the actual
  // terminals along with the shops.
  if (/\s[-–|:]\s/.test(name)) return false;

  return true;
}

/** Shared shape for both airport calls. */
function toPlace(r) {
  const loc = r.geometry?.location || {};
  return {
    placeId: r.place_id,
    name: r.name,
    address: r.formatted_address || r.vicinity || null,
    lat: loc.lat,
    lng: loc.lng,
    // Carried through so the service layer can tell an airport from a hotel
    // without a second lookup.
    types: r.types || [],
    provider: NAME,
  };
}

/**
 * Road route geometry between two points, for drawing the driving path on the
 * map (the line that follows streets, not a straight line).
 *
 * Uses the Directions API. Billed per request like Distance Matrix, so the
 * result is cached upstream in maps.service. Returns the decoded list of
 * {lat,lng} points plus distance/duration so a caller can use it standalone.
 */
async function getRoute(origin, destination) {
  const { data } = await http.get('/directions/json', {
    params: {
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      mode: 'driving',
      key: env.maps.apiKey,
    },
  });

  assertOk(data, 'directions');

  const route = data.routes?.[0];
  const leg = route?.legs?.[0];
  if (!route || !leg) {
    throw new Error(`[maps:google] no route found (${data.status})`);
  }

  return {
    points: decodePolyline(route.overview_polyline?.points || ''),
    distanceKm: Number((leg.distance.value / 1000).toFixed(2)),
    durationMin: Math.round(leg.duration.value / 60),
    provider: NAME,
  };
}

/**
 * Decode Google's "encoded polyline" string into [{lat,lng}...].
 * This is Google's standard algorithm — small and dependency-free.
 */
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
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