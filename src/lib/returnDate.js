'use strict';

/**
 * src/lib/returnDate.js
 *
 * A ROUND TRIP HAS A RETURN DATE, NOT A RETURN TIME.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TIME WENT AWAY
 * ---------------------------------------------------------------------------
 * The rider used to pick a return date AND a clock time. Nothing in the
 * product ever used the time:
 *
 *   - the fare counts CALENDAR days (fare.service.chargeableDays), so 09:00 and
 *     21:00 on the same date produce exactly the same bill;
 *   - the night allowance looks at whether either END of the trip falls in the
 *     night window, and a return time the rider invented three weeks earlier is
 *     not evidence of anything;
 *   - dispatch does not schedule the return leg against it.
 *
 * So it was a field that looked load-bearing, took a second picker to set, and
 * silently changed the night allowance on a round trip when it crossed 21:55.
 * A rider setting a nominal "we'll head back in the evening" could pay a night
 * allowance for a trip that returned at noon.
 *
 * ---------------------------------------------------------------------------
 * WHY END OF DAY, AND NOT MIDNIGHT OR THE PICKUP'S TIME
 * ---------------------------------------------------------------------------
 * The column is a timestamp and stays one — changing it to a DATE would mean a
 * migration across bookings, booking requests, invoices and every read path
 * that formats it. So a date has to be stored AS some instant on that date,
 * and which instant matters for three reasons:
 *
 *   1. THE DATABASE CHECK CONSTRAINT. day1-constraints enforces
 *      `return_at > pickup_at` on every round trip. A same-day return — a day
 *      trip to Mysuru and back, the most common round trip there is — would
 *      violate that at midnight (00:00 is BEFORE a 09:00 pickup) and be
 *      rejected outright. The end of the day is always after a pickup on that
 *      day, so the constraint keeps doing its job without being relaxed.
 *
 *   2. THE NIGHT WINDOW. 23:59 sits inside the 21:55-06:00 band, so snapping
 *      there would make EVERY round trip attract a night allowance. The
 *      boundary is therefore 21:00 local — the last minute of the day that is
 *      unambiguously outside the night window, whatever a city sets its band
 *      to within reason. A round trip's night allowance now depends only on
 *      its PICKUP time, which is the end the rider actually chose.
 *
 *   3. CALENDAR DAYS. chargeableDays counts days in the CITY's timezone, so
 *      the instant has to land on the intended date in that zone, not in UTC.
 *      21:00 IST is 15:30 UTC — same date either way — whereas 23:59 IST is
 *      18:29 UTC on the same date but 00:29 the NEXT date in, say, Tokyo. The
 *      earlier boundary is the more robust one if a second market is ever
 *      added.
 *
 * Deliberately NOT the pickup's own time-of-day, which was the obvious first
 * answer: a 22:30 pickup would then produce a 22:30 return, inside the night
 * window, and quietly reintroduce exactly the phantom night allowance this is
 * meant to remove.
 */

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * The hour the return date is pinned to, local to the city.
 *
 * 21:00 rather than 23:59 — see reason 2 above. Expressed as a constant rather
 * than inlined because the night window it has to stay clear of is itself
 * configurable per rate card (nightStartHour, defaulting to 21:55), and the
 * two numbers need to be read together by anyone changing either.
 */
const RETURN_HOUR_LOCAL = 21;
const RETURN_MINUTE_LOCAL = 0;

/**
 * The offset, in minutes, between UTC and a timezone at a given instant.
 *
 * Intl rather than a date library, matching fare.service: built in, correct
 * about DST, no dependency. India has no DST, but a second market would.
 */
function offsetMinutes(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );

  return (asUtc - instant.getTime()) / 60000;
}

/** The calendar date an instant falls on, as seen in a timezone. */
function localDateParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Snap whatever the client sent to RETURN_HOUR_LOCAL on the same calendar date.
 *
 * Accepts an ISO timestamp (what the app sends today), a bare `YYYY-MM-DD`, a
 * Date, or null. Whatever the time component says, only the DATE survives —
 * which is the point: an older app build still sending a full timestamp cannot
 * influence the fare through its time, so the two app versions price a round
 * trip identically.
 *
 * @param {string|Date|null} returnAt
 * @param {string} timeZone  the CITY's IANA zone, from cities.timezone
 * @param {string|Date|null} pickupAt
 *   OPTIONAL, but pass it on any write path. See the clamp at the end: without
 *   it a same-day return on a late-evening pickup lands BEFORE the pickup and
 *   is rejected by the database.
 * @returns {Date|null}
 */
function normaliseReturnDate(returnAt, timeZone = DEFAULT_TIMEZONE, pickupAt = null) {
  if (!returnAt) return null;

  // A bare date has no timezone, and `new Date('2026-07-14')` parses it as
  // MIDNIGHT UTC — which is 05:30 on the 14th in IST, right date, but would be
  // the PREVIOUS date in any zone west of UTC. Anchoring it to midday first
  // puts it comfortably inside the intended date everywhere on earth before
  // the zone conversion below re-reads it.
  const raw =
    typeof returnAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(returnAt)
      ? new Date(`${returnAt}T12:00:00Z`)
      : new Date(returnAt);

  if (Number.isNaN(raw.getTime())) return null;

  let zone = timeZone || DEFAULT_TIMEZONE;
  let date;
  try {
    date = localDateParts(raw, zone);
  } catch {
    // An unknown IANA zone must not take booking down, the same decision
    // fare.service makes. Fall back and make the misconfiguration visible.
    console.warn(`[returnDate] Unknown timezone "${zone}", falling back to ${DEFAULT_TIMEZONE}`);
    zone = DEFAULT_TIMEZONE;
    date = localDateParts(raw, zone);
  }

  /*
   * Build the instant that reads as RETURN_HOUR_LOCAL on that date in `zone`.
   *
   * Done in two passes because the offset is itself a function of the instant:
   * the first pass guesses using the offset at `raw`, and the second corrects
   * it using the offset at the guess. That only differs on a day when the
   * clocks change, which India never has — but getting it right costs one
   * extra call and getting it wrong costs an hour on a date nobody will think
   * to test.
   */
  const naiveUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    RETURN_HOUR_LOCAL,
    RETURN_MINUTE_LOCAL,
    0,
    0,
  );

  const firstGuess = new Date(naiveUtc - offsetMinutes(raw, zone) * 60000);
  const corrected = new Date(naiveUtc - offsetMinutes(firstGuess, zone) * 60000);

  /*
   * THE LATE-PICKUP CLAMP.
   *
   * 21:00 is after almost every pickup on the same date, but not all of them.
   * A round trip leaving at 22:30 and returning the same date normalises to
   * 21:00 — an hour and a half BEFORE it starts — which the database rejects
   * outright: day1-constraints enforces `return_at > pickup_at`. The rider
   * would see a booking fail on a return time the form no longer even shows
   * them, with no way to correct it.
   *
   * So when the pickup is known and the snapped return does not clear it, the
   * return moves to the last minute of the same local day instead.
   *
   * That lands inside the night window, which 21:00 was chosen to avoid — but
   * harmlessly, and only here. This branch is reachable only when the PICKUP
   * is itself at 21:00 or later, which is already inside the window, and
   * fare.service charges the night allowance if EITHER end touches it. The
   * trip was paying the night allowance on its pickup before this function was
   * involved; nothing is added by the return.
   *
   * The final `max` is for the genuinely degenerate case of a pickup in the
   * last minute of the day: a minute past the pickup is still a valid return
   * instant and still the same calendar day for billing, which is all the
   * fare engine reads.
   */
  if (!pickupAt) return corrected;

  const pickup = new Date(pickupAt);
  if (Number.isNaN(pickup.getTime()) || corrected > pickup) return corrected;

  const endOfDayUtc = Date.UTC(date.year, date.month - 1, date.day, 23, 59, 0, 0);
  const endGuess = new Date(endOfDayUtc - offsetMinutes(corrected, zone) * 60000);
  const endOfDay = new Date(endOfDayUtc - offsetMinutes(endGuess, zone) * 60000);

  return endOfDay > pickup ? endOfDay : new Date(pickup.getTime() + 60000);
}

/**
 * Is the return date on or after the pickup's date, in the city's timezone?
 *
 * The comparison a round trip actually needs. Comparing the two INSTANTS — as
 * every caller used to — rejects a same-day return, because the normalised
 * return lands at 21:00 and a 22:30 pickup is later than that. A day trip
 * leaving at half ten at night and back the same date is unusual but not
 * invalid, and more to the point the error it produced ("return must be after
 * pickup") is incomprehensible on a form that no longer has a return time.
 *
 * Dates, not instants. "Back on the 14th" is either the same day as the pickup
 * or a later one, and nothing finer than that is being asked.
 */
function returnDateIsValid(returnAt, pickupAt, timeZone = DEFAULT_TIMEZONE) {
  if (!returnAt || !pickupAt) return false;

  const zone = timeZone || DEFAULT_TIMEZONE;
  const key = (d) => {
    const p = localDateParts(d, zone);
    return p.year * 10000 + p.month * 100 + p.day;
  };

  const ret = normaliseReturnDate(returnAt, zone);
  const pick = new Date(pickupAt);
  if (!ret || Number.isNaN(pick.getTime())) return false;

  return key(ret) >= key(pick);
}

module.exports = {
  normaliseReturnDate,
  returnDateIsValid,
  RETURN_HOUR_LOCAL,
  RETURN_MINUTE_LOCAL,
  DEFAULT_TIMEZONE,
};