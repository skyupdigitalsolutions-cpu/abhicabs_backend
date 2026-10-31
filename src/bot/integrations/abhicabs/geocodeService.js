const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

/**
 * Turns a shared map pin (lat/lng) into a readable address using the Google Geocoding API.
 * Returns null when no key is set, the API is not enabled for the key, or nothing is found —
 * the caller then falls back to showing the coordinates. Never logs the API key.
 */
async function reverseGeocode(latitude, longitude) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key || latitude == null || longitude == null) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${latitude},${longitude}`, region: 'in', key },
      timeout: 8000,
    });
    const address = data?.results?.[0]?.formatted_address;
    if (data?.status === 'OK' && address) return address;
    logger.warn({ status: data?.status, message: data?.error_message }, '[geocode] could not turn the pin into an address');
  } catch (err) {
    logger.error({ err: err.message }, '[geocode] request failed');
  }
  return null;
}

module.exports = { reverseGeocode };
