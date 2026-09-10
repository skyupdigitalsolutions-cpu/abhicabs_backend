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
  minimumFare: 200,
  driverAllowance: 400,   // bata per day
  nightAllowance: 300,    // flat
  nightChargePct: 10,     // plus 10% of base + distance
  nightStartHour: 21,
  nightStartMinute: 55,
  nightEndHour: 6,
  nightEndMinute: 0,
  minKmPerDay: 250,
  airportSurcharge: 150,
  maxSurge: 2,
  minSurge: 0.5,
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
    // base 100 + distance (20 x 14 = 280) = 380; 10% = 38; plus flat 300.
    expect(q.night).toBe('338.00');
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
    expect(night.amount).toBe('338.00');
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