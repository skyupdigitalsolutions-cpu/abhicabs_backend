'use strict';

/**
 * src/services/surge.service.js
 *
 * Decides what a booking's urgency costs, from WHERE it starts and HOW SOON.
 *
 * ---------------------------------------------------------------------------
 * WHY TIERS
 * ---------------------------------------------------------------------------
 * The old rule was one flat 5% on anything inside thirty minutes, anywhere.
 * That priced a 4am village pickup exactly like a city-centre one, and the two
 * are not alike: a metro has drivers idle a few streets away, while a village
 * may have one car twenty minutes out and no second option if it declines.
 *
 * So the premium follows supply, not just the clock:
 *
 *   METRO    urgency only — 5% inside the hour, nothing when scheduled
 *   TALUKA   5% standing, 15% inside the hour
 *   VILLAGE  10% standing, 15% inside the hour
 *
 * Every one of those numbers lives in surge_rules and is editable by an admin.
 * Nothing here hardcodes a percentage.
 */

const { prisma } = require('../config/prisma');
const geo = require('../lib/geo');
const cache = require('./cache.service');

const AREAS_KEY = 'surge:areas:v1';
const RULES_KEY = 'surge:rules:v1';

/**
 * Six hours. These change when an admin changes them, which is rarely — and
 * every write invalidates, so the TTL is only a backstop against a missed
 * invalidation rather than the mechanism.
 */
const TTL = 6 * 60 * 60;

/**
 * The tier used when a pickup matches no configured area.
 *
 * METRO on purpose: it is the CHEAPEST tier, so an unclassified place can
 * never overcharge. Getting this backwards would quietly bill village rates
 * across an entire city the day someone forgot to add an area.
 */
const FALLBACK_TIER = 'METRO';

async function loadAreas() {
  return cache.getOrSet(
    AREAS_KEY,
    () =>
      prisma.serviceArea.findMany({
        where: { isActive: true },
        select: { id: true, name: true, tier: true, centreLat: true, centreLng: true, radiusKm: true },
      }),
    { ttl: TTL, cacheNull: false },
  );
}

async function loadRules() {
  return cache.getOrSet(
    RULES_KEY,
    () => prisma.surgeRule.findMany({ where: { isActive: true } }),
    { ttl: TTL, cacheNull: false },
  );
}

async function invalidate() {
  await Promise.all([cache.del(AREAS_KEY), cache.del(RULES_KEY)]);
}

/**
 * Which area a point falls in.
 *
 * Among every area whose radius contains the point, the one whose CENTRE is
 * nearest wins. That tie-break is the whole reason nested areas work: a
 * village sits inside a metro's 60 km radius, and without it the metro would
 * claim it and price the trip as if drivers were plentiful. The tighter,
 * closer circle is the more specific answer.
 */
async function classify(point) {
  if (!point || !geo.isValidCoordinate(point)) {
    return { tier: FALLBACK_TIER, area: null, matched: false };
  }

  const areas = await loadAreas();

  let best = null;
  let bestDistance = Infinity;

  for (const area of areas) {
    const centre = { lat: Number(area.centreLat), lng: Number(area.centreLng) };
    const distance = geo.haversineKm(point, centre);
    if (distance <= area.radiusKm && distance < bestDistance) {
      best = area;
      bestDistance = distance;
    }
  }

  if (!best) return { tier: FALLBACK_TIER, area: null, matched: false };

  return {
    tier: best.tier,
    area: { id: best.id, name: best.name, tier: best.tier, distanceKm: Number(bestDistance.toFixed(2)) },
    matched: true,
  };
}

/**
 * The surge multiplier for a pickup.
 *
 * Returns a MULTIPLIER (1.05), not a percentage, because that is what
 * fare.service multiplies the subtotal by and what fare_configs clamps with
 * minSurge/maxSurge. The percentage is carried alongside for the breakdown
 * line, so the rider reads "5%" rather than "1.05x".
 *
 * `requestedSurge` is treated as a FLOOR, never a ceiling — an admin tool can
 * push a quote higher, but nothing a client sends can push it below what the
 * booking earns. The app has no business sending a number that changes price.
 */
async function resolveSurge({ pickupPoint, pickupAt, requestedSurge = 1 }) {
  const when = pickupAt instanceof Date ? pickupAt : new Date(pickupAt);
  const minutesToPickup = Math.round((when.getTime() - Date.now()) / 60000);

  const { tier, area, matched } = await classify(pickupPoint);

  const rules = await loadRules();
  const rule = rules.find((r) => r.tier === tier);

  // No rule row for this tier — someone deactivated it. Charging nothing is
  // the safe direction: a missing configuration must not invent a premium.
  if (!rule) {
    return {
      surge: Math.max(Number(requestedSurge) || 1, 1),
      pct: 0,
      tier,
      area,
      matched,
      // A pickup in the past is a scheduling error the validator rejects; it
      // is clamped here so it cannot read as negative urgency.
      minutesToPickup: Math.max(0, minutesToPickup),
      immediate: false,
      reason: null,
    };
  }

  const immediate = minutesToPickup <= rule.immediateWithinMinutes;
  const pct = Number(immediate ? rule.immediatePct : rule.standardPct);

  const base = Number(requestedSurge) > 0 ? Number(requestedSurge) : 1;
  const fromRule = 1 + pct / 100;
  const surge = Math.max(base, fromRule);

  return {
    surge,
    pct,
    tier,
    area,
    matched,
    minutesToPickup: Math.max(0, minutesToPickup),
    immediate,
    reason: pct > 0 ? buildReason({ pct, immediate, tier, area, rule }) : null,
  };
}

/**
 * The sentence shown under the fare line.
 *
 * Named rather than generic: "Booked within the hour in a village area" tells
 * a rider why they are paying more and is something support can defend. A bare
 * "Demand pricing" invites the argument instead of ending it.
 */
function buildReason({ pct, immediate, tier, area, rule }) {
  const where = area ? area.name : tier.toLowerCase();
  if (immediate) {
    const hrs = rule.immediateWithinMinutes;
    const window = hrs === 60 ? 'the hour' : `${hrs} minutes`;
    return `${pct}% added — booked within ${window} of pickup in ${where}.`;
  }
  return `${pct}% added — ${where} is served from further away.`;
}

module.exports = {
  classify,
  resolveSurge,
  invalidate,
  FALLBACK_TIER,
};