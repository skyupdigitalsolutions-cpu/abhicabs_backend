const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

const LIMIT = 8; // a WhatsApp list holds 10 rows: 8 places + "Search again" + "Use what I typed"

function parseNear(value) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value || '');
  return m ? { latitude: Number(m[1]), longitude: Number(m[2]) } : null;
}

/**
 * Finds places by name with Google Places "Text Search (New)", so a customer can type
 * "Hebbal" and pick the exact one: Hebbal Flyover, Hebbal Baptist Hospital, Hebbal Lake ...
 * Returns up to 8 of { name, address, latitude, longitude } — or [] when no key is set,
 * the Places API (New) is not enabled for the key, or nothing matches (the caller then
 * falls back to the text exactly as typed). Never logs the API key.
 *
 * Results lean towards `near` (e.g. the pickup point) or, if that is missing, towards
 * PLACE_SEARCH_NEAR ("lat,lng", optional) so "Hebbal" means the Hebbal in your own city.
 */
async function searchPlaces(query, { near } = {}) {
  const key = env.GOOGLE_MAPS_API_KEY;
  const text = String(query || '').trim();
  if (!key || text.length < 2) return [];

  const body = { textQuery: text, regionCode: 'IN', languageCode: 'en' };
  const center = near && near.latitude != null && near.longitude != null ? near : parseNear(env.PLACE_SEARCH_NEAR);
  if (center) {
    body.locationBias = {
      circle: { center: { latitude: Number(center.latitude), longitude: Number(center.longitude) }, radius: 50000 },
    };
  }

  try {
    const { data } = await axios.post('https://places.googleapis.com/v1/places:searchText', body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
      },
      timeout: 8000,
    });

    const seen = new Set();
    const results = [];
    for (const p of data?.places || []) {
      if (!p.location || !(p.displayName?.text || p.formattedAddress)) continue;
      const name = p.displayName?.text || p.formattedAddress;
      const address = p.formattedAddress || p.displayName?.text;
      const id = `${name.toLowerCase()}|${String(address).toLowerCase()}`;
      if (seen.has(id)) continue; // same place twice
      seen.add(id);
      results.push({ name, address, latitude: p.location.latitude, longitude: p.location.longitude });
      if (results.length === LIMIT) break;
    }
    return results;
  } catch (err) {
    logger.warn(
      { status: err.response?.status, err: err.response?.data?.error?.message || err.message },
      '[places] search failed — using the text as typed (is "Places API (New)" enabled for the key?)'
    );
    return [];
  }
}

function straightKm(a, b) {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Adds the distance from `origin` ({ latitude, longitude }) to every match, like the "9.4 km" next to each place
 * in WhatsApp's own location search. Road distance comes from ONE Google Distance Matrix call for all places;
 * if that fails the straight-line distance is used instead and marked approximate (~).
 * Sets match.distanceKm (one decimal) and match.approx. Without an origin nothing is added. Never throws.
 */
async function addDistances(origin, matches) {
  if (!origin || origin.latitude == null || origin.longitude == null || !Array.isArray(matches) || matches.length === 0) return matches;
  const key = env.GOOGLE_MAPS_API_KEY;
  let road = null;
  if (key) {
    try {
      const { data } = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
        params: {
          origins: `${origin.latitude},${origin.longitude}`,
          destinations: matches.map((m) => `${m.latitude},${m.longitude}`).join('|'),
          mode: 'driving', units: 'metric', region: 'in', key,
        },
        timeout: 6000,
      });
      if (data?.status === 'OK') road = data?.rows?.[0]?.elements || null;
    } catch (err) {
      logger.warn({ err: err.message }, '[places] road distances failed, using straight-line distances');
    }
  }
  matches.forEach((m, i) => {
    const el = road && road[i];
    if (el && el.status === 'OK' && el.distance?.value) {
      m.distanceKm = Math.round(el.distance.value / 100) / 10;
      m.approx = false;
    } else {
      m.distanceKm = Math.round(straightKm(origin, m) * 10) / 10;
      m.approx = true;
    }
  });
  return matches;
}

module.exports = { searchPlaces, addDistances };
