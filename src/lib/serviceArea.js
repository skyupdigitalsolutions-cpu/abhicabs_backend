'use strict';

/**
 * src/lib/serviceArea.js
 *
 * Which Indian states the fleet operates in, and the one place that decides
 * whether a given address is inside them.
 *
 * ---------------------------------------------------------------------------
 * WHY A STATE ALLOWLIST AND NOT A RADIUS
 * ---------------------------------------------------------------------------
 * cities.radiusKm already answers "is this pickup within reach of a city we
 * serve", which is the right question for picking a RATE CARD and the wrong one
 * for jurisdiction. A pickup in a small town 90 km from Hyderabad is outside
 * every radius and is still a trip the fleet runs, because there are cars and
 * drivers in Telangana. Radius is geometry; this is permits and presence.
 *
 * cities.state is not the answer either. That column says where each city row
 * sits, so deriving the allowlist from it would confine the fleet to the exact
 * towns that happen to have a rate card.
 *
 * ---------------------------------------------------------------------------
 * THIS LIST GATES ORIGINS, NOT DESTINATIONS
 * ---------------------------------------------------------------------------
 * Read it as "where can we SOURCE a car", not "where may a trip go". Those are
 * different questions and only the first one has a hard answer: a car exists in
 * a yard or it does not.
 *
 * A trip starting in a listed state may be dropped ANYWHERE. Bengaluru to
 * Chennai is an ordinary outstation run — the permit covers it, the driver
 * does it, the car comes home. Only the pickup is checked, in
 * quote.service.assertPickupWithinServiceStates. A pickup in a state that is
 * not listed has no car to send, so it becomes a booking request instead and an
 * admin decides whether to deadhead one out to it.
 *
 * ---------------------------------------------------------------------------
 * THE LIST LIVES IN THE DATABASE
 * ---------------------------------------------------------------------------
 * Opening a new state is an operational decision, usually made the week a
 * permit clears. It should not need a developer, a deploy and a release window.
 * So the list is a table an admin edits, and this module caches it.
 *
 * The cache is why `checkPlace` is ASYNC. Without it, every quote would issue a
 * query just to re-read four rows that change a few times a year; with it, a
 * state added at 11:00 is live everywhere by 11:01 without a restart.
 *
 * ---------------------------------------------------------------------------
 * MATCHING IS DELIBERATELY FORGIVING
 * ---------------------------------------------------------------------------
 * The state arrives as free text from a maps provider, and providers are not
 * consistent: "Andhra Pradesh", "AP", "Telengana" (a common misspelling that
 * appears in real data), "Maharastra". A strict equality check would refuse
 * service to a rider standing in Hyderabad because a Google response spelled
 * their state differently this week.
 *
 * So each state carries aliases, and everything is compared with spaces,
 * punctuation and case stripped out.
 */

const { prisma } = require('../config/prisma');
const env = require('../config/env');

/**
 * The states shipped with the code.
 *
 * NOT the source of truth — the table is. These are the seed, and the fallback
 * for when the database cannot be read. Without a fallback, a transient
 * connection failure would empty the allowlist and turn every booking in the
 * country into an out-of-area request: a total outage that looks like a
 * deliberate product decision.
 */
const BUILT_IN = [
  { name: 'Karnataka', aliases: ['ka', 'karnatak'] },
  { name: 'Telangana', aliases: ['tg', 'ts', 'telengana', 'telangna'] },
  { name: 'Andhra Pradesh', aliases: ['ap', 'andhra', 'andrapradesh', 'andhrapradhesh'] },
  { name: 'Maharashtra', aliases: ['mh', 'maharastra', 'maharashtr', 'maharashta'] },
];

/** Lower-case, strip everything that is not a letter or digit. */
function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

const TTL_MS = Number(env.serviceArea?.cacheMs || 60_000);

let cache = null;
let cachedAt = 0;

/** Drop the cache. Called after any admin write so a change is instant. */
function invalidate() {
  cache = null;
  cachedAt = 0;
}

/**
 * The active states, from the table.
 *
 * Three fallbacks, in order, because this function must never return an empty
 * list:
 *   1. the table, when it has active rows
 *   2. the last good cache, if the query throws — a stale allowlist is far
 *      better than none, and states change a few times a year
 *   3. BUILT_IN, on a cold start with an unreachable database
 */
