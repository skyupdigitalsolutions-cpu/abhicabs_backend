'use strict';

/**
 * src/lib/india.js
 *
 * The one place that decides whether a point is inside India.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED A KILOMETRE CAP
 * ---------------------------------------------------------------------------
 * quote.service used to refuse anything over MAX_TRIP_KM (1500 km straight
 * line). That number was never the real constraint — it was a guess standing in
 * for one, and it got both answers wrong at once:
 *
 *   Bengaluru to Delhi is ~1740 km straight line. A real trip, a car the fleet
 *   owns, a drive the drivers do — refused, with a message about a limit the
 *   customer has no way to understand or act on.
 *
 *   Bengaluru to Colombo is ~430 km straight line, well under the cap, and
 *   accepted. There is no road. The quote priced a route across the Gulf of
 *   Mannar.
 *
 * Distance is not what makes a trip impossible; leaving the country is. So the
 * cap is gone and the rule is now the honest one: pickup, drop and every stop
 * must be in India. Within that, a trip may be as long as the customer wants,
 * and the fare engine prices it per kilometre as it always did.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DECIDES, AND WHY IN THAT ORDER
 * ---------------------------------------------------------------------------
 * Three tests, cheapest-and-most-certain first. None of them calls a provider,
 * because this runs on every quote and a billed lookup per endpoint would be a
 * real cost increase for a check that is almost always trivially true.
 *
 *   1. An explicit country, when the caller has one. Only the geocoded path
 *      does — a point that arrived from the app as raw coordinates has none.
 *
 *   2. The last comma-segment of the formatted address. Google puts the
 *      country last: "…, Bengaluru, Karnataka 560034, India". This is exact
 *      when it is present, and it is present for anything the rider picked out
 *      of search or the map.
 *
 *      Matching is confined to that LAST segment on purpose. Searching the
 *      whole string for country names would refuse "China Town, Kolkata" and
 *      "Nepal Chowk, Gorakhpur", both of which are in India.
 *
 *   3. A bounding box, as the fallback for a point with no usable address —
 *      the airport picker's composed label, a dropped pin, an older cached
 *      geocode.
 *
 * ---------------------------------------------------------------------------
 * THE BOX IS DELIBERATELY GENEROUS
 * ---------------------------------------------------------------------------
 * A rectangle around India also contains parts of Pakistan, Nepal, Bhutan,
 * Bangladesh, Myanmar, Sri Lanka and Tibet. Tightening it into a real polygon
 * would need a boundary traced accurately enough that no coastal town in Kerala
 * or Odisha falls outside it, and getting that subtly wrong means refusing real
 * customers in places nobody tests.
 *
 * The asymmetry decides it. A false reject is a booking lost in a town where
 * the fleet operates, discovered only when someone complains. A false accept is
 * a drop pin in Kathmandu that step 2 already caught by name, and that the
 * pickup's own state check means a dispatcher is looking at anyway.
 *
 * So the box errs toward letting things through, and the named-country test
 * does the precise work. If this ever needs to be exact, replace `inBox` with a
 * point-in-polygon against a real boundary file — the rest of the module and
 * every caller stay as they are.
 */

/**
 * Bounds of the Republic of India, including the island territories.
 *
 * Padded slightly beyond the published extremes so a point on a beach or a
 * border road is never refused for being a few hundred metres out:
 *   north  ~37.1  (Jammu & Kashmir)      south  ~6.75 (Indira Point, Nicobar)
 *   west   ~68.1  (Gujarat / Lakshadweep) east  ~97.4 (Arunachal Pradesh)
 */
const INDIA_BOX = Object.freeze({
  minLat: 6.0,
  maxLat: 37.6,
  minLng: 68.0,
  maxLng: 97.5,
});

/**
 * Countries that share the bounding box, so a pin inside it may still be
 * abroad. Written as the names Google returns, normalised the same way they
 * are compared.
 *
 * Not an exhaustive list of foreign countries — it does not need to be. A
 * country OUTSIDE the box is refused by the box itself, so this only has to
 * cover the neighbours the box cannot separate.
 */
const NEIGHBOURS = Object.freeze([
  'pakistan',
  'nepal',
  'bhutan',
  'bangladesh',
  'myanmar',
  'burma',
  'srilanka',
  'china',
  'tibet',
  'afghanistan',
  'maldives',
]);

/** Lower-case, strip everything that is not a letter or digit. */
function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The country segment of a formatted address, or null.
 *
 * Google's format puts it last and nothing else goes there. Digits are
 * stripped by `normalise`, so a segment like "Karnataka 560034" cannot be
 * mistaken for a country name.
 */
function countryFromAddress(address) {
  const parts = String(address || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** Inside the rectangle? Pure geometry, no judgement. */
function inBox(point) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return (
    lat >= INDIA_BOX.minLat &&
    lat <= INDIA_BOX.maxLat &&
    lng >= INDIA_BOX.minLng &&
    lng <= INDIA_BOX.maxLng
  );
}

/**
 * Is this place in India?
 *
 * @param {{ lat?:number, lng?:number, country?:string|null,
 *           formattedAddress?:string|null }} place
 * @returns {{ ok: boolean, country: string|null, basis: string }}
 *
 * `country` is what was actually identified, or null when nothing named one —
 * the caller puts it in the error so a rider is told "your drop is in Sri
 * Lanka" rather than something they cannot act on. `basis` says which of the
 * three tests answered, which is the difference between a confident refusal
 * and a guess when this shows up in a log.
 */
function checkInIndia(place = {}) {
  // 1. An explicit country from the geocoder.
  const declared = normalise(place.country);
  if (declared) {
    if (declared === 'india') return { ok: true, country: 'India', basis: 'country' };
    return { ok: false, country: place.country, basis: 'country' };
  }

  // 2. The last segment of the formatted address.
  const tail = countryFromAddress(place.formattedAddress);
  const n = normalise(tail);
  if (n === 'india') return { ok: true, country: 'India', basis: 'address' };
  if (n && NEIGHBOURS.includes(n)) return { ok: false, country: tail, basis: 'address' };

  // 3. Geometry, for anything that named no country at all.
  if (inBox(place)) return { ok: true, country: null, basis: 'bounds' };
  return { ok: false, country: tail || null, basis: 'bounds' };
}

module.exports = {
  INDIA_BOX,
  NEIGHBOURS,
  normalise,
  countryFromAddress,
  inBox,
  checkInIndia,
};