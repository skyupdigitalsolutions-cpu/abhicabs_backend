'use strict';

/**
 * src/services/providers/maps.provider.js
 *
 * The provider interface every maps adapter implements, plus the factory that
 * selects one from configuration.
 *
 * ---------------------------------------------------------------------------
 * WHY AN INTERFACE RATHER THAN CALLING GOOGLE DIRECTLY
 * ---------------------------------------------------------------------------
 * Three reasons, in order of how much time each saves:
 *
 *  1. The provider decision is still open. Building against an interface means
 *     Day 4 is not blocked waiting for it, and switching later is one env var.
 *
 *  2. The mock provider makes every downstream day testable offline, with no
 *     API key and no per-call cost. Days 5, 9 and 11 all need distances.
 *
 *  3. Maps is likely to be the second-largest bill after servers. Being able to
 *     A/B two providers on real traffic — cost against accuracy — is worth far
 *     more than the small cost of the abstraction.
 *
 * Every adapter returns the SAME shape, so nothing downstream knows or cares
 * which one is active.
 */

const env = require('../../config/env');

/**
 * @typedef {object} DistanceResult
 * @property {number} distanceKm
 * @property {number} durationMin
 * @property {string} provider
 * @property {boolean} estimated   true when derived rather than routed
 *
 * @typedef {object} GeocodeResult
 * @property {number} lat
 * @property {number} lng
 * @property {string} formattedAddress
 * @property {string|null} placeId
 * @property {string} provider
 */

/** Every adapter must implement these four. */
const REQUIRED_METHODS = ['getDistanceMatrix', 'geocode', 'reverseGeocode', 'autocomplete'];

function assertImplements(adapter, name) {
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length) {
    throw new Error(`[maps] Provider "${name}" is missing: ${missing.join(', ')}`);
  }
  return adapter;
}

let cached = null;

/**
 * Returns the configured adapter.
 *
 * Falls back to the mock rather than throwing when a real provider has no API
 * key. A missing key should degrade fare estimates to arithmetic, not take the
 * whole application down — and in development it means the app runs with no
 * setup at all.
 */
function getProvider() {
  if (cached) return cached;

  const name = (env.maps.provider || 'mock').toLowerCase();

  const build = () => {
    switch (name) {
      case 'google':
        if (!env.maps.apiKey) {
          console.warn('[maps] MAPS_PROVIDER=google but MAPS_API_KEY is empty — using mock');
          return require('./mock.maps');
        }
        return require('./google.maps');

      case 'ola':
        if (!env.maps.apiKey) {
          console.warn('[maps] MAPS_PROVIDER=ola but MAPS_API_KEY is empty — using mock');
          return require('./mock.maps');
        }
        return require('./ola.maps');

      case 'mock':
        return require('./mock.maps');

      default:
        console.warn(`[maps] Unknown MAPS_PROVIDER "${name}" — using mock`);
        return require('./mock.maps');
    }
  };

  cached = assertImplements(build(), name);
  console.log(`[maps] provider: ${cached.name}`);
  return cached;
}

/** Test hook — lets a suite inject a fake without touching env. */
function setProvider(adapter) {
  cached = adapter ? assertImplements(adapter, 'injected') : null;
}

module.exports = { getProvider, setProvider, REQUIRED_METHODS };