async function load() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;

  try {
    const rows = await prisma.serviceState.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { name: true, aliases: true },
    });

    if (rows.length > 0) {
      cache = rows.map((r) => ({
        name: r.name,
        aliases: Array.isArray(r.aliases) ? r.aliases : [],
      }));
      cachedAt = Date.now();
      return cache;
    }

    // Table exists but is empty — before the seed has run, most likely. Use the
    // built-ins rather than refusing the whole country, and do NOT cache, so
    // the first real row takes effect immediately.
    return BUILT_IN;
  } catch (err) {
    console.warn(`[serviceArea] could not read service_states: ${err.message}`);
    return cache || BUILT_IN;
  }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

/** Human-readable list for error messages and the app. */
async function allowedStateNames() {
  return (await load()).map((s) => s.name);
}

/**
 * Resolve free text to a canonical state name, or null if it is not one of
 * ours.
 *
 * Substring matching is a last resort, because providers sometimes hand back
 * the whole formatted address instead of just the component — matching
 * "karnataka" inside "…, Bengaluru, Karnataka 560034, India" is exactly what is
 * wanted there. Checked LAST so an exact name always wins.
 */
async function canonicalState(value) {
  const n = normalise(value);
  if (!n) return null;

  const states = await load();

  for (const state of states) {
    if (n === normalise(state.name)) return state.name;
  }
  for (const state of states) {
    if ((state.aliases || []).some((a) => n === normalise(a))) return state.name;
  }
  for (const state of states) {
    if (n.includes(normalise(state.name))) return state.name;
  }
  return null;
}

/**
 * Is this place somewhere the fleet can source a car from?
 *
 * Call it on a PICKUP. Calling it on a drop and refusing the trip is the bug
 * this module used to have — see the header. It is still called on drop
 * addresses in bookingRequest.service, but only to canonicalise the state for
 * the record, never to decide anything.
 *
 * @param {{ state?: string|null, formattedAddress?: string|null }} place
 * @returns {Promise<{ ok: boolean, state: string|null, allowed: string[] }>}
 *
 * Falls back to the formatted address when no state component came through. An
 * older cached geocode, or a provider that does not return components, must not
 * be treated as "outside" — that would turn working addresses into booking
 * requests for reasons the rider cannot see.
 */
async function checkPlace(place = {}) {
  const state =
    (await canonicalState(place.state)) ?? (await canonicalState(place.formattedAddress));

  return { ok: state !== null, state, allowed: await allowedStateNames() };
}

/**
 * Pull the state out of a Google-style address_components array.
 *
 * administrative_area_level_1 is the state in India. Synchronous on purpose —
 * it only parses a payload and touches no allowlist, so the maps providers can
 * call it inline.
 */
function stateFromComponents(components) {
  if (!Array.isArray(components)) return null;
  const hit = components.find((c) => (c.types || []).includes('administrative_area_level_1'));
  return hit ? hit.long_name || hit.short_name || null : null;
}

/**
 * Pull the country out of a Google-style address_components array.
 *
 * Returns the LONG name ("India"), because that is what lib/india.js compares
 * against and what an error message shows a customer. Synchronous and total,
 * like its siblings: a geocode must not fail because a place has no country
 * component, so a missing one is null and the caller falls back to the address
 * string or the bounding box.
 */
function countryFromComponents(components) {
  if (!Array.isArray(components)) return null;
  const hit = components.find((c) => (c.types || []).includes('country'));
  return hit ? hit.long_name || hit.short_name || null : null;
}

/**
 * Pull the city or town out of a Google-style address_components array.
 *
 * Google has no single "city" type, so this takes the most specific name it
 * offers, in order:
 *   locality                      the city or town ("Bengaluru", "Hubballi")
 *   postal_town                   used instead of locality in some regions
 *   administrative_area_level_3   the taluk, for a village with no locality
 *   administrative_area_level_2   the district ("Bangalore Urban"), last resort
 *
 * Synchronous and total, like stateFromComponents: it only parses a payload,
 * and returns null — never throws — when nothing fits, because a geocode must
 * not fail just because a place has no city name attached.
 */
function cityFromComponents(components) {
  if (!Array.isArray(components)) return null;
  const order = [
    'locality',
    'postal_town',
    'administrative_area_level_3',
    'administrative_area_level_2',
  ];
  for (const type of order) {
    const hit = components.find((c) => (c.types || []).includes(type));
    if (hit) return hit.long_name || hit.short_name || null;
  }
  return null;
}

module.exports = {
  BUILT_IN,
  load,
  invalidate,
  allowedStateNames,
  canonicalState,
  checkPlace,
  stateFromComponents,
  countryFromComponents,
  cityFromComponents,
  normalise,
};