'use strict';

/**
 * src/services/fare.service.js
 *
 * THE FARE ENGINE. A pure function: same inputs, same output, always.
 *
 * No HTTP. No database. No cache. No clock — `pickupAt` is passed in rather
 * than read from Date.now(), so a night-charge test does not have to run at
 * 11pm to be meaningful.
 *
 * ---------------------------------------------------------------------------
 * WHY PURITY MATTERS HERE SPECIFICALLY
 * ---------------------------------------------------------------------------
 * This is the code that decides what a customer pays and what a driver earns.
 * If it reached into the database for its rate card, you could not test a
 * scenario without seeding one, could not reproduce a six-month-old fare
 * dispute, and could not be sure a config change had not silently altered an
 * old calculation. Passing the config in makes every fare reproducible from its
 * inputs alone — which is exactly what `booking.fareBasis` stores.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF OPERATIONS  (the order is itself a business decision)
 * ---------------------------------------------------------------------------
 *   1. billable distance   max(actual, minimumKm, minKmPerDay x days)
 *   2. distance charge     billableKm x perKm
 *   3. time charge         durationMin x perMinute        (one-way only)
 *   4. return-empty        RETIRED — always zero
 *   5. driver allowance    bata x days                    (NOT airport)
 *   6. waiting charge      not charged — always zero
 *   7. night allowance     flat + % of distance           (NOT airport)
 *   7b. airport surcharge  flat                           (airport only)
 *   8. surge               clamped to the card's band     (METRO pickups only)
 *   9. minimum fare floor  RETIRED — the floor is a distance, applied at step 1
 *
 * DEMAND PRICING IS LIVE, AND ONLY INSIDE METRO AREAS. clampSurge enforces the
 * rate card's band; surge.service decides whether a premium applies at all, and
 * charges one only when the PICKUP classifies as METRO, at a percentage an
 * admin has written into surge_rules. Nothing a client sends can raise a fare.
 *
 * THERE IS NO BASE FARE. The flat per-trip amount was removed; a fare is the
 * distance driven plus only the allowances that represent a real cost. See the
 * note at step 2 for why the column and the `base` key survive as zeroes.
 *
 * THERE IS NO RETURN-LEG CHARGE ON A ONE-WAY. A one-way is billed for the
 * kilometres it covers, once, at the ONE_WAY per-km rate — which is set higher
 * than the ROUND_TRIP rate precisely because the driver returns empty. Return
 * distance is billed in exactly one place: a round trip, where the car really
 * does drive it twice. See step 4.
 *
 * THE MINIMUM IS A DISTANCE, NOT A SUM OF MONEY. `minimumKm` floors the
 * billable kilometres at step 1, so a short trip is priced as that distance at
 * the current rate rather than topped up to a rupee figure that stops meaning
 * anything the next time the rate card moves.
 *
 * The night percentage deliberately excludes bata and waiting: those are fixed
 * allowances, not distance-driven, and uplifting them would overcharge.
 *
 * AIRPORT is exempt from steps 5 and 7 — it pays the airport surcharge at 7b
 * instead. See ALLOWANCE_EXEMPT_TRIP_TYPES for why that is enforced here
 * rather than by zeroing the rate card.
 */

const M = require('../lib/money');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Trip types that never attract the night allowance or the driver allowance.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ENFORCED IN CODE, NOT JUST IN THE RATE CARD
 * ---------------------------------------------------------------------------
 * Airport transfers are priced as a flat-ish transfer plus an airport
 * surcharge; loading bata and a night uplift on top would double-charge for
 * the same short journey, and airport fares are the ones customers compare
 * most closely against competitors.
 *
 * Zeroing driver_allowance and night_charge_pct on the AIRPORT rate rows would
 * be enough TODAY. It is not enough tomorrow: rate cards are edited by ops
 * through SQL, a new city gets seeded by copying an existing row, and the
 * moment somebody copies a ONE_WAY row into an AIRPORT slot the exemption is
 * silently gone and every airport fare is wrong until a customer complains.
 *
 * Keeping the rule here makes it a property of the product rather than of the
 * data. The migration still zeroes the airport rows so the rate card reads
 * honestly, but the engine does not depend on that having been done.
 */
const ALLOWANCE_EXEMPT_TRIP_TYPES = new Set(['AIRPORT']);

/** Is this trip type exempt from the night and driver allowances? */
function isAllowanceExempt(tripType) {
  return ALLOWANCE_EXEMPT_TRIP_TYPES.has(tripType);
}

/* ------------------------------------------------------------------ *
 * Time helpers — all timezone-aware
 * ------------------------------------------------------------------ */

/**
 * Extracts the wall-clock parts of an instant AS SEEN IN A GIVEN TIMEZONE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `new Date(x).getHours()` returns the hour in the SERVER's timezone. That
 * makes the fare depend on where the server happens to run: a booking returning
 * at 18:00 UTC is 23:30 IST — inside the night window — so a laptop in
 * Bengaluru charges the night uplift while a production box in UTC does not.
 * The same booking, two different prices.
 *
 * Fares must be a property of the trip, not of the deployment. Everything here
 * therefore resolves against the CITY's timezone, which Day 1 stored on
 * `cities.timezone`.
 *
 * Intl is used rather than a date library because it is built in, correct about
 * DST, and adds no dependency. India has no DST, but other markets would.
 */
function zonedParts(instant, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new Error('[fare] Invalid date supplied to zonedParts');
  }

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
  } catch (err) {
    // An unknown IANA zone must not take pricing down. Fall back to the default
    // and make the misconfiguration visible.
    console.warn(`[fare] Unknown timezone "${timeZone}", falling back to ${DEFAULT_TIMEZONE}`);
    return zonedParts(instant, DEFAULT_TIMEZONE);
  }

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  // 'en-GB' renders midnight as 24 in some runtimes; normalise it to 0.
  const hour = get('hour') % 24;

  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

/** Days since epoch in the given zone — for comparing calendar dates. */
function zonedDayNumber(instant, timeZone) {
  const { year, month, day } = zonedParts(instant, timeZone);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/**
 * Chargeable days for a round trip — CALENDAR days in the city's timezone.
 *
 * ---------------------------------------------------------------------------
 * WHY CALENDAR DAYS, NOT 24-HOUR BLOCKS
 * ---------------------------------------------------------------------------
 * This follows Indian outstation convention, and it matters financially.
 *
 * A trip leaving 22:00 Monday and returning 08:00 Tuesday is ten hours. Counted
 * in 24-hour blocks that is ONE day. But the driver was away overnight and is
 * paid TWO days of allowance — so the operator pays Rs 800 in bata and collects
 * Rs 400. The old behaviour lost money on every overnight trip.
 *
 * Counting calendar days means both ends of that trip are billed, matching what
 * the driver is actually owed.
 */
function chargeableDays(pickupAt, returnAt, timeZone = DEFAULT_TIMEZONE) {
  if (!returnAt) return 1;

  const start = new Date(pickupAt).getTime();
  const end = new Date(returnAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;

  const days = zonedDayNumber(returnAt, timeZone) - zonedDayNumber(pickupAt, timeZone) + 1;
  return Math.max(1, days);
}

/* ------------------------------------------------------------------ *
 * The night window
 * ------------------------------------------------------------------ */

/**
 * Minutes elapsed since local midnight. The whole night window is compared in
 * this single unit so a boundary like 21:55 is one number (1315) rather than an
 * hour and a minute that have to be compared in the right order.
 */
function minutesOfDay(hour, minute = 0) {
  return Number(hour) * 60 + Number(minute);
}

/**
 * Reads the night window off a fare config, in minutes-of-day.
 *
 * ---------------------------------------------------------------------------
 * WHY MINUTES AND NOT HOURS
 * ---------------------------------------------------------------------------
 * ABHICABS' night band starts at 21:55, not on the hour. With hour-only
 * columns the window could only be 21:00 (charging night on 55 minutes of
 * ordinary evening trips) or 22:00 (missing the 21:55-22:00 band). Neither
 * matches the policy, and the error is silent — the fare is simply wrong, with
 * nothing in the breakdown to show it.
 *
 * Defaults are 21:55 -> 06:00 so a config row that predates the minute columns
 * still lands on the intended policy rather than on midnight.
 */
function nightWindowFromConfig(config = {}) {
  return {
    startMin: minutesOfDay(config.nightStartHour ?? 21, config.nightStartMinute ?? 55),
    endMin: minutesOfDay(config.nightEndHour ?? 6, config.nightEndMinute ?? 0),
  };
}

/** "21:55–06:00" — for the breakdown note and the invoice line. */
function formatNightWindow({ startMin, endMin }) {
  const hhmm = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${hhmm(startMin)}\u2013${hhmm(endMin)}`;
}

/**
 * Does a local time-of-day fall inside the night window?
 *
 * Handles the wrap across midnight: a window of 21:55-06:00 has start > end, so
 * "inside" means at-or-after 21:55 OR before 06:00. Treating it as a simple
 * range would make the window match nothing at all.
 *
 * The start boundary is INCLUSIVE and the end boundary EXCLUSIVE: a 21:55
 * pickup is night, a 06:00 pickup is not. That gives the window no gap and no
 * overlap with the day rate, so no instant is ever billed twice or missed.
 */
function isNightMinute(mins, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return mins >= startMin && mins < endMin;
  return mins >= startMin || mins < endMin;
}

/**
 * Back-compat wrapper for the old hour-granularity signature. Kept because it
 * is part of the module's public surface; new code should use isNightMinute.
 */
function isNightHour(hour, startHour, endHour) {
  return isNightMinute(minutesOfDay(hour), minutesOfDay(startHour), minutesOfDay(endHour));
}

/**
 * A trip attracts the night allowance if EITHER end falls in the window,
 * evaluated in the CITY's timezone rather than the server's.
 *
 * @param {{startMin:number,endMin:number}} window  from nightWindowFromConfig
 */
function touchesNight(pickupAt, returnAt, window, timeZone = DEFAULT_TIMEZONE) {
  const at = (instant) => {
    const { hour, minute } = zonedParts(instant, timeZone);
    return minutesOfDay(hour, minute);
  };

  const stamps = [at(pickupAt)];
  if (returnAt) stamps.push(at(returnAt));
  return stamps.some((m) => isNightMinute(m, window.startMin, window.endMin));
}

/* ------------------------------------------------------------------ *
 * Surge
 * ------------------------------------------------------------------ */

/**
 * Clamps the requested multiplier to the configured band.
 *
 * MVAG caps dynamic pricing between 0.5x and 2x the notified base fare, and
 * fare_configs carries those bounds per city and vehicle class. Clamping here
 * means an out-of-range surge from a caller cannot produce an illegal fare —
 * it is silently corrected rather than trusted.
 */
/**
 * DEMAND PRICING IS LIVE AGAIN — FOR METRO PICKUPS ONLY.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHAT DID NOT
 * ---------------------------------------------------------------------------
 * This function used to `return M.dec(1)` unconditionally, which neutralised
 * the whole surge pipeline at the one point where a multiplier becomes money.
 * That hard zero is gone: the band is enforced again, exactly as written below.
 *
 * What did NOT change is who decides the premium. A multiplier reaching here
 * can only have come from surge.service, which:
 *   • charges a premium ONLY when the pickup classifies as METRO, and
 *   • reads the percentage from a surge_rules row an admin wrote.
 * Nothing a client sends can raise a fare — `requestedSurge` is treated as a
 * floor of 1 upstream and is clamped to the rate card's band here.
 *
 * So there are two independent limits, deliberately. The tier rules decide
 * whether a premium applies at all and how big it is; this clamp decides the
 * most any single rate card will tolerate. A card left at maxSurge = 1.00 is
 * exempt no matter what the rules say, which is how one class or trip type is
 * taken out of surge without editing the tiers.
 *
 * The MVAG bounds the defaults express (0.5x–2x of the notified fare) are the
 * reason the ceiling lives on the rate card rather than on the rule: the legal
 * cap is a property of the published fare, not of how urgent a booking is.
 */
function clampSurge(requested, config) {
  const value = M.dec(requested ?? 1);
  const lo = M.dec(config.minSurge ?? 1);
  const hi = M.dec(config.maxSurge ?? 2);
  if (value.lessThan(lo)) return lo;
  if (value.greaterThan(hi)) return hi;
  return value;
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

/**
 * Hourly local-rental pricing. Two modes:
 *
 *   • Fixed package (rentalPackage supplied): a flat packageFare covers the
 *     included hours + km. Overage beyond either is charged at the package's
 *     extraPerHour / extraPerKm. (Overage is only known at trip end; at quote
 *     time it's zero, so the quote equals the package fare.)
 *
 *   • Flexible "any hours" (no package): hours x hourlyRate, plus any distance
 *     beyond the included allowance (hours x hourlyKmPerHour) at perKm.
 *
 * Night charge still applies (on the time/package component). Surge and the
 * minimum-fare floor apply exactly as for other trip types.
 */
function computeHourlyFare(input, config) {
  const {
    rentalHours = 0,
    rentalPackage = null,
    distanceKm = 0,
    pickupAt = new Date(),
    returnAt = null,
    surge: requestedSurge = 1,
    timeZone = DEFAULT_TIMEZONE,
  } = input;

  if (!config) throw new Error('[fare] No fare configuration supplied');
  const breakdown = [];

  let core = M.dec(0);          // package fare or hours*rate
  let extraKmCharge = M.dec(0);
  let extraHourCharge = M.dec(0);
  let includedKm = 0;
  let includedHours = 0;

  if (rentalPackage) {
    includedHours = Number(rentalPackage.includedHours);
    includedKm = Number(rentalPackage.includedKm);
    core = M.round2(M.dec(rentalPackage.packageFare));
    breakdown.push({
      label: `Rental package (${rentalPackage.label})`,
      amount: M.toStr(core),
      note: `${includedHours} hrs / ${includedKm} km included`,
    });

    const extraKm = Math.max(0, Number(distanceKm) - includedKm);
    if (extraKm > 0 && M.dec(rentalPackage.extraPerKm).greaterThan(0)) {
      extraKmCharge = M.round2(M.mul(extraKm, rentalPackage.extraPerKm));
      breakdown.push({
        label: `Extra distance (${extraKm} km x ${M.toStr(rentalPackage.extraPerKm)}/km)`,
        amount: M.toStr(extraKmCharge),
      });
    }
  } else {
    // Flexible: hours x hourly rate.
    includedHours = Number(rentalHours);
    const rate = M.dec(config.hourlyRate ?? 0);
    if (!rate.greaterThan(0)) {
      throw new Error('[fare] hourly rate not configured for this class');
    }
    core = M.round2(M.mul(rentalHours, rate));
    breakdown.push({
      label: `Hourly rental (${rentalHours} hr x ${M.toStr(rate)}/hr)`,
      amount: M.toStr(core),
    });

    includedKm = Number(rentalHours) * Number(config.hourlyKmPerHour ?? 10);
    const extraKm = Math.max(0, Number(distanceKm) - includedKm);
    if (extraKm > 0 && M.dec(config.perKm).greaterThan(0)) {
      extraKmCharge = M.round2(M.mul(extraKm, config.perKm));
      breakdown.push({
        label: `Extra distance (${extraKm} km beyond ${includedKm} km x ${M.toStr(config.perKm)}/km)`,
        amount: M.toStr(extraKmCharge),
      });
    }
  }

  /* driver allowance (bata) — hourly rentals are never airport transfers, so
   * the exemption cannot apply here; the check is kept anyway so the rule lives
   * in exactly one place and a future exempt trip type is honoured everywhere.
   *
   * A rental is quoted for a block of hours on one day, so this is one day of
   * bata. Overnight rentals are booked as ROUND_TRIP, which counts calendar
   * days properly.
   */
  const exemptFromAllowances = isAllowanceExempt('HOURLY');

  let bata = M.dec(0);
  if (!exemptFromAllowances && M.dec(config.driverAllowance ?? 0).greaterThan(0)) {
    bata = M.round2(M.dec(config.driverAllowance));
    breakdown.push({
      label: `Driver allowance (${M.toStr(config.driverAllowance)})`,
      amount: M.toStr(bata),
      note: 'Bata paid to the driver',
    });
  }

  /* night allowance on the core rental component */
  const nightWindow = nightWindowFromConfig(config);
  const touchesNightWindow = touchesNight(pickupAt, returnAt, nightWindow, timeZone);

  let nightCharge = M.dec(0);
  const nightPct = M.dec(config.nightChargePct ?? 0);
  const nightFlat = M.dec(config.nightAllowance ?? 0);
  const nightIsChargeable =
    touchesNightWindow && !exemptFromAllowances && (nightPct.greaterThan(0) || nightFlat.greaterThan(0));

  if (nightIsChargeable) {
    const pctPart = nightPct.greaterThan(0) ? M.round2(M.pct(core, nightPct)) : M.dec(0);
    nightCharge = M.round2(M.add(nightFlat, pctPart));

    const detail = [];
    if (nightFlat.greaterThan(0)) detail.push(`flat ${M.toStr(nightFlat)}`);
    if (nightPct.greaterThan(0)) detail.push(`${M.toStr(nightPct)}% of rental`);

    breakdown.push({
      label: 'Night allowance',
      amount: M.toStr(nightCharge),
      note: `Trip falls within ${formatNightWindow(nightWindow)} (${detail.join(' + ')})`,
    });
  }

  const subtotal = M.sum([core, extraKmCharge, extraHourCharge, bata, nightCharge]);

  const surge = clampSurge(requestedSurge, config);
  const surgeAmount = surge.equals(1) ? M.dec(0) : M.round2(M.sub(M.mul(subtotal, surge), subtotal));
  if (!surgeAmount.isZero()) {
    breakdown.push({ label: `Demand pricing (${surge.toFixed(2)}x)`, amount: M.toStr(surgeAmount) });
  }
  const afterSurge = M.add(subtotal, surgeAmount);

  /*
   * No rupee floor here either — see the long note in computeFare.
   *
   * A rental needs one least of all: its price IS a package or a block of
   * hours the rider chose, so there is no short trip to protect against. The
   * minimumKm floor does not apply for the same reason — a package already
   * states its own included kilometres, and layering a second distance floor
   * on top would bill for km the package covers.
   *
   * Kept as an explicit zero so the return shape matches computeFare's and the
   * fareBasis of every rental already booked.
   */
  const minimumFareAdjustment = M.dec(0);
  const beforeRounding = afterSurge;

  const total = M.roundRupee(beforeRounding);
  const roundingAdjustment = M.sub(total, beforeRounding);
  if (!roundingAdjustment.isZero()) {
    breakdown.push({ label: 'Rounding', amount: M.toStr(roundingAdjustment), note: 'Rounded to the nearest rupee' });
  }

  return {
    tripType: 'HOURLY',
    currency: 'INR',
    base: M.toStr(core),
    distance: M.toStr(extraKmCharge),
    time: '0.00',
    returnEmpty: '0.00',
    bata: M.toStr(bata),
    waiting: '0.00',
    night: M.toStr(nightCharge),
    airport: '0.00',
    surgeAmount: M.toStr(surgeAmount),
    subtotal: M.toStr(subtotal),
    minimumFareAdjustment: M.toStr(minimumFareAdjustment),
    total: total.toFixed(2),
    meta: {
      rental: true,
      // Hours the rider actually bought. computeExtraTimeCharge measures an
      // overrun against THIS, so re-reporting a trip never compounds the charge.
      includedHours,
      includedKm,
      packageLabel: rentalPackage ? rentalPackage.label : null,
      days: 1,
      isNight: nightIsChargeable,
      touchesNightWindow,
      nightWindow: formatNightWindow(nightWindow),
      allowancesExempt: exemptFromAllowances,
    },

    /**
     * The rates an overrun is settled at, frozen with the quote.
     *
     * A rental had no snapshot at all before this, so a trip that ran long had
     * nothing to price the extra hours against and silently settled at zero.
     * Only the overage rates are frozen here — the rest of the rate card never
     * applies to a package, which is priced as a flat bundle.
     */
    configSnapshot: {
      fareConfigId: config.id ?? null,
      cityId: config.cityId ?? null,
      vehicleClass: config.vehicleClass ?? null,
      hourlyRate: M.toStr(config.hourlyRate ?? 0),
      hourlyKmPerHour: Number(config.hourlyKmPerHour ?? 0),
      perKm: M.toStr(config.perKm ?? 0),
      // A package's own overage rates beat the generic ones, so both travel.
      rentalExtraPerHour: M.toStr(rentalPackage ? rentalPackage.extraPerHour ?? 0 : 0),
      rentalExtraPerKm: M.toStr(rentalPackage ? rentalPackage.extraPerKm ?? 0 : 0),
      rentalPackageId: rentalPackage ? rentalPackage.id : null,
      computedAt: new Date().toISOString(),
    },
    breakdown,
  };
}

/**
 *   distanceKm     road distance. For a round trip this is the TOTAL both ways.
 *   durationMin    driving minutes
 *   pickupAt       ISO string or Date
 *   returnAt       ISO string or Date  (round trip)
 *   waitingMinutes total waiting during the journey (any trip type)
 *   surge          requested multiplier, clamped to the config band
 *   rentalHours    HOURLY: hours the rider is committing to
 *   rentalPackage  HOURLY: a rental_packages row, or null for the flexible rate
 *
 * @param {object} config  a fare_configs row
 *
 * @returns {object} components as strings, plus a human-readable breakdown
 */
function computeFare(input, config) {
  // Hourly rentals price by time/package, not by trip distance — a separate
  // model entirely, so it gets its own function rather than tangling branches
  // through the distance logic below.
  if (input.tripType === 'HOURLY') {
    return computeHourlyFare(input, config);
  }

  const {
    tripType,
    distanceKm = 0,
    durationMin = 0,
    pickupAt = new Date(),
    returnAt = null,
    waitingMinutes = 0,
    surge: requestedSurge = 1,
    // The CITY's IANA timezone, from cities.timezone. Passed by quote.service.
    // Falls back to Asia/Kolkata rather than the server zone, so the fare never
    // depends on where the process happens to be running.
    timeZone = DEFAULT_TIMEZONE,
  } = input;

  if (!config) throw new Error('[fare] No fare configuration supplied');

  const isRoundTrip = tripType === 'ROUND_TRIP';
  const isAirport = tripType === 'AIRPORT';
  // Airport transfers pay the airport surcharge instead of bata + night uplift.
  const exemptFromAllowances = isAllowanceExempt(tripType);
  const breakdown = [];

  /* -- 1. billable distance ----------------------------------------
   *
   * NOTE ON ROUNDING: every component below is rounded to 2dp AT THE POINT OF
   * COMPUTATION, not just when serialised. Summing unrounded values and then
   * displaying rounded ones makes the breakdown lines disagree with the total
   * by a paisa — which reads as a billing error to anyone who adds them up.
   * What is shown must be what was summed.
   */

  const actualKm = M.dec(distanceKm);
  const days = isRoundTrip ? chargeableDays(pickupAt, returnAt, timeZone) : 1;

  /*
   * TWO DISTANCE FLOORS, AND THE LARGER WINS.
   *
   *   minimumKm    a flat floor on ANY trip on this card. "Minimum 50 km",
   *                the way the trade actually quotes a short hop. This
   *                replaced the old rupee minimum-fare floor — see below.
   *
   *   minKmPerDay  a ROUND_TRIP-only guarantee, multiplied by the number of
   *                calendar days. A customer who keeps the vehicle for two
   *                days and drives 40 km still occupies it for two days, and
   *                the guarantee is what makes that economic for the operator.
   *
   * Taking the maximum rather than adding them matters: both describe the same
   * quantity (the least distance this trip may be billed for), so summing them
   * would double-count a short two-day round trip.
   */
  const flatMinimumKm = M.dec(config.minimumKm ?? 0);
  const perDayMinimumKm = isRoundTrip ? M.mul(config.minKmPerDay ?? 0, days) : M.dec(0);
  const guaranteedKm = M.max(flatMinimumKm, perDayMinimumKm);

  const billableKm = M.max(actualKm, guaranteedKm);

  const usedGuarantee = billableKm.greaterThan(actualKm);
  // Which of the two floors is doing the work, so the breakdown note can name
  // the right one rather than guessing. Ties go to the per-day guarantee,
  // which is the more specific statement about a round trip.
  const usedPerDayGuarantee =
    usedGuarantee && perDayMinimumKm.greaterThanOrEqualTo(flatMinimumKm) && perDayMinimumKm.greaterThan(0);

  /* -- 2. base + distance ------------------------------------------ */

  /*
   * BASE FARE IS RETIRED.
   *
   * It was a flat per-trip amount (Rs 400-1200 by class) charged before a
   * single kilometre was driven, and it is no longer part of the product. The
   * fare is now distance x per-km, plus only the allowances that represent a
   * real cost: driver bata, the night allowance, and demand pricing.
   *
   * Held as a hard zero rather than deleted outright. `base` is a key in the
   * fareBasis frozen onto every booking ever taken, and in the invoice and
   * admin surfaces that read it. Removing the key would read as `undefined`
   * downstream and silently poison a sum; an explicit zero cannot. The
   * fare_configs.base_fare column is likewise zeroed by migration rather than
   * dropped, so an old booking's frozen snapshot still reads honestly.
   *
   * Note the knock-on: the night percentage below was a share of
   * (base + distance) and is now a share of distance alone.
   */
  const base = M.dec(0);

  const distanceCharge = M.round2(M.mul(billableKm, config.perKm));

  /*
   * A round trip's distance is ALREADY both ways — quote.service doubles the
   * route before calling this. The line used to say only "Distance (868 km)",
   * which a rider reads as "where is the return?". The note says it outright.
   * When the minimum-km guarantee applies, its own note explains the figure.
   */
  let distanceNote = null;
  if (usedPerDayGuarantee) {
    distanceNote = `Minimum ${config.minKmPerDay} km/day x ${days} day(s) applied`;
  } else if (usedGuarantee) {
    // The flat floor. Says the actual distance too, so a rider who knows their
    // trip is 12 km is not left wondering where 50 came from.
    distanceNote = `Minimum ${M.toStr(flatMinimumKm)} km applied (trip is ${M.toStr(actualKm)} km)`;
  } else if (isRoundTrip && actualKm.greaterThan(0)) {
    distanceNote = `Both ways: ${M.toStr(M.div(actualKm, 2))} km there + ${M.toStr(M.div(actualKm, 2))} km back`;
  }

  breakdown.push({
    label: `Distance (${M.toStr(billableKm)} km x ${M.toStr(config.perKm)}/km)`,
    amount: M.toStr(distanceCharge),
    ...(distanceNote ? { note: distanceNote } : {}),
  });

  /* -- 3. time (one-way only) --------------------------------------- */

  // Round trips do not charge per minute: the driver allowance already pays for
  // the driver's time, and charging both would bill the same hours twice.
  let timeCharge = M.dec(0);
  if (!isRoundTrip && M.dec(config.perMinute).greaterThan(0)) {
    timeCharge = M.round2(M.mul(durationMin, config.perMinute));
    breakdown.push({
      label: `Time (${durationMin} min x ${M.toStr(config.perMinute)}/min)`,
      amount: M.toStr(timeCharge),
    });
  }

  /* -- 4. return-empty — RETIRED, ALWAYS ZERO ----------------------- *
   *
   * A one-way used to be charged its distance a second time (returnEmptyPct,
   * latterly 100%) to pay for the driver coming back without a passenger. So a
   * card advertising 19.00/km actually billed 38.00/km, and the rate sheet the
   * business publishes said one thing while the engine did another.
   *
   * THE RETURN IS NOW PRICED INTO THE ONE-WAY PER-KM RATE ITSELF.
   *
   * fare_configs is keyed by trip type, so ONE_WAY and ROUND_TRIP already have
   * independent `perKm` columns and have simply been carrying the same number.
   * They no longer need to: a one-way is set to the higher all-in rate (e.g.
   * 19.00/km, which already assumes an empty return) and a round trip to the
   * lower one (e.g. 12.00/km), because a round trip bills both legs with the
   * passenger aboard and does not need the loading.
   *
   * The result is that RETURN DISTANCE IS BILLED IN EXACTLY ONE PLACE: a
   * ROUND_TRIP, where quote.service doubles the route before pricing it. A
   * one-way is billed for the kilometres it actually covers, once.
   *
   * Held as a hard zero rather than deleted, for the same reason as the base
   * fare above it: `returnEmpty` is a key in the fareBasis frozen onto every
   * booking ever taken and in the invoice and admin surfaces that read it.
   * Removing it would read as `undefined` downstream and silently poison a
   * sum; an explicit zero cannot. Reading the literal rather than the column
   * also means a rate card not yet migrated to 0 cannot reintroduce the charge.
   */

  const returnEmptyCharge = M.dec(0);

  /* -- 5. driver allowance / bata (every trip type EXCEPT airport) -- *
   *
   * Per-day allowance for the driver being on duty. `days` is 1 for a one-way
   * trip and one per CALENDAR day for a round trip, so the same line covers
   * both without a special case.
   *
   * Airport transfers are exempt — see ALLOWANCE_EXEMPT_TRIP_TYPES.
   */

  let bata = M.dec(0);
  if (!exemptFromAllowances && M.dec(config.driverAllowance ?? 0).greaterThan(0)) {
    bata = M.round2(M.mul(config.driverAllowance, days));
    breakdown.push({
      label:
        days > 1
          ? `Driver allowance (${days} days x ${M.toStr(config.driverAllowance)})`
          : `Driver allowance (${M.toStr(config.driverAllowance)})`,
      amount: M.toStr(bata),
      note: 'Bata paid to the driver',
    });
  }

  /* -- 6. waiting — NOT CHARGED ------------------------------------- *
   *
   * A trip starts when the driver reaches the pickup point, so there is no idle
   * period to bill for. Time only costs the rider if the JOURNEY runs past the
   * hours they booked, and that is settled at trip end by
   * computeExtraTimeCharge, not guessed at quote time.
   *
   * Kept as a zero rather than deleted so every downstream consumer — the
   * breakdown, the invoice, the frozen fareBasis of bookings already taken —
   * keeps the same shape. A missing key would read as undefined and quietly
   * poison a sum; an explicit zero cannot.
   */

  const waitingCharge = M.dec(0);
  const chargeableWaitMin = 0;

  /* -- 7. night allowance (every trip type EXCEPT airport) ---------- *
   *
   * Two independent parts, either of which a city may leave at 0:
   *   • a FLAT allowance for any trip touching the window (the usual shape of
   *     "night bata" — the driver loses a night's sleep whether the trip is
   *     8km or 80km, so a percentage of distance is the wrong instrument)
   *   • a PERCENTAGE uplift on base + distance
   *
   * The percentage deliberately excludes bata and waiting: those are fixed
   * allowances, not distance-driven, and uplifting them would overcharge.
   *
   * IMPORTANT: whether the trip is "at night" is decided BEFORE the exemption,
   * so meta.isNight still reports the truth about the clock for an airport run
   * at 2am. Only the money is exempt. Reporting that wants to know how many
   * airport trips run overnight can still answer the question.
   */

  const nightWindow = nightWindowFromConfig(config);
  const touchesNightWindow = touchesNight(pickupAt, returnAt, nightWindow, timeZone);

  let nightCharge = M.dec(0);
  const nightPct = M.dec(config.nightChargePct ?? 0);
  const nightFlat = M.dec(config.nightAllowance ?? 0);
  const nightIsChargeable =
    touchesNightWindow && !exemptFromAllowances && (nightPct.greaterThan(0) || nightFlat.greaterThan(0));

  if (nightIsChargeable) {
    // Base fare is retired, so this is a share of the DISTANCE charge alone.
    const pctPart = nightPct.greaterThan(0)
      ? M.round2(M.pct(distanceCharge, nightPct))
      : M.dec(0);
    nightCharge = M.round2(M.add(nightFlat, pctPart));

    // One line, not two: the customer cares that a night allowance applied and
    // what it cost, not that it happens to be assembled from a flat part and a
    // percentage part. The note carries the detail if anyone asks.
    const detail = [];
    if (nightFlat.greaterThan(0)) detail.push(`flat ${M.toStr(nightFlat)}`);
    if (nightPct.greaterThan(0)) detail.push(`${M.toStr(nightPct)}% of distance`);

    breakdown.push({
      label: 'Night allowance',
      amount: M.toStr(nightCharge),
      note: `Trip falls within ${formatNightWindow(nightWindow)} (${detail.join(' + ')})`,
    });
  }

  // Kept for meta/back-compat: did the MONEY apply?
  const isNight = nightIsChargeable;

  /* -- 7b. airport surcharge (airport only) ------------------------- */

  // A flat fee for airport pickups/drops (parking, entry toll, queueing),
  // added on top of the normal distance fare. 0 in config disables it.
  let airportCharge = M.dec(0);
  if (isAirport && M.dec(config.airportSurcharge ?? 0).greaterThan(0)) {
    airportCharge = M.round2(M.dec(config.airportSurcharge));
    breakdown.push({
      label: 'Airport surcharge',
      amount: M.toStr(airportCharge),
      note: 'Airport parking / entry toll',
    });
  }

  /* -- 8. surge ------------------------------------------------------ */

  // M.sum takes an ARRAY. M.add is binary — calling it with seven arguments
  // silently discarded everything after the second, so time, return-empty,
  // bata, waiting and night appeared in the breakdown but never reached the
  // total. The breakdown-sums-to-total test is what caught it.
  const subtotal = M.sum([
    base,
    distanceCharge,
    timeCharge,
    returnEmptyCharge,
    bata,
    waitingCharge,
    nightCharge,
    airportCharge,
  ]);

  const surge = clampSurge(requestedSurge, config);
  const surgeAmount = surge.equals(1) ? M.dec(0) : M.round2(M.sub(M.mul(subtotal, surge), subtotal));

  if (!surgeAmount.isZero()) {
    breakdown.push({
      label: `Demand pricing (${surge.toFixed(2)}x)`,
      amount: M.toStr(surgeAmount),
      note: `Capped between ${config.minSurge}x and ${config.maxSurge}x`,
    });
  }

  const afterSurge = M.add(subtotal, surgeAmount);

  /* -- 9. minimum fare floor ---------------------------------------- */

  /*
   * THE RUPEE FLOOR IS RETIRED. The floor is now a DISTANCE, applied at step 1.
   *
   * A minimum expressed in money has to be re-derived by hand every time a
   * per-km rate moves: put the rate up and yesterday's ₹900 minimum quietly
   * stops representing the distance it was written for. "Minimum 50 km" keeps
   * its meaning and re-prices itself off whatever the current rate is.
   *
   * It also reads better. The old floor appeared as a "Minimum fare
   * adjustment" line with no relationship to anything above it; the new one
   * simply shows the rider the kilometres they were billed for, with a note
   * saying the trip was shorter.
   *
   * `minimumFareAdjustment` stays in the return shape as an explicit zero —
   * it is part of the frozen fareBasis on every past booking and is summed by
   * the invoice and admin surfaces. The component identity still holds:
   *   subtotal + surgeAmount + minimumFareAdjustment + roundingAdjustment = total.
   */
  const minimumFareAdjustment = M.dec(0);
  const belowMinimum = false;
  const beforeRounding = afterSurge;

  // Whole rupees, applied ONCE at the end. Rounding each component would
  // compound the error and make the breakdown fail to sum to the total.
  const total = M.roundRupee(beforeRounding);
  const roundingAdjustment = M.sub(total, beforeRounding);

  // Surface the rounding as its own line. Without it the breakdown does not sum
  // to the total, and a customer adding up the components gets a different
  // number from the one they are charged — which reads as a billing error even
  // though it is only 40 paise.
  if (!roundingAdjustment.isZero()) {
    breakdown.push({
      label: 'Rounding',
      amount: M.toStr(roundingAdjustment),
      note: 'Rounded to the nearest rupee',
    });
  }

  return {
    tripType,
    currency: 'INR',

    // Every amount is a STRING — a float here would defeat the whole exercise.
    base: M.toStr(base),
    distance: M.toStr(distanceCharge),
    time: M.toStr(timeCharge),
    returnEmpty: M.toStr(returnEmptyCharge),
    bata: M.toStr(bata),
    waiting: M.toStr(waitingCharge),
    night: M.toStr(nightCharge),
    airport: M.toStr(airportCharge),
    surgeAmount: M.toStr(surgeAmount),
    subtotal: M.toStr(subtotal),
    minimumFareAdjustment: M.toStr(minimumFareAdjustment),
    total: total.toFixed(2),

    meta: {
      actualKm: M.toStr(actualKm),
      billableKm: M.toStr(billableKm),
      // A distance floor lifted the billable km above what was actually
      // driven. True for EITHER floor; the two flags below say which.
      usedMinimumKmGuarantee: usedGuarantee,
      // The ROUND_TRIP per-day guarantee (minKmPerDay x days).
      usedPerDayKmGuarantee: usedPerDayGuarantee,
      // The flat per-card floor (minimumKm), which replaced the rupee
      // minimum-fare floor and applies to every trip type.
      usedMinimumKm: usedGuarantee && !usedPerDayGuarantee,
      minimumKm: M.toStr(flatMinimumKm),
      durationMin: Number(durationMin),
      days,
      chargeableWaitMin,

      // isNight = the night allowance was CHARGED.
      // touchesNightWindow = the clock says night, regardless of whether it was
      // charged. They differ for an airport trip at 2am, and keeping both means
      // "why was there no night allowance?" is answerable from the frozen fare
      // alone, without re-deriving anything.
      isNight,
      touchesNightWindow,
      nightWindow: formatNightWindow(nightWindow),
      allowancesExempt: exemptFromAllowances,
      allowancesExemptReason: exemptFromAllowances
        ? `${tripType} trips do not attract night or driver allowance`
        : null,

      surgeMultiplier: surge.toFixed(2),
      // True when the rate card's band moved the multiplier it was handed.
      // Now that surge is live for metro pickups this is meaningful again: it
      // says the premium a tier rule asked for was capped by THIS card, which
      // is the first thing to check when a fare carries less surge than
      // expected.
      surgeWasClamped: !surge.equals(M.dec(requestedSurge ?? 1)),
      // Demand pricing is enabled, but only ever applies to a METRO pickup —
      // surge.service returns 1x for every other tier. Kept in the frozen fare
      // so "why did this trip carry no premium?" is answerable without
      // re-deriving the tier months later.
      surgeDisabled: false,
      surgeMetroOnly: true,
      // The rupee minimum-fare floor is retired; the floor is a distance now.
      // Always false, kept so an old booking's fareBasis reads the same shape.
      belowMinimumFare: belowMinimum,
      roundingAdjustment: M.toStr(roundingAdjustment),
    },

    breakdown,

    // Frozen onto booking.fareBasis so a six-month-old fare stays explainable
    // even after the rate card changes.
    configSnapshot: {
      fareConfigId: config.id ?? null,
      cityId: config.cityId ?? null,
      vehicleClass: config.vehicleClass ?? null,
      // Always '0.00'. Read from a literal rather than from config, so a rate
      // card row that has not yet been migrated to zero cannot reintroduce a
      // base fare into a frozen snapshot.
      baseFare: '0.00',
      perKm: M.toStr(config.perKm),
      perMinute: M.toStr(config.perMinute ?? 0),
      // Both always '0.00', read from literals rather than from config for the
      // same reason as baseFare above: a rate card row not yet migrated to
      // zero must not be able to reintroduce a retired charge into a frozen
      // snapshot. The rupee floor is replaced by minimumKm, and the one-way
      // return leg is priced into the ONE_WAY perKm rate.
      minimumFare: '0.00',
      returnEmptyPct: '0.00',
      // The live distance floors, frozen so an extra-distance settlement months
      // later can be checked against the terms the trip was actually sold on.
      minimumKm: M.toStr(config.minimumKm ?? 0),
      minKmPerDay: Number(config.minKmPerDay ?? 0),
      driverAllowance: M.toStr(config.driverAllowance ?? 0),
      // Waiting is no longer charged; both are frozen at their config values
      // purely so an OLD booking's fareBasis still reads the same shape.
      waitingPerHour: M.toStr(config.waitingPerHour ?? 0),
      freeWaitingMin: Number(config.freeWaitingMin ?? 0),

      // The rates an overrun is settled at. Frozen here so a rate card edited
      // mid-trip cannot change what the trip ends up costing. No package rates:
      // a package is only ever priced by computeHourlyFare, which freezes its
      // own snapshot.
      hourlyRate: M.toStr(config.hourlyRate ?? 0),
      hourlyKmPerHour: Number(config.hourlyKmPerHour ?? 0),
      nightAllowance: M.toStr(config.nightAllowance ?? 0),
      nightChargePct: M.toStr(config.nightChargePct ?? 0),
      nightStartHour: Number(config.nightStartHour ?? 21),
      nightStartMinute: Number(config.nightStartMinute ?? 55),
      nightEndHour: Number(config.nightEndHour ?? 6),
      nightEndMinute: Number(config.nightEndMinute ?? 0),
      nightWindow: formatNightWindow(nightWindow),
      allowanceExemptTripTypes: [...ALLOWANCE_EXEMPT_TRIP_TYPES],
      computedAt: new Date().toISOString(),
    },
  };
}

/**
 * Cancellation fee for a booking that has not started.
 *
 * The window rules are ABHICABS policy, read from config rather than hardcoded:
 * free beyond the free-cancellation window, a short-notice fee inside it.
 *
 * NOTE: the 30-60 minute band is still an open business decision. Until it is
 * confirmed, `shortNoticeMinutes` and `freeCancellationMinutes` come from the
 * caller so the behaviour is a configuration change, not a code change.
 */
function computeCancellationFee({
  pickupAt,
  now = new Date(),
  fareTotal,
  config,
  freeCancellationMinutes = 60,
  shortNoticeMinutes = 30,
}) {
  const minutesToPickup = Math.floor(
    (new Date(pickupAt).getTime() - new Date(now).getTime()) / 60000
  );

  // An invalid or missing pickupAt yields NaN, and NaN fails every comparison
  // below — so the function would fall through to the INTERMEDIATE branch and
  // return a FREE cancellation. That is failing OPEN on money: a malformed
  // request would waive the fee. Refuse instead and let the caller fix its input.
  if (!Number.isFinite(minutesToPickup)) {
    throw new Error('[fare] computeCancellationFee requires a valid pickupAt');
  }

  if (minutesToPickup >= freeCancellationMinutes) {
    return {
      fee: '0.00',
      band: 'FREE',
      minutesToPickup,
      reason: `Cancelled more than ${freeCancellationMinutes} minutes before pickup`,
    };
  }

  if (minutesToPickup <= shortNoticeMinutes) {
    const flat = M.dec(config?.cancellationFee ?? 0);
    return {
      fee: M.toStr(flat),
      band: 'SHORT_NOTICE',
      minutesToPickup,
      reason: `Cancelled within ${shortNoticeMinutes} minutes of pickup`,
    };
  }

  // Between the two thresholds.
  //
  // ABHICABS policy (confirmed): this window is FREE, the same as cancelling
  // well ahead. cancellation.service passes the same value for both thresholds
  // so the bands collapse to two — free at 30+ minutes, full fee under 30 —
  // but the band name is kept distinct so reporting can still answer "how many
  // cancellations landed in the 30-60 minute window".
  return {
    fee: '0.00',
    band: 'INTERMEDIATE',
    minutesToPickup,
    reason: `Cancelled between ${shortNoticeMinutes} and ${freeCancellationMinutes} minutes before pickup`,
    note: 'Policy for this window is pending confirmation from ABHICABS',
  };
}

/**
 * Extra-distance charge — when a trip covers MORE kilometres than were quoted.
 *
 * The driver (or ops) reports the actual distance travelled at trip end. If it
 * exceeds the distance the fare was quoted on, the surplus km are charged at the
 * SAME per-km rate the booking was quoted at — read from the booking's frozen
 * `fareBasis.configSnapshot`, never the current rate card. That freeze is what
 * makes the extra charge fair and dispute-proof: a rate change months later
 * cannot retroactively alter what this specific trip costs per km.
 *
 * Deliberately conservative:
 *   - Only surplus over the quoted distance is charged (never a negative/credit
 *     for driving less — the quote already committed a price).
 *   - Surge is NOT re-applied to extra km. Surge reflected demand at booking
 *     time; extra distance discovered mid-trip is not a new surge event.
 *   - Night/return-empty/bata are not recomputed — those are journey-level
 *     allowances already settled in the original fare.
 * The result is the cleanest, most defensible line: extraKm x perKm.
 *
 * @param {object} args
 * @param {object} args.fareBasis   booking.fareBasis (frozen quote)
 * @param {number|string} args.quotedKm   distance the fare was quoted on
 * @param {number|string} args.actualKm   distance actually travelled
 * @returns {{
 *   extraKm: string, perKm: string, extraCharge: string,
 *   quotedKm: string, actualKm: string, hasExtra: boolean
 * }}
 */
function computeExtraDistanceCharge({ fareBasis, quotedKm, actualKm }) {
  // The booking stores the quote under fareBasis.components (see
  // booking.service.js), so the frozen rate card lives at
  // fareBasis.components.configSnapshot. Fall back to a top-level configSnapshot
  // for any caller that passes the raw quote object directly.
  const fb = fareBasis || {};
  const quote = fb.components || fb;
  const snap = quote.configSnapshot || fb.configSnapshot || {};
  const perKm = M.dec(snap.perKm ?? 0);

  // Quoted distance: prefer the frozen quote's actualKm, else the caller's value.
  const quotedFromBasis = quote.meta && quote.meta.actualKm != null ? quote.meta.actualKm : null;
  const quoted = M.dec(quotedFromBasis ?? quotedKm ?? 0);
  const actual = M.dec(actualKm ?? 0);

  // Only the surplus is billable; clamp at zero so driving less is never a credit.
  const extraKm = M.max(M.sub(actual, quoted), M.dec(0));
  const extraCharge = M.round2(M.mul(extraKm, perKm));

  return {
    quotedKm: M.toStr(quoted),
    actualKm: M.toStr(actual),
    extraKm: M.toStr(extraKm),
    perKm: M.toStr(perKm),
    extraCharge: M.toStr(extraCharge),
    hasExtra: M.gt(extraKm, 0) && M.gt(extraCharge, 0),
  };
}

/**
 * Extra charge for a trip that ran past the hours it was booked for.
 *
 * The time counterpart of computeExtraDistanceCharge, and settled the same way:
 * at trip end, from the FROZEN quote, never at booking time. Only the surplus
 * is billable — finishing early is never a credit.
 *
 * Which rate applies depends on what was actually sold:
 *
 *   • A rental PACKAGE ("8 hrs / 80 km") carries its own extraPerHour. That
 *     rate is part of the product the rider bought, so it wins.
 *   • Flexible hours fall back to the rate card's hourlyRate — the rider is
 *     simply buying more of the same thing.
 *
 * Both come from fareBasis rather than the live config, so a rate card edited
 * after the booking cannot change what an in-flight trip costs.
 *
 * Partial hours are billed pro-rata rather than rounded up to a whole hour.
 * Rounding up turns a nine-minute overrun into a full hour's charge, which is
 * the kind of surprise that generates a refund request rather than a payment.
 *
 * @param {object} args
 * @param {object} args.fareBasis    booking.fareBasis (the frozen quote)
 * @param {number|string} args.bookedHours  hours the fare was quoted on
 * @param {number|string} args.actualHours  hours the trip actually took
 * @returns {{
 *   bookedHours: string, actualHours: string, extraHours: string,
 *   perHour: string, extraCharge: string, source: string, hasExtra: boolean
 * }}
 */
function computeExtraTimeCharge({ fareBasis, bookedHours, actualHours }) {
  const fb = fareBasis || {};
  const quote = fb.components || fb;
  const snap = quote.configSnapshot || fb.configSnapshot || {};

  // A package's own overage rate beats the generic hourly rate.
  const pkgRate = M.dec(snap.rentalExtraPerHour ?? quote.rentalExtraPerHour ?? 0);
  const usePackageRate = M.gt(pkgRate, 0);
  const perHour = usePackageRate ? pkgRate : M.dec(snap.hourlyRate ?? 0);

  // Prefer the hours the frozen quote was priced on, so re-reporting the same
  // trip never compounds the charge.
  const bookedFromBasis =
    quote.meta && quote.meta.includedHours != null ? quote.meta.includedHours : null;
  const booked = M.dec(bookedFromBasis ?? bookedHours ?? 0);
  const actual = M.dec(actualHours ?? 0);

  const extraHours = M.max(M.sub(actual, booked), M.dec(0));
  const extraCharge = M.round2(M.mul(extraHours, perHour));

  return {
    bookedHours: M.toStr(booked),
    actualHours: M.toStr(actual),
    extraHours: M.toStr(extraHours),
    perHour: M.toStr(perHour),
    extraCharge: M.toStr(extraCharge),
    source: usePackageRate ? 'package' : 'hourly-rate',
    hasExtra: M.gt(extraHours, 0) && M.gt(extraCharge, 0),
  };
}

module.exports = {
  computeFare,
  computeCancellationFee,
  computeExtraDistanceCharge,
  computeExtraTimeCharge,
  chargeableDays,
  isNightHour,
  isNightMinute,
  minutesOfDay,
  nightWindowFromConfig,
  formatNightWindow,
  touchesNight,
  isAllowanceExempt,
  ALLOWANCE_EXEMPT_TRIP_TYPES,
  clampSurge,
};