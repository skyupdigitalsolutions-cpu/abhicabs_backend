'use strict';

/**
 * src/services/surge.service.js
 *
 * Decides what a booking's urgency costs, from WHERE it starts and HOW SOON.
 *
 * ---------------------------------------------------------------------------
 * WHY TIERS
 * ---------------------------------------------------------------------------
 * A flat percentage on anything booked at short notice prices a 4am village
 * pickup exactly like a city-centre one, and the two are not alike: a metro
 * has drivers idle a few streets away, while a village may have one car twenty
 * minutes out and no second option if it declines.
 *
 * So the premium follows SUPPLY, not just the clock. Four tiers, each with its
 * own standing percentage and its own short-notice percentage:
 *
 *   METRO     dense fleet, a booking can be filled within the hour
 *   DISTRICT  a district headquarters with real fleet presence, not a city
 *   TALUKA    a town served from further out
 *   VILLAGE   thin supply, often a single car, no fallback if it declines
 *
 * EVERY ONE OF THOSE NUMBERS LIVES IN surge_rules AND IS SET BY AN ADMIN from
 * the dashboard. Nothing here hardcodes a percentage, and nothing here decides
 * which tiers may charge — a tier with a rule row charges what that row says.
 *
 * ---------------------------------------------------------------------------
 * THE SHORT-NOTICE WINDOW IS PER TIER
 * ---------------------------------------------------------------------------
 * `immediateWithinMinutes` is a column, not a constant, because "short notice"
 * means different things by tier. A metro can fill a booking inside the hour;
 * a village cannot, so outside the cities the window is measured in hours —
 * the business works to a two-to-four hour horizon, which is roughly the point
 * at which finding a car stops being a scramble.
 *
 * ---------------------------------------------------------------------------
 * ONLY AN ADMIN SETS THE NUMBER
 * ---------------------------------------------------------------------------
 * Every figure comes from a surge_rules row, written through
 * PATCH /admin/surge/rules/:tier, which sits behind the FARE_EDIT permission —
 * the same bar as editing a rate card — and is audited as SURGE_RULE_UPDATED
 * with the before and after values.
 *
 * `requestedSurge` from a client can only ever act as a floor of 1 (see
 * resolveSurge), and fare.service clamps the result to the rate card's own
 * min/max band. So a client controls nothing: not whether a premium applies,
 * not how large it is, and not whether its own request is honoured.
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

/**
 * Every configured tier may charge. There is no allowlist here any more.
 *
 * An earlier version restricted surge to METRO in code. That was the right
 * shape for "surge in metro cities" taken literally, and the wrong shape for
 * the actual commercial policy, which prices all four tiers — so it is gone.
 *
 * WHAT DECIDES A PREMIUM NOW IS THE surge_rules ROW, and nothing else:
 *   • no row for the tier          -> no premium
 *   • row with is_active = false   -> no premium
 *   • row with 0 / 0               -> no premium, but the tier is "on"
 *
 * That is deliberately all in data. An admin opening or closing surge for a
 * tier is a commercial decision made on a Tuesday afternoon; it should not
 * need a developer, a deploy and a release window. The audit log records who
 * changed what, which is the control that actually matters.
 *
 * FALLBACK_TIER still governs a pickup in no configured area — see classify.
 */

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

  /*
   * Nothing to charge, because the tier has no active rule row — either it was
   * never configured, or an admin switched it off.
   *
   * Charging nothing is the safe direction: a missing configuration must never
   * invent a premium. The alternative (fall back to another tier's numbers)
   * would mean a half-finished setup silently billing rural riders at whatever
   * the metro rate happened to be.
   */

  if (!rule) {
    return {
      // Never below 1: a client cannot discount a fare by asking.
      surge: Math.max(Number(requestedSurge) || 1, 1),
      pct: 0,
      tier,
      area,
      matched,
      // False only when the tier has no active rule. Lets a quote distinguish
      // "surge is not configured here" from "the premium is 0% today".
      surgeable: false,
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
    surgeable: true,
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
    /*
     * The window, said the way a person would say it. The raw column is
     * minutes, and "booked within 240 minutes of pickup" is arithmetic the
     * rider should not have to do to understand a charge on their own fare.
     */
    const mins = rule.immediateWithinMinutes;
    let window;
    if (mins === 60) window = 'the hour';
    else if (mins % 60 === 0) window = `${mins / 60} hours`;
    else window = `${mins} minutes`;
    return `${pct}% added — booked within ${window} of pickup in ${where}.`;
  }
  /*
   * The standing percentage, which means different things by tier — so the
   * line does too.
   *
   * In a metro a standing premium is demand: there are cars nearby and the
   * price reflects how many people want them. Outside one it is distance and
   * scarcity: the car is coming from further away and there may be only one.
   * Telling a village rider "demand is high" when they can see an empty road
   * reads as an excuse; telling a city rider the area "is served from further
   * away" when cars are visibly a street away reads the same.
   */
  if (tier === 'METRO') return `${pct}% added — demand is high in ${where}.`;
  return `${pct}% added — ${where} is served from further away.`;
}

module.exports = {
  classify,
  resolveSurge,
  invalidate,
  FALLBACK_TIER,
};