'use strict';

/**
 * src/services/fareLookup.service.js
 *
 * THE single place that answers "which rate card prices this trip?".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * Four call sites used to each write their own `prisma.fareConfig.findFirst({
 * where: { cityId, vehicleClass, tripType, isActive: true } })` — quote.service
 * (twice), cancellation.service (three times). They agreed by coincidence, not
 * by construction: cancellation's copies had already drifted, omitting the
 * `effectiveFrom <= now` filter, so a price rise staged for next month was
 * quoting next month's cancellation fee today.
 *
 * Now that resolution has two levels — a city card, falling back to a state
 * card — a copy that misses the fallback does not fail loudly. It silently
 * prices a statewide city at zero cancellation fee, or refuses a quote in a
 * city the admin can plainly see is priced. So the lookup lives here once.
 *
 * It deliberately does NOT depend on quote.service: quote.service depends on
 * this, and fareConfig.service depends on both. Keep it that way — a require
 * back up the chain makes a cycle.
 *
 * ---------------------------------------------------------------------------
 * MOST SPECIFIC WINS
 * ---------------------------------------------------------------------------
 *   1. a CITY card for this city          -> used
 *   2. otherwise a STATE card for its state -> used
 *   3. otherwise nothing                   -> caller raises FARE_CONFIG_MISSING
 *
 * Within each level the most recent card whose effectiveFrom has passed wins,
 * which is what lets a price change be staged in advance and switch itself on
 * at midnight.
 *
 * The city level wins OUTRIGHT — it is not compared on date with the state
 * level. An admin who sets Bengaluru to Rs 19/km means it regardless of
 * whether the Karnataka card was edited more recently, and a rule that let a
 * state edit silently override a city exception would make the exception
 * unreliable exactly when it mattered.
 */

const { prisma } = require('../config/prisma');
const cache = require('./cache.service');

/* ------------------------------------------------------------------ *
 * Scope keys
 * ------------------------------------------------------------------ */

/**
 * The canonical form of a state name.
 *
 * MUST stay identical to the expression in the fare_configs_scope_shape check
 * constraint (20261007093000_statewide_rate_cards). If they drift, inserts
 * fail — which is the safe direction, and far better than two rows both
 * claiming to be Karnataka.
 */
function normaliseState(state) {
  return String(state || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const cityScopeKey = (cityId) => `city:${Number(cityId)}`;
const stateScopeKey = (state) => `state:${normaliseState(state)}`;

/* ------------------------------------------------------------------ *
 * Cities
 * ------------------------------------------------------------------ */

/**
 * The city row, from the same cache key and with the same filter as
 * quote.getCity — on purpose, so the two share one entry instead of holding
 * two copies that can disagree after an admin deactivates a city.
 */
async function getCity(cityId) {
  return cache.getOrSet(
    `city:${Number(cityId)}`,
    () => prisma.city.findFirst({ where: { id: Number(cityId), isActive: true } }),
    { ttl: cache.TTL.STATIC },
  );
}

/**
 * Every active city a state card covers.
 *
 * Matching is done in JS on the normalised name rather than in SQL, because
 * cities.state is free text an admin typed: "Karnataka", "karnataka" and
 * "Karnataka " are one state to a human and three to a `WHERE state = ?`.
 * The table is tens of rows, so reading it whole costs nothing.
 */
async function citiesInState(state, { includeInactive = false } = {}) {
  const want = normaliseState(state);
  const rows = await prisma.city.findMany({
    where: includeInactive ? {} : { isActive: true },
    select: { id: true, name: true, state: true, isActive: true },
    orderBy: { name: 'asc' },
  });
  return rows.filter((c) => normaliseState(c.state) === want);
}

/** Distinct states that have at least one city, with how many each has. */
async function listStates({ includeInactive = false } = {}) {
  const rows = await prisma.city.findMany({
    where: includeInactive ? {} : { isActive: true },
    select: { id: true, name: true, state: true, isActive: true },
    orderBy: [{ state: 'asc' }, { name: 'asc' }],
  });

  const byKey = new Map();
  for (const c of rows) {
    const key = normaliseState(c.state);
    if (!key) continue;
    if (!byKey.has(key)) {
      // The first spelling seen becomes the display name. Arbitrary but
      // stable, and the key is what anything actually matches on.
      byKey.set(key, { state: String(c.state).trim(), key, cityCount: 0, cities: [] });
    }
    const entry = byKey.get(key);
    entry.cityCount += 1;
    entry.cities.push({ id: c.id, name: c.name, isActive: c.isActive });
  }

  const states = [...byKey.values()].sort((a, b) => a.state.localeCompare(b.state));
  return { states, total: states.length };
}

/* ------------------------------------------------------------------ *
 * The lookup
 * ------------------------------------------------------------------ */

const liveWhere = (at) => ({ isActive: true, effectiveFrom: { lte: at } });

/**
 * The card that prices (city, class, trip type) right now.
 *
 * @param {object}  args
 * @param {number} [args.cityId]  looked up (cached) when `city` is not given
 * @param {object} [args.city]    a city row, if the caller already has one
 * @param {string}  args.vehicleClass
 * @param {string}  args.tripType
 * @param {Date}   [args.at]      point in time; defaults to now
 * @returns {Promise<object|null>} the fare_configs row, or null
 */
async function findActiveCard({ cityId, city, vehicleClass, tripType, at = new Date() }) {
  const cityRow = city || (cityId != null ? await getCity(cityId) : null);
  if (!cityRow) return null;

  const base = { vehicleClass, tripType, ...liveWhere(at) };
  const newestFirst = { effectiveFrom: 'desc' };

  /*
   * Both levels are fetched together rather than city-then-state-if-null.
   *
   * This is the hottest path in the system — every quote, every fare option on
   * the booking screen — and the state query is an index seek on
   * fare_configs_scope_unique returning at most a handful of rows. One round
   * trip of two cheap reads beats two sequential round trips on the common
   * case where the city has no card of its own.
   */
  const [cityCard, stateCard] = await Promise.all([
    prisma.fareConfig.findFirst({
      where: { ...base, scopeKey: cityScopeKey(cityRow.id) },
      orderBy: newestFirst,
    }),
    cityRow.state
      ? prisma.fareConfig.findFirst({
          where: { ...base, scopeKey: stateScopeKey(cityRow.state) },
          orderBy: newestFirst,
        })
      : Promise.resolve(null),
  ]);

  return cityCard || stateCard || null;
}

/**
 * Same question, but says WHICH level answered it.
 *
 * Used by the admin coverage screen, where "priced by the Karnataka card" and
 * "priced by its own card" are different facts and the difference is the whole
 * reason an admin opened the screen.
 */
async function resolveCard(args) {
  const cityRow = args.city || (args.cityId != null ? await getCity(args.cityId) : null);
  if (!cityRow) return { card: null, source: 'NONE', city: null };

  const card = await findActiveCard({ ...args, city: cityRow });
  if (!card) return { card: null, source: 'NONE', city: cityRow };

  return {
    card,
    source: card.scope === 'STATE' ? 'STATE' : 'CITY',
    city: cityRow,
  };
}

/**
 * The scope fields for a write, derived from what the admin sent.
 *
 * Centralised so scope, cityId, state and scopeKey can never be set
 * independently of one another — the check constraint rejects a row where they
 * disagree, and discovering that through a 500 from Postgres is a worse
 * experience than not being able to express it.
 */
function buildScopeFields({ scope, cityId, state, city }) {
  if (scope === 'STATE') {
    const name = String(state).trim();
    return {
      scope: 'STATE',
      cityId: null,
      state: name,
      scopeKey: stateScopeKey(name),
    };
  }
  return {
    scope: 'CITY',
    cityId: Number(cityId),
    // Denormalised from the city so the list screen can filter by state
    // without a join. The check constraint does not police it for city rows.
    state: city ? String(city.state).trim() : undefined,
    scopeKey: cityScopeKey(cityId),
  };
}

/** How a card describes itself in a message: "Karnataka (all cities)" / "Bengaluru". */
function scopeLabel(card) {
  if (!card) return '';
  if (card.scope === 'STATE') return `${card.state} (all cities)`;
  return card.city ? card.city.name : `city ${card.cityId}`;
}

module.exports = {
  normaliseState,
  cityScopeKey,
  stateScopeKey,
  getCity,
  citiesInState,
  listStates,
  findActiveCard,
  resolveCard,
  buildScopeFields,
  scopeLabel,
};