'use strict';

/**
 * src/lib/locality.js
 *
 * Decides whether two addresses name the SAME TOWN.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * quote.service used to answer "is this trip local?" with one test: are both
 * endpoints inside `localRadiusKm` of a row in the `cities` table. That works
 * for Bengaluru, which has a row, a centre and a radius. It silently fails
 * everywhere else.
 *
 * A Hyderabad pickup with a Hyderabad drop resolves — via
 * resolveOperatingCity's nearest-city fallback — to the Bengaluru row, because
 * that is the only row there is. Both points are ~500 km from that centre, so
 * the same-city test says no, no switch fires, and a 12 km city hop is priced
 * as an outstation ONE_WAY: return-empty percentage, minimum km per day and
 * driver bata, none of which apply to a trip that never leaves town.
 *
 * The cities table is a RATE CARD index. It answers "whose prices apply here",
 * and it is deliberately sparse — adding a row means committing to pricing.
 * "Are these two pins in one town" is a different question and must not depend
 * on whether the business has got round to pricing that town yet.
 *
 * So the geocoder answers it. Both Google and Ola return a locality on every
 * geocode we already pay for, and serviceArea.cityFromComponents already parses
 * it out. Comparing two locality strings costs nothing and works in a town the
 * fleet has never priced.
 *
 * ---------------------------------------------------------------------------
 * WHY A STRAIGHT STRING COMPARE IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * Indian cities were renamed and both names stayed in use. A maps provider
 * returns whichever its data happens to carry, and the two ends of one trip can
 * easily come back differently spelled:
 *
 *   Bengaluru / Bangalore      Mysuru / Mysore        Hubballi / Hubli
 *   Mangaluru / Mangalore      Belagavi / Belgaum     Kalaburagi / Gulbarga
 *   Vijayapura / Bijapur       Shivamogga / Shimoga   Ballari / Bellary
 *
 * A rider booking Bengaluru -> Bangalore is booking one trip across one city.
 * Without the alias table below they look like two towns, the switch does not
 * fire, and we are back to the bug this file exists to fix — just less often
 * and far harder to reproduce.
 *
 * The aliases are a FACT ABOUT PLACE NAMES, not about the business, which is
 * why they are code and not a table. They do not change when a permit clears
 * or a city opens; they changed once, by legislation, years ago.
 */

/** Lower-case, strip everything that is not a letter or a digit. */
function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Groups of names for one place. Every member maps to the group's first entry,
 * so "bangalore" and "bengaluru" both canonicalise to the same token.
 *
 * ONLY TRUE SYNONYMS BELONG HERE. A suburb is not an alias of its city:
 * putting "whitefield" next to "bengaluru" would make Whitefield -> Mysuru read
 * as a local trip. Suburbs are handled by the radius test in quote.service,
 * which has a distance to bound it; this table has none.
 */
const ALIAS_GROUPS = [
  ['bengaluru', 'bangalore', 'bengalooru', 'bangaluru'],
  ['mysuru', 'mysore'],
  ['hubballi', 'hubli'],
  ['dharwad', 'dharwar'],
  ['mangaluru', 'mangalore'],
  ['belagavi', 'belgaum'],
  ['kalaburagi', 'gulbarga'],
  ['vijayapura', 'bijapur'],
  ['shivamogga', 'shimoga'],
  ['ballari', 'bellary'],
  ['tumakuru', 'tumkur'],
  ['chikkamagaluru', 'chikmagalur'],
  ['chamarajanagara', 'chamarajanagar'],
  ['hosapete', 'hospet'],
  /*
   * Secunderabad is grouped WITH Hyderabad, unlike the pairs above it.
   *
   * It is not a renaming — they are two cities — but they are one continuous
   * urban area under one municipal corporation, and a Secunderabad pickup
   * with a Hyderabad drop is a local trip by any reading a rider would
   * recognise. Nothing else would catch it: Hyderabad has no row in `cities`,
   * so the radius test has no centre to measure from and the name test is the
   * only signal there is.
   */
  ['hyderabad', 'haidarabad', 'secunderabad'],
  ['vijayawada', 'bezawada'],
  ['visakhapatnam', 'vizag', 'vishakhapatnam'],
  ['mumbai', 'bombay'],
  ['pune', 'poona'],
  ['chennai', 'madras'],
  ['kochi', 'cochin'],
  ['thiruvananthapuram', 'trivandrum'],
  ['puducherry', 'pondicherry'],
  ['kolkata', 'calcutta'],
  ['prayagraj', 'allahabad'],
  ['varanasi', 'banaras', 'benares'],
  ['vadodara', 'baroda'],
];

const ALIAS_INDEX = (() => {
  const index = new Map();
  for (const group of ALIAS_GROUPS) {
    const canonical = group[0];
    for (const name of group) index.set(normalise(name), canonical);
  }
  return index;
})();

/**
 * Reduce a free-text place name to a comparable token, or null.
 *
 * Trailing administrative noise is stripped first. Google's
 * administrative_area_level_2 comes back as "Bengaluru Urban" and
 * "Bengaluru Rural" — two districts of one metro, and a rider crossing between
 * them has not left the city. Likewise "Hyderabad District".
 */
function canonical(name) {
  let n = normalise(name);
  if (!n) return null;

  for (const suffix of ['urban', 'rural', 'district', 'taluk', 'taluka', 'tehsil', 'city']) {
    if (n.length > suffix.length + 2 && n.endsWith(suffix)) {
      n = n.slice(0, -suffix.length);
      break;
    }
  }

  return ALIAS_INDEX.get(n) || n || null;
}

/**
 * Do these two names refer to the same town?
 *
 * Returns null — NOT false — when either name is missing. The caller has to be
 * able to tell "the geocoder says these are different towns" apart from "the
 * geocoder did not say", because only the first is evidence. Treating an
 * unknown as a mismatch is how a provider outage would quietly turn every
 * local trip back into an outstation one.
 *
 * @returns {boolean|null}
 */
function sameCity(a, b) {
  const left = canonical(a);
  const right = canonical(b);
  if (!left || !right) return null;
  return left === right;
}

/** Pretty name for a message, preferring the first non-empty input. */
function displayName(...names) {
  for (const name of names) {
    const trimmed = String(name || '').trim();
    if (trimmed) return trimmed;
  }
  return null;
}

module.exports = { normalise, canonical, sameCity, displayName, ALIAS_GROUPS };