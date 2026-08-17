'use strict';

/**
 * src/services/providers/ola.maps.js
 *
 * Ola Maps adapter.
 *
 * Built for Indian roads and materially cheaper than Google at volume, which
 * matters because maps is likely to be the second-largest bill after servers.
 * Address and POI coverage is strong in Indian cities.
 *
 * Set MAPS_PROVIDER=ola and MAPS_API_KEY to activate.
 *
 * NOTE: verify the exact response field names against Ola's current docs before
 * going live — the shapes below follow their published schema but this adapter
 * has not been exercised against the live API. The interface contract is what
 * matters; only the parsing inside these four functions would change.
 */

const axios = require('axios');
const env = require('../../config/env');

const NAME = 'ola';
const BASE = 'https://api.olamaps.io';

const http = axios.create({
  baseURL: BASE,
  timeout: Number(env.maps.timeoutMs || 5000),
  headers: { 'Accept-Encoding': 'gzip' },
});

async function getDistanceMatrix(origin, destination) {
  const { data } = await http.get('/routing/v1/distanceMatrix', {
    params: {
      origins: `${origin.lat},${origin.lng}`,
      destinations: `${destination.lat},${destination.lng}`,
      api_key: env.maps.apiKey,
    },
  });

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status === 'NOT_FOUND') {
    throw new Error('[maps:ola] no route found');
  }

  return {
    distanceKm: Number((element.distance / 1000).toFixed(2)),
    durationMin: Math.max(1, Math.round(element.duration / 60)),
    provider: NAME,
    estimated: false,
  };
}

async function geocode(address) {
  const { data } = await http.get('/places/v1/geocode', {
    params: { address, api_key: env.maps.apiKey },
  });

  const result = data?.geocodingResults?.[0];
  if (!result) throw new Error('[maps:ola] address not found');

  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
    placeId: result.place_id || null,
    provider: NAME,
    estimated: false,
  };
}

async function reverseGeocode(lat, lng) {
  const { data } = await http.get('/places/v1/reverse-geocode', {
    params: { latlng: `${lat},${lng}`, api_key: env.maps.apiKey },
  });

  const result = data?.results?.[0];

  return {
    lat: Number(lat),
    lng: Number(lng),
    formattedAddress: result?.formatted_address || `${lat}, ${lng}`,
    placeId: result?.place_id || null,
    provider: NAME,
    estimated: false,
  };
}

async function autocomplete(query, { lat, lng } = {}) {
  const { data } = await http.get('/places/v1/autocomplete', {
    params: {
      input: query,
      ...(lat && lng ? { location: `${lat},${lng}` } : {}),
      api_key: env.maps.apiKey,
    },
  });

  return (data?.predictions || []).slice(0, 5).map((p) => ({
    description: p.description,
    placeId: p.place_id,
    provider: NAME,
  }));
}

module.exports = { name: NAME, getDistanceMatrix, geocode, reverseGeocode, autocomplete };