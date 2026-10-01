/**
 * tests/allowances.test.js
 *
 * Night allowance + driver allowance (bata), and how they reach the invoice.
 *
 * Unlike api.test.js these need NO database and NO server: the fare engine is
 * a pure function and buildInvoiceLines is pure too. That is the point — a
 * night-window test should not have to run at 11pm, and an invoice test should
 * not have to seed a booking.
 *
 * Run:  npm test
 */

import { describe, it, expect } from 'vitest';

import fare from '../src/services/fare.service.js';
import billing from '../src/services/billing.service.js';
import M from '../src/lib/money.js';

const CONFIG = {
  baseFare: 100,
  perKm: 14,
  perMinute: 1,
  // Retired: a rupee floor is no longer applied anywhere. Kept non-zero on
  // purpose so the "ignores a retired minimum fare" test below proves the
  // engine does not read it, rather than proving nothing because it was 0.
  minimumFare: 200,
  // The replacement: a floor on billable DISTANCE. 0 = off for most tests,
  // overridden where the floor itself is what is under test.
  minimumKm: 0,
  driverAllowance: 400,   // bata per day
  nightAllowance: 300,    // flat
  nightChargePct: 10,     // plus 10% of the distance charge
  // Retired: kept here only to prove the engine ignores it. See the
  // "never uplifts a base fare" test below.
  nightStartHour: 21,
  nightStartMinute: 55,
  nightEndHour: 6,
  nightEndMinute: 0,
  minKmPerDay: 250,
  airportSurcharge: 150,
  maxSurge: 2,
  // 1.00, matching the schema default and the migration — NOT the 0.5 this
  // used to carry. MVAG permits a 0.5x floor and the engine honours whatever
  // band the card states, so a card left at 0.5 would let the clamp DISCOUNT a
  // fare. Nothing reaches the engine below 1x today (surge.service floors it),
  // but a test config that differs from production is exactly where a latent
  // hazard hides from its own test suite.
  minSurge: 1,
};

/** IST instant, so the test states the local wall-clock time it means. */
const ist = (hhmm, date = '2026-09-10') => new Date(`${date}T${hhmm}:00+05:30`);

const quote = (overrides = {}, config = CONFIG) =>
  fare.computeFare(
    {
      tripType: 'ONE_WAY',
      distanceKm: 20,
      durationMin: 40,
      pickupAt: ist('12:00'),
      timeZone: 'Asia/Kolkata',
      ...overrides,
    },
    config
  );

describe('demand pricing — live, clamped to the rate card band', () => {
  // Surge is charged again, but ONLY for metro pickups and only at a
  // percentage an admin set. That decision lives in surge.service, which is
  // async and database-backed; what the ENGINE owes is the band.

  it('applies a multiplier the caller was given', () => {
    const plain = quote();
    const surged = quote({ surge: 1.5 });
    // 1.5x on a subtotal, so the premium is half the subtotal again.
    expect(Number(surged.surgeAmount)).toBeCloseTo(Number(plain.subtotal) * 0.5, 2);
    expect(Number(surged.total)).toBeGreaterThan(Number(plain.total));
  });

  it('clamps a multiplier above the card ceiling', () => {
    // MVAG caps dynamic pricing at 2x the notified fare, and maxSurge is where
    // that lives. A rule row asking for more must not be able to exceed it.
    const q = quote({ surge: 5 });
    expect(q.meta.surgeMultiplier).toBe('2.00');
    expect(q.meta.surgeWasClamped).toBe(true);
  });

  it('a card left at maxSurge 1.00 is exempt however high the request', () => {
    // This is how one class or trip type is taken out of surge without
    // touching the tier rules, so it has to keep working.
    const exempt = { ...CONFIG, minSurge: 1, maxSurge: 1 };
    const q = fare.computeFare(
      { tripType: 'ONE_WAY', distanceKm: 20, durationMin: 40, pickupAt: ist('12:00'), surge: 2 },
      exempt
    );
    expect(q.meta.surgeMultiplier).toBe('1.00');
    expect(q.surgeAmount).toBe('0.00');
  });

  it('never discounts: a sub-1 multiplier is lifted to the card floor', () => {
    // Three independent things stop a fare being discounted by a surge value:
    // surge.service floors its result at 1, min_surge is 1.00 on every row,
    // and the schema default is 1.00. This covers the last of the three.
    const q = quote({ surge: 0.2 });
    expect(q.meta.surgeMultiplier).toBe('1.00');
    expect(q.surgeAmount).toBe('0.00');
  });

  it('honours a minSurge below 1 if a card genuinely states one', () => {
    // Documenting the behaviour rather than endorsing it: the clamp is a BAND
    // and respects what the card says. MVAG permits 0.5x, so this is legal —
    // but it means a mis-typed min_surge is a discount, which is why both the
    // migration and the schema default pin it to 1.00.
    const discounting = { ...CONFIG, minSurge: 0.5 };
    const q = fare.computeFare(
      { tripType: 'ONE_WAY', distanceKm: 20, durationMin: 40, pickupAt: ist('12:00'), surge: 0.2 },
      discounting
    );
    expect(q.meta.surgeMultiplier).toBe('0.50');
  });

  it('shows no demand pricing line when no premium applies', () => {
    const q = quote({ surge: 1 });
    expect(q.breakdown.some((l) => l.label.startsWith('Demand pricing'))).toBe(false);
  });
});

describe('return leg — retired, never charged', () => {
  // A one-way used to be billed its distance TWICE: once outbound and again
  // through returnEmptyPct, so a card advertising 14.00/km billed 28.00/km.
  // The empty return is priced into the ONE_WAY per-km rate now, and the
  // engine must not be able to re-apply it.

  it('charges a one-way for the distance it covers, once', () => {
    const q = quote({ distanceKm: 100 });
    expect(q.distance).toBe('1400.00');
    expect(q.returnEmpty).toBe('0.00');
  });

  it('ignores a returnEmptyPct left on an un-migrated rate card', () => {
    // The migration zeroes the column, but the engine must not depend on that
    // having been run — this is the regression that would silently double
    // every one-way fare again.
    const stale = { ...CONFIG, returnEmptyPct: 100 };
    const q = quote({ distanceKm: 100 }, stale);
    expect(q.returnEmpty).toBe('0.00');
    expect(q.distance).toBe('1400.00');
  });

  it('shows no return journey line in the breakdown', () => {
    const q = quote({ distanceKm: 100 }, { ...CONFIG, returnEmptyPct: 100 });
    expect(q.breakdown.some((l) => l.label.startsWith('Return journey'))).toBe(false);
  });

  it('still bills both legs of a round trip, whose distance is already doubled', () => {
    // The return distance is charged in exactly one place, and this is it.
    //
    // 600 km, not 200: quote.service has ALREADY doubled the route by the time
    // the engine sees it, and CONFIG.minKmPerDay is 250, so a 200 km round
    // trip is lifted to the 250 km guarantee and would test that floor instead
    // of the thing this case is about. Same-day return, so days = 1.
    const q = quote(
      { tripType: 'ROUND_TRIP', distanceKm: 600, returnAt: ist('18:00') },
      { ...CONFIG, returnEmptyPct: 100 }
    );
    expect(q.meta.billableKm).toBe('600.00');
    expect(q.distance).toBe('8400.00'); // 600 x 14, both legs, once
    expect(q.returnEmpty).toBe('0.00');
  });

  it('freezes returnEmptyPct as zero in the snapshot, whatever the card says', () => {
    const q = quote({ distanceKm: 100 }, { ...CONFIG, returnEmptyPct: 100 });
    expect(q.configSnapshot.returnEmptyPct).toBe('0.00');
  });
});

describe('minimum km — the distance floor that replaced the fare floor', () => {
  it('bills a short trip at the minimum distance', () => {
    const q = quote({ distanceKm: 12 }, { ...CONFIG, minimumKm: 50 });
    expect(q.meta.actualKm).toBe('12.00');
    expect(q.meta.billableKm).toBe('50.00');
    expect(q.distance).toBe('700.00'); // 50 x 14
    expect(q.meta.usedMinimumKm).toBe(true);
  });

  it('leaves a trip above the floor alone', () => {
    const q = quote({ distanceKm: 80 }, { ...CONFIG, minimumKm: 50 });
    expect(q.meta.billableKm).toBe('80.00');
    expect(q.meta.usedMinimumKmGuarantee).toBe(false);
  });

  it('says so in the breakdown, with the real distance', () => {
    // The old rupee floor appeared as an unexplained "Minimum fare adjustment"
    // with no relationship to anything above it. This names both numbers.
    const q = quote({ distanceKm: 12 }, { ...CONFIG, minimumKm: 50 });
    const line = q.breakdown.find((l) => l.label.startsWith('Distance'));
    expect(line.note).toContain('50');
    expect(line.note).toContain('12');
  });

  it('takes the larger of the flat floor and the per-day guarantee', () => {
    // Both describe the least distance billable, so they must not be summed —
    // that would double-count a short two-day round trip.
    const q = quote(
      { tripType: 'ROUND_TRIP', distanceKm: 40, returnAt: ist('18:00', '2026-09-11') },
      { ...CONFIG, minimumKm: 50, minKmPerDay: 250 }
    );
    // 2 calendar days x 250 = 500, which beats the flat 50.
    expect(q.meta.billableKm).toBe('500.00');
    expect(q.meta.usedPerDayKmGuarantee).toBe(true);
  });

  it('ignores a retired minimum fare entirely', () => {
    // CONFIG.minimumFare is 200 and this fare lands below it. Nothing should
    // top it up, and no adjustment line should appear.
    const q = quote({ distanceKm: 1, durationMin: 1 });
    expect(q.minimumFareAdjustment).toBe('0.00');
    expect(q.meta.belowMinimumFare).toBe(false);
    expect(q.breakdown.some((l) => l.label.startsWith('Minimum fare'))).toBe(false);
    expect(q.configSnapshot.minimumFare).toBe('0.00');
  });
});

describe('night window — 21:55 to 06:00, to the minute', () => {
  it('does not charge at 21:54, one minute before the window opens', () => {
    const q = quote({ pickupAt: ist('21:54') });
    expect(q.meta.isNight).toBe(false);
    expect(q.night).toBe('0.00');
  });

  it('charges at 21:55 exactly — the start boundary is inclusive', () => {
    const q = quote({ pickupAt: ist('21:55') });
    expect(q.meta.isNight).toBe(true);
    expect(M.dec(q.night).greaterThan(0)).toBe(true);
  });

  it('charges across midnight, at 05:59', () => {
    expect(quote({ pickupAt: ist('05:59') }).meta.isNight).toBe(true);
  });

  it('does not charge at 06:00 — the end boundary is exclusive', () => {
    expect(quote({ pickupAt: ist('06:00') }).meta.isNight).toBe(false);
  });

  it('leaves the window with no gap: every minute is night or day, never both', () => {
    const w = fare.nightWindowFromConfig(CONFIG);
    for (let m = 0; m < 1440; m += 1) {
      const night = fare.isNightMinute(m, w.startMin, w.endMin);
      const expected = m >= 21 * 60 + 55 || m < 6 * 60;
      expect(night).toBe(expected);
    }
  });

  it('follows the CITY timezone, not the server', () => {
    // 18:00 UTC is 23:30 IST — night in Bengaluru, evening in London.
    const at = new Date('2026-09-10T18:00:00Z');
    expect(quote({ pickupAt: at, timeZone: 'Asia/Kolkata' }).meta.isNight).toBe(true);
    expect(quote({ pickupAt: at, timeZone: 'Europe/London' }).meta.isNight).toBe(false);
  });

  it('charges when the RETURN leg lands at night, even if pickup does not', () => {
    const q = quote({
      tripType: 'ROUND_TRIP',
      pickupAt: ist('09:00'),
      returnAt: ist('23:30'),
      distanceKm: 300,
    });
    expect(q.meta.isNight).toBe(true);
  });

  it('adds the flat allowance and the percentage together', () => {
    const q = quote({ pickupAt: ist('23:00') });
    // The percentage is a share of the DISTANCE charge alone: the base fare was
    // retired, so there is no longer a flat component for it to uplift.
    // distance (20 x 14 = 280); 10% = 28; plus flat 300.
    expect(q.night).toBe('328.00');
  });

  it('never uplifts a base fare, because there is no longer one to uplift', () => {
    // Guards the retirement itself. A rate card row that still carries a
    // base_fare (one seeded before the migration, say) must not put it back
    // into the fare — the engine hardcodes a zero base and ignores the column.
    const withStaleBase = quote({ pickupAt: ist('23:00') }, { ...CONFIG, baseFare: 9999 });
    expect(withStaleBase.base).toBe('0.00');
    expect(withStaleBase.night).toBe('328.00');
    expect(withStaleBase.breakdown.some((l) => l.label === 'Base fare')).toBe(false);
  });
});

describe('driver allowance (bata)', () => {
  it('applies to a one-way trip, one day', () => {
    expect(quote({ tripType: 'ONE_WAY' }).bata).toBe('400.00');
  });

  it('applies once per CALENDAR day on a round trip', () => {
    const q = quote({
      tripType: 'ROUND_TRIP',
      distanceKm: 600,
      pickupAt: ist('22:00', '2026-09-10'),
      returnAt: ist('08:00', '2026-09-11'),
    });
    // Ten hours, but two calendar days — the driver is away overnight.
    expect(q.meta.days).toBe(2);
    expect(q.bata).toBe('800.00');
  });

  it('applies to an hourly rental, for one day', () => {
    const q = fare.computeFare(
      { tripType: 'HOURLY', rentalHours: 4, distanceKm: 30, pickupAt: ist('10:00') },
      { ...CONFIG, hourlyRate: 250, hourlyKmPerHour: 10 }
    );
    expect(q.bata).toBe('400.00');
  });

  it('stays at zero when the rate card sets no allowance', () => {
    expect(quote({}, { ...CONFIG, driverAllowance: 0 }).bata).toBe('0.00');
  });
});

describe('AIRPORT is exempt from both allowances', () => {
  const airportAtNight = () =>
    quote({ tripType: 'AIRPORT', pickupAt: ist('23:30') });

  it('charges no night allowance', () => {
    expect(airportAtNight().night).toBe('0.00');
  });

  it('charges no driver allowance', () => {
    expect(airportAtNight().bata).toBe('0.00');
  });

  it('still charges the airport surcharge', () => {
    expect(airportAtNight().airport).toBe('150.00');
  });

  it('still RECORDS that the trip ran at night, so reporting can see it', () => {
    const q = airportAtNight();
    expect(q.meta.touchesNightWindow).toBe(true); // the clock says night
    expect(q.meta.isNight).toBe(false);           // but no money was charged
    expect(q.meta.allowancesExempt).toBe(true);
  });

  it('stays exempt even if someone leaves the allowances set on the airport rate row', () => {
    // The whole point of enforcing the rule in code: a mis-seeded rate card
    // must not be able to reintroduce the charge.
    const sloppy = { ...CONFIG, driverAllowance: 999, nightAllowance: 999, nightChargePct: 50 };
    const q = quote({ tripType: 'AIRPORT', pickupAt: ist('23:30') }, sloppy);
    expect(q.bata).toBe('0.00');
    expect(q.night).toBe('0.00');
  });

  it('does not exempt the other trip types', () => {
    for (const tripType of ['ONE_WAY', 'ROUND_TRIP', 'HOURLY']) {
      expect(fare.isAllowanceExempt(tripType)).toBe(false);
    }
    expect(fare.isAllowanceExempt('AIRPORT')).toBe(true);
  });
});

describe('the breakdown still sums to the total', () => {
  const cases = [
    ['one-way at night', { pickupAt: ist('23:30') }],
    ['one-way by day', { pickupAt: ist('12:00') }],
    ['airport at night', { tripType: 'AIRPORT', pickupAt: ist('23:30') }],
    [
      'round trip overnight',
      {
        tripType: 'ROUND_TRIP',
        distanceKm: 600,
        pickupAt: ist('22:30', '2026-09-10'),
        returnAt: ist('18:00', '2026-09-11'),
      },
    ],
  ];

  for (const [name, input] of cases) {
    it(name, () => {
      const q = quote(input);
      const sum = q.breakdown.reduce((acc, line) => M.add(acc, M.dec(line.amount)), M.dec(0));
      expect(sum.toFixed(2)).toBe(q.total);
    });
  }
});

describe('invoice lines', () => {
  const bookingFor = (q, meta = {}) => ({
    id: 1,
    bookingNumber: 'ABH-2026-000123',
    fareBasis: { components: q },
    meta,
  });

  const sumOf = (lines) =>
    lines.reduce((acc, l) => M.add(acc, M.dec(l.amount)), M.dec(0));

  it('shows the night allowance with the window that was actually applied', () => {
    const q = quote({ pickupAt: ist('23:30') });
    const lines = billing.buildInvoiceLines(bookingFor(q), M.dec(q.total), M.dec(q.total));
    const night = lines.find((l) => l.description.startsWith('Night allowance'));

    expect(night).toBeDefined();
    expect(night.description).toContain('21:55');
    expect(night.description).toContain('06:00');
    expect(night.amount).toBe('328.00');
  });

  it('shows the driver allowance with the per-day rate and day count', () => {
    const q = quote({
      tripType: 'ROUND_TRIP',
      distanceKm: 600,
      pickupAt: ist('22:30', '2026-09-10'),
      returnAt: ist('18:00', '2026-09-11'),
    });
    const lines = billing.buildInvoiceLines(bookingFor(q), M.dec(q.total), M.dec(q.total));
    const bata = lines.find((l) => l.description.startsWith('Driver allowance'));

    expect(bata).toBeDefined();
    expect(bata.description).toContain('2 days');
    expect(bata.amount).toBe('800.00');
  });

  it('shows NO allowance lines on an airport invoice', () => {
    const q = quote({ tripType: 'AIRPORT', pickupAt: ist('23:30') });
    const lines = billing.buildInvoiceLines(bookingFor(q), M.dec(q.total), M.dec(q.total));

    expect(lines.some((l) => /Night allowance/.test(l.description))).toBe(false);
    expect(lines.some((l) => /Driver allowance/.test(l.description))).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('foots exactly on a retail (tax-free) invoice', () => {
    const q = quote({ pickupAt: ist('23:30') });
    const taxable = M.dec(q.total);
    const lines = billing.buildInvoiceLines(bookingFor(q), taxable, taxable);
    expect(sumOf(lines).equals(taxable)).toBe(true);
  });

  it('foots exactly on a corporate invoice, with lines scaled to taxable value', () => {
    const q = quote({ pickupAt: ist('23:30') });
    const gross = M.dec(q.total);
    const gst = billing.splitGstInclusive(gross, 5, true);
    const lines = billing.buildInvoiceLines(bookingFor(q), gst.taxable, gross);

    expect(sumOf(lines).equals(gst.taxable)).toBe(true);

    // Every broken-out line must be a TAXABLE value, i.e. below its gross.
    const night = lines.find((l) => l.description.startsWith('Night allowance'));
    expect(M.dec(night.amount).lessThan(M.dec(q.night))).toBe(true);
  });

  it('still breaks out extra distance alongside the allowances', () => {
    const q = quote({ pickupAt: ist('23:30') });
    const booking = bookingFor(q, {
      extraDistance: { extraKm: '8.0', perKm: '14.00', extraCharge: '112.00' },
    });
    const taxable = M.dec(q.total);
    const lines = billing.buildInvoiceLines(booking, taxable, taxable);

    expect(lines.map((l) => l.description.split(' (')[0])).toEqual([
      'Cab service — booking ABH-2026-000123',
      'Night allowance',
      'Driver allowance / Bata',
      'Extra distance',
    ]);
    expect(sumOf(lines).equals(taxable)).toBe(true);
  });

  it('does not break on a legacy booking with no fareBasis', () => {
    const lines = billing.buildInvoiceLines(
      { id: 9, bookingNumber: 'ABH-2025-000001', fareBasis: null, meta: {} },
      M.dec('500.00'),
      M.dec('500.00')
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe('500.00');
  });
});