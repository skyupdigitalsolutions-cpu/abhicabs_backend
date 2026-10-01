'use strict';

/**
 * src/services/surge.service.js
 *
 * Decides what a booking's urgency costs, from WHERE it starts and HOW SOON.
 *
 * ---------------------------------------------------------------------------
 * SURGE APPLIES INSIDE METRO AREAS ONLY
 * ---------------------------------------------------------------------------
 * This is the current commercial policy and it is enforced here, in code,
 * rather than only by leaving the other tiers' percentages at zero.
 *
 * The reasoning is the same as the airport allowance exemption in
 * fare.service: a rule that lives only in data survives exactly until someone
 * seeds a new tier by copying an existing row, and then it is silently gone
 * with nothing to show that it ever applied. Keeping it here makes "we surge
 * in metros" a property of the product. The migration still zeroes and
 * deactivates the non-metro rules so the table reads honestly, but the
 * resolver does not depend on that having been done.
 *
 * It also inverts an asymmetry that was hard to defend. The old tiers charged
 * MORE in a village (10% standing, 15% urgent) than in a city, on the argument
 * that supply is thinner there. That is true, and it meant the customers with
 * the fewest alternatives paid the largest premium. A metro is where demand
 * genuinely spikes against a pool of nearby cars, and it is the only place a
 * premium actually buys the rider a faster pickup.
 *
 * ---------------------------------------------------------------------------
 * ONLY AN ADMIN SETS THE NUMBER
 * ---------------------------------------------------------------------------
 * Nothing here hardcodes a percentage. Every figure comes from a surge_rules
 * row, written through PATCH /admin/surge/rules/:tier, which sits behind the
 * FARE_EDIT permission — the same bar as editing a rate card — and is audited
 * as SURGE_RULE_UPDATED with the before and after values.
 *
 * The METRO rule ships at 0%, so enabling surge is a deliberate act by an
 * admin rather than something that switches itself on at deploy. Until then
 * the pipeline runs and charges nothing.
 *
 * `requestedSurge` from a client can only ever act as a floor of 1 (see
 * resolveSurge), and fare.service clamps the result to the rate card's own
 * min/max band. So there are three gates between a request and a premium, and
 * a client controls none of them.
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
 * The tiers a premium may be charged in. Metro only — see the module note.
 *
 * A Set rather than a string comparison so opening a second tier later is one
 * entry here plus an admin filling in that tier's percentages, with no logic
 * to rewrite.
 *
 * NOTE THE INTERACTION WITH FALLBACK_TIER, which is also METRO. An unmatched
 * pickup — one in no configured service area — therefore lands in the only
 * surgeable tier. That is safe because the METRO rule's percentages are what
 * decide the money, and they start at zero: an unclassified place can only
 * ever be charged what an admin has deliberately set for metros. It is also
 * why `matched` travels in the result, so a quote can say whether the tier was
 * a real classification or a default.
 */
const SURGEABLE_TIERS = new Set(['METRO']);

/** Is demand pricing charged at all in this tier? */
function isSurgeable(tier) {
  return SURGEABLE_TIERS.has(tier);
}

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
   * Nothing to charge, for either of two reasons:
   *
   *   • the tier is not surgeable — currently anything that is not METRO, and
   *     checked BEFORE the rule is read so a stray non-zero percentage left on
   *     a taluka or village row cannot reach a fare, or
   *   • there is no active rule row for the tier, which means an admin
   *     deactivated it. A missing configuration must never invent a premium.
   *
   * `surgeable` travels back so a quote can distinguish "no premium applies
   * here" from "the premium happens to be 0% today" without re-deriving the
   * policy.
   */
  const surgeable = isSurgeable(tier);

  if (!surgeable || !rule) {
    return {
      // Never below 1: a client cannot discount a fare by asking.
      surge: Math.max(Number(requestedSurge) || 1, 1),
      pct: 0,
      tier,
      area,
      matched,
      surgeable,
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
    const hrs = rule.immediateWithinMinutes;
    const window = hrs === 60 ? 'the hour' : `${hrs} minutes`;
    return `${pct}% added — booked within ${window} of pickup in ${where}.`;
  }
  /*
   * The scheduled-booking line used to say the area "is served from further
   * away", which was written for the village tier and is simply untrue of a
   * metro — the only tier that can reach this branch now. A rider who can see
   * cars on the map a street away reads that as an excuse.
   *
   * It says demand instead, which is what a standing metro percentage actually
   * represents and what support can defend on the phone.
   */
  return `${pct}% added — demand is high in ${where}.`;
}

module.exports = {
  classify,
  resolveSurge,
  invalidate,
  isSurgeable,
  FALLBACK_TIER,
  SURGEABLE_TIERS,
};