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
const ROUTES_KEY = 'surge:routes:v1';

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

async function loadRoutes() {
  return cache.getOrSet(
    ROUTES_KEY,
    () => prisma.surgeRoute.findMany({ where: { isActive: true } }),
    { ttl: TTL, cacheNull: false },
  );
}

async function invalidate() {
  await Promise.all([cache.del(AREAS_KEY), cache.del(RULES_KEY), cache.del(ROUTES_KEY)]);
}

/* ------------------------------------------------------------------ *
 * Route surge
 * ------------------------------------------------------------------ */

/** Is `when` inside a rule's window? Open-ended on either side. */
function withinWindow(rule, when) {
  if (rule.startsAt && when < new Date(rule.startsAt)) return false;
  if (rule.endsAt && when > new Date(rule.endsAt)) return false;
  return true;
}

/** Does this trip run along this corridor, in either permitted direction? */
function matchesCorridor(rule, pickup, drop) {
  const origin = { lat: Number(rule.originLat), lng: Number(rule.originLng) };
  const dest = { lat: Number(rule.destLat), lng: Number(rule.destLng) };

  const forward =
    geo.haversineKm(pickup, origin) <= rule.originRadiusKm &&
    geo.haversineKm(drop, dest) <= rule.destRadiusKm;
  if (forward) return 'FORWARD';

  if (!rule.bidirectional) return null;

  const back =
    geo.haversineKm(pickup, dest) <= rule.destRadiusKm &&
    geo.haversineKm(drop, origin) <= rule.originRadiusKm;
  return back ? 'RETURN' : null;
}

/**
 * The corridor premium for a trip, or null.
 *
 * ---------------------------------------------------------------------------
 * WHEN SEVERAL RULES MATCH, THE HIGHEST PERCENTAGE WINS
 * ---------------------------------------------------------------------------
 * Overlapping corridors are not a misconfiguration to be prevented — a
 * standing "BLR to Mysuru +10%" and a "Dussehra +25%" on top of it is exactly
 * how an admin would express a festival, by adding the second rather than
 * editing and then having to remember to restore the first.
 *
 * Highest-wins rather than summing, because the alternative compounds: three
 * overlapping rules at 20% would quietly become 60%, which nobody configured
 * and nobody would notice until a customer did. The rate card's maxSurge still
 * caps whatever comes out of here, but a cap is a backstop, not a design.
 *
 * Ties break on the NARROWEST corridor — the more specific rule is the more
 * deliberate one — and then on id, so the answer is stable across requests
 * rather than depending on row order.
 */
async function matchRoute({ pickupPoint, dropPoint, pickupAt }) {
  if (!pickupPoint || !dropPoint) return null;
  if (!geo.isValidCoordinate(pickupPoint) || !geo.isValidCoordinate(dropPoint)) return null;

  const when = pickupAt instanceof Date ? pickupAt : new Date(pickupAt);
  if (Number.isNaN(when.getTime())) return null;

  const rules = await loadRoutes();

  const hits = [];
  for (const rule of rules) {
    if (!withinWindow(rule, when)) continue;
    const direction = matchesCorridor(rule, pickupPoint, dropPoint);
    if (!direction) continue;
    hits.push({ rule, direction });
  }

  if (hits.length === 0) return null;

  hits.sort((a, b) => {
    const byPct = Number(b.rule.pct) - Number(a.rule.pct);
    if (byPct !== 0) return byPct;
    const spread = (r) => r.originRadiusKm + r.destRadiusKm;
    const bySpread = spread(a.rule) - spread(b.rule);
    if (bySpread !== 0) return bySpread;
    return a.rule.id - b.rule.id;
  });

  const { rule, direction } = hits[0];
  return {
    id: rule.id,
    name: rule.name,
    pct: Number(rule.pct),
    direction,
    from: direction === 'FORWARD' ? rule.originLabel : rule.destLabel,
    to: direction === 'FORWARD' ? rule.destLabel : rule.originLabel,
    startsAt: rule.startsAt,
    endsAt: rule.endsAt,
    /** How many other rules also matched — useful in the admin preview. */
    alsoMatched: hits.length - 1,
  };
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
async function resolveSurge({
  pickupPoint,
  dropPoint = null,
  pickupAt,
  requestedSurge = 1,
}) {
  const when = pickupAt instanceof Date ? pickupAt : new Date(pickupAt);
  const minutesToPickup = Math.round((when.getTime() - Date.now()) / 60000);

  const { tier, area, matched } = await classify(pickupPoint);

  const rules = await loadRules();
  const rule = rules.find((r) => r.tier === tier);

  /*
   * THE CORRIDOR PREMIUM, resolved independently of the tier.
   *
   * Two rules answer two different questions and neither subsumes the other:
   * the tier asks how hard it is to get a car to this rider, the corridor asks
   * whether this particular journey, this week, is one everybody wants.
   *
   * dropPoint is null for HOURLY and for any caller that has not got one yet,
   * and matchRoute returns null for that — a rental has no destination, so
   * there is nothing for the drop circle to contain and no special case is
   * needed.
   */
  const route = await matchRoute({ pickupPoint, dropPoint, pickupAt: when });

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
    /*
     * No tier rule — but a corridor rule can still apply on its own. These are
     * independent: a route premium must not require the pickup's tier to have
     * been configured first, or adding a Dussehra surcharge would silently do
     * nothing in every town where nobody had set up tier surge yet.
     */
    const pct = route ? route.pct : 0;
    return {
      // Never below 1: a client cannot discount a fare by asking.
      surge: Math.max(Number(requestedSurge) || 1, 1, 1 + pct / 100),
      pct,
      tier,
      area,
      route,
      matched,
      // False only when the tier has no active rule. Lets a quote distinguish
      // "surge is not configured here" from "the premium is 0% today".
      // True when EITHER rule could charge. A corridor premium with no tier
      // rule behind it is still a configured premium, and reporting this as
      // "surge is not set up here" would be wrong.
      surgeable: Boolean(route),
      // A pickup in the past is a scheduling error the validator rejects; it
      // is clamped here so it cannot read as negative urgency.
      minutesToPickup: Math.max(0, minutesToPickup),
      immediate: false,
      reason: route && pct > 0 ? buildRouteReason(route) : null,
    };
  }

  const immediate = minutesToPickup <= rule.immediateWithinMinutes;
  const tierPct = Number(immediate ? rule.immediatePct : rule.standardPct);

  /*
   * THE HIGHER OF THE TWO APPLIES. NOT THE SUM.
   *
   * Adding them compounds in a way nobody configured: a 15% short-notice
   * village pickup onto a 25% festival corridor becomes 40%, and the admin who
   * set each number never agreed to that one. Highest-wins keeps every figure
   * on the admin screen meaning exactly what it says — the most expensive
   * reason to charge is what the rider pays for, and the others are already
   * covered by it.
   *
   * It also fails safe in the direction that matters. If the two rules
   * disagree the rider is charged the larger of two numbers an admin typed in
   * deliberately, never a third number that exists only as arithmetic.
   *
   * Switching to additive, if the business ever wants that, is one line here —
   * but it needs maxSurge on the rate cards reviewed first, because the cap
   * would start doing real work rather than sitting as a backstop.
   */
  const pct = Math.max(tierPct, route ? route.pct : 0);
  const routeWins = Boolean(route) && route.pct >= tierPct && route.pct > 0;

  const base = Number(requestedSurge) > 0 ? Number(requestedSurge) : 1;
  const fromRule = 1 + pct / 100;
  const surge = Math.max(base, fromRule);

  return {
    surge,
    pct,
    tier,
    area,
    /** The corridor rule that matched, if any — null on an ordinary trip. */
    route,
    matched,
    surgeable: true,
    minutesToPickup: Math.max(0, minutesToPickup),
    immediate,
    /*
     * The reason names whichever rule actually set the price. Telling a rider
     * "demand is high in Bengaluru" when they are paying the Dussehra corridor
     * rate is true but useless; naming the festival is something support can
     * defend on the phone.
     */
    reason: pct > 0
      ? (routeWins
          ? buildRouteReason(route)
          : buildReason({ pct, immediate, tier, area, rule }))
      : null,
  };
}

/**
 * The sentence for a corridor premium.
 *
 * Uses the rule's NAME when the admin gave it one worth showing — "Dussehra"
 * explains the charge in a way "a 25% route premium" never will — and falls
 * back to the two endpoint labels otherwise.
 */
function buildRouteReason(route) {
  const where = route.from && route.to ? `${route.from} to ${route.to}` : 'this route';
  return `${route.pct}% added — ${route.name || 'higher demand'} on ${where}.`;
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
  matchRoute,
  resolveSurge,
  invalidate,
  FALLBACK_TIER,
};