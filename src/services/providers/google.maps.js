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
    provider: NAME,
    estimated: false,
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

module.exports = { name: NAME, getDistanceMatrix, getRoute, geocode, reverseGeocode, autocomplete };