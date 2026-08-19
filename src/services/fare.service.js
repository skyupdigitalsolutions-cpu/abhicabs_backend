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
 *   1. billable distance   max(actual, minimum guarantee)
 *   2. distance charge     billableKm x perKm
 *   3. time charge         durationMin x perMinute        (one-way only)
 *   4. return-empty        % of distance charge           (one-way only)
 *   5. driver allowance    bata x days                    (round trip only)
 *   6. waiting charge      chargeable hours x rate        (round trip only)
 *   7. night charge        % of (base + distance) only
 *   8. surge               multiplies the subtotal, bounded by config
 *   9. minimum fare floor  applied LAST
 *
 * Night charge deliberately excludes bata and waiting: those are fixed
 * allowances, not distance-driven, and uplifting them would overcharge.
 * The minimum-fare floor is last so it is a true floor on what is payable.
 */

const M = require('../lib/money');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

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

/**
 * Does an hour fall inside the night window?
 *
 * Handles the wrap across midnight: a window of 22:00-06:00 has start > end, so
 * "inside" means hour >= 22 OR hour < 6. Treating it as a simple range would
 * make the window match nothing at all.
 */
function isNightHour(hour, startHour, endHour) {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * A trip attracts the night charge if EITHER end falls in the window,
 * evaluated in the CITY's timezone rather than the server's.
 */
function touchesNight(pickupAt, returnAt, startHour, endHour, timeZone = DEFAULT_TIMEZONE) {
  const hours = [zonedParts(pickupAt, timeZone).hour];
  if (returnAt) hours.push(zonedParts(returnAt, timeZone).hour);
  return hours.some((h) => isNightHour(h, startHour, endHour));
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
function clampSurge(requested, config) {
  const value = M.dec(requested ?? 1);
  const lo = M.dec(config.minSurge ?? 0.5);
  const hi = M.dec(config.maxSurge ?? 2);
  if (value.lessThan(lo)) return lo;
  if (value.greaterThan(hi)) return hi;
  return value;
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

/**
 * @param {object} input
 *   tripType       'ONE_WAY' | 'ROUND_TRIP'
 *   distanceKm     road distance. For a round trip this is the TOTAL both ways.
 *   durationMin    driving minutes
 *   pickupAt       ISO string or Date
 *   returnAt       ISO string or Date  (round trip)
 *   waitingMinutes total waiting during the journey (round trip)
 *   surge          requested multiplier, clamped to the config band
 *
 * @param {object} config  a fare_configs row
 *
 * @returns {object} components as strings, plus a human-readable breakdown
 */
function computeFare(input, config) {
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

  // A round trip guarantees a minimum billable distance per day. A customer who
  // keeps the vehicle for two days and drives 40km still occupies it for two
  // days, and the guarantee is what makes that economic for the operator.
  const guaranteedKm = isRoundTrip ? M.mul(config.minKmPerDay ?? 0, days) : M.dec(0);
  const billableKm = M.max(actualKm, guaranteedKm);

  const usedGuarantee = isRoundTrip && billableKm.greaterThan(actualKm);

  /* -- 2. base + distance ------------------------------------------ */

  const base = M.dec(config.baseFare);
  breakdown.push({ label: 'Base fare', amount: M.toStr(base) });

  const distanceCharge = M.round2(M.mul(billableKm, config.perKm));
  breakdown.push({
    label: `Distance (${M.toStr(billableKm)} km x ${M.toStr(config.perKm)}/km)`,
    amount: M.toStr(distanceCharge),
    ...(usedGuarantee
      ? { note: `Minimum ${config.minKmPerDay} km/day x ${days} day(s) applied` }
      : {}),
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

  /* -- 4. return-empty (one-way only) ------------------------------- */

  // On an outstation one-way the driver returns with no passenger. A share of
  // that return leg may be charged; 0 in config disables it entirely.
  let returnEmptyCharge = M.dec(0);
  if (!isRoundTrip && M.dec(config.returnEmptyPct ?? 0).greaterThan(0)) {
    returnEmptyCharge = M.round2(M.pct(distanceCharge, config.returnEmptyPct));
    breakdown.push({
      label: `Return journey (${M.toStr(config.returnEmptyPct)}% of distance)`,
      amount: M.toStr(returnEmptyCharge),
      note: 'Driver returns without a passenger',
    });
  }

  /* -- 5. driver allowance (round trip only) ------------------------ */

  let bata = M.dec(0);
  if (isRoundTrip && M.dec(config.driverAllowance ?? 0).greaterThan(0)) {
    bata = M.round2(M.mul(config.driverAllowance, days));
    breakdown.push({
      label: `Driver allowance (${days} day${days > 1 ? 's' : ''} x ${M.toStr(config.driverAllowance)})`,
      amount: M.toStr(bata),
    });
  }

  /* -- 6. waiting (round trip only) --------------------------------- */

  let waitingCharge = M.dec(0);
  let chargeableWaitMin = 0;
  if (isRoundTrip && M.dec(config.waitingPerHour ?? 0).greaterThan(0)) {
    const free = Number(config.freeWaitingMin ?? 0);
    chargeableWaitMin = Math.max(0, Number(waitingMinutes) - free);
    if (chargeableWaitMin > 0) {
      waitingCharge = M.round2(M.mul(M.div(chargeableWaitMin, 60), config.waitingPerHour));
      breakdown.push({
        label: `Waiting (${chargeableWaitMin} min beyond ${free} free)`,
        amount: M.toStr(waitingCharge),
      });
    }
  }

  /* -- 7. night charge ---------------------------------------------- */

  // Applied to base + distance ONLY. Bata and waiting are fixed allowances, not
  // distance-driven, so uplifting them for a night departure would overcharge.
  let nightCharge = M.dec(0);
  const nightPct = M.dec(config.nightChargePct ?? 0);
  const isNight =
    nightPct.greaterThan(0) &&
    touchesNight(
      pickupAt,
      returnAt,
      Number(config.nightStartHour ?? 22),
      Number(config.nightEndHour ?? 6),
      timeZone
    );

  if (isNight) {
    nightCharge = M.round2(M.pct(M.add(base, distanceCharge), nightPct));
    breakdown.push({
      label: `Night charge (${M.toStr(nightPct)}%)`,
      amount: M.toStr(nightCharge),
      note: `Between ${config.nightStartHour}:00 and ${config.nightEndHour}:00`,
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

  const minimumFare = M.dec(config.minimumFare ?? 0);
  const belowMinimum = afterSurge.lessThan(minimumFare);
  // The top-up that lifts a sub-floor fare to the minimum. Held as a named
  // amount so the components reconcile:
  //   subtotal + surgeAmount + minimumFareAdjustment + roundingAdjustment = total.
  // Without it, subtotal (710.40) plus the named parts does not reach total (800).
  const minimumFareAdjustment = belowMinimum ? M.sub(minimumFare, afterSurge) : M.dec(0);
  const beforeRounding = belowMinimum ? minimumFare : afterSurge;

  if (belowMinimum) {
    breakdown.push({
      label: 'Minimum fare adjustment',
      amount: M.toStr(minimumFareAdjustment),
      note: `Minimum fare for this vehicle class is ${M.toStr(minimumFare)}`,
    });
  }

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
    surgeAmount: M.toStr(surgeAmount),
    subtotal: M.toStr(subtotal),
    minimumFareAdjustment: M.toStr(minimumFareAdjustment),
    total: total.toFixed(2),

    meta: {
      actualKm: M.toStr(actualKm),
      billableKm: M.toStr(billableKm),
      // The minimum-km-per-day distance floor (round trips only). Distinct from
      // belowMinimumFare below, which is the minimum-FARE floor.
      usedMinimumKmGuarantee: usedGuarantee,
      durationMin: Number(durationMin),
      days,
      chargeableWaitMin,
      isNight,
      surgeMultiplier: surge.toFixed(2),
      surgeWasClamped: !surge.equals(M.dec(requestedSurge ?? 1)),
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
      baseFare: M.toStr(config.baseFare),
      perKm: M.toStr(config.perKm),
      perMinute: M.toStr(config.perMinute ?? 0),
      minimumFare: M.toStr(config.minimumFare ?? 0),
      returnEmptyPct: M.toStr(config.returnEmptyPct ?? 0),
      minKmPerDay: Number(config.minKmPerDay ?? 0),
      driverAllowance: M.toStr(config.driverAllowance ?? 0),
      waitingPerHour: M.toStr(config.waitingPerHour ?? 0),
      freeWaitingMin: Number(config.freeWaitingMin ?? 0),
      nightChargePct: M.toStr(config.nightChargePct ?? 0),
      nightStartHour: Number(config.nightStartHour ?? 22),
      nightEndHour: Number(config.nightEndHour ?? 6),
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

module.exports = {
  computeFare,
  computeCancellationFee,
  chargeableDays,
  isNightHour,
  touchesNight,
  clampSurge,
};