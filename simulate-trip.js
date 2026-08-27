/**
 * simulate-trip.js
 *
 * Drives a rider booking through the full lifecycle so you can watch the
 * "Your trip" screen update LIVE on the phone (no new app needed):
 *
 *   PENDING -> CONFIRMED -> ALLOCATED -> EN_ROUTE -> ONGOING -> COMPLETED
 *
 * It logs in as the seeded admin, finds the booking by its number, then calls
 * the same ops/admin endpoints a dispatcher would, pausing between each so you
 * can see the timeline advance. It is resumable: if the booking is already part
 * way through, it picks up from wherever it is.
 *
 * ---------------------------------------------------------------------------
 * RUN IT (from the PC where the backend runs, e.g. D:\TaxiRental):
 *
 *   node simulate-trip.js ABH-2026-001042
 *
 * Options (env vars or leave as defaults):
 *   BASE_URL         default http://localhost:5000
 *   ADMIN_EMAIL      default admin@example.com
 *   ADMIN_PASSWORD   default Admin@12345
 *   DELAY_MS         pause between steps, default 4000 (4s)
 *
 *   e.g.  DELAY_MS=6000 node simulate-trip.js ABH-2026-001042
 *
 * Requires Node 18+ (uses the built-in fetch).
 * ---------------------------------------------------------------------------
 */

'use strict';

const BASE = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const DELAY_MS = Number(process.env.DELAY_MS || 4000);

const bookingNumber = process.argv[2];

if (!bookingNumber) {
  console.error('Usage: node simulate-trip.js <BOOKING_NUMBER>');
  console.error('Example: node simulate-trip.js ABH-2026-001042');
  process.exit(1);
}

if (typeof fetch !== 'function') {
  console.error('This script needs Node 18+ (built-in fetch). Your Node is too old.');
  process.exit(1);
}

const ORDER = ['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE', 'ONGOING', 'COMPLETED'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HTTP call that unwraps the { success, data } envelope or throws a clean error. */
async function call(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Network error calling ${method} ${path} — is the backend running at ${BASE}? (${e.message})`);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

  if (!res.ok || !json || json.success === false) {
    const code = json?.error?.code || res.status;
    const msg = json?.error?.message || text || res.statusText;
    throw new Error(`${method} ${path} failed [${code}]: ${msg}`);
  }
  return json.data;
}

async function login() {
  const data = await call('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!data?.accessToken) throw new Error('Login succeeded but no accessToken returned.');
  console.log(`[auth] logged in as ${ADMIN_EMAIL}`);
  return data.accessToken;
}

async function findBooking(token) {
  const data = await call('GET', `/admin/bookings?search=${encodeURIComponent(bookingNumber)}&limit=20`, { token });
  const items = data?.items || [];
  const match = items.find(
    (b) => (b.bookingNumber || '').toUpperCase() === bookingNumber.toUpperCase()
  );
  if (!match) {
    throw new Error(`No booking found with number ${bookingNumber}. Found: ${items.map((b) => b.bookingNumber).join(', ') || '(none)'}`);
  }
  return match; // { id, bookingNumber, status, ... }
}

// Each step: the status it runs FROM, and how to perform the transition.
const STEPS = {
  PENDING:   { label: 'Confirm (PENDING -> CONFIRMED)',      run: (t, id) => call('PATCH', `/admin/bookings/${id}/confirm`, { token: t, body: {} }) },
  CONFIRMED: { label: 'Auto-assign (CONFIRMED -> ALLOCATED)', run: (t, id) => call('POST',  `/admin/dispatch/bookings/${id}/auto-assign`, { token: t, body: {} }) },
  ALLOCATED: { label: 'Driver en-route (ALLOCATED -> EN_ROUTE)', run: (t, id) => call('PATCH', `/admin/bookings/${id}/en-route`, { token: t, body: {} }) },
  EN_ROUTE:  { label: 'Start trip (EN_ROUTE -> ONGOING)',     run: (t, id) => call('PATCH', `/admin/bookings/${id}/start`, { token: t, body: {} }) },
  ONGOING:   { label: 'Complete trip (ONGOING -> COMPLETED)', run: (t, id) => call('PATCH', `/admin/bookings/${id}/complete`, { token: t, body: {} }) },
};

async function main() {
  console.log(`\nSimulating trip for ${bookingNumber} against ${BASE}\n`);

  const token = await login();
  const booking = await findBooking(token);
  console.log(`[booking] id=${booking.id}  current status=${booking.status}\n`);

  let idx = ORDER.indexOf(booking.status);
  if (idx === -1) throw new Error(`Unknown status: ${booking.status}`);
  if (booking.status === 'COMPLETED') { console.log('Already COMPLETED — nothing to do.'); return; }
  if (booking.status === 'CANCELLED' || booking.status === 'EXPIRED') {
    console.log(`Booking is ${booking.status} (terminal) — cannot advance. Create a fresh booking in the app.`);
    return;
  }

  // Walk forward from the current status to COMPLETED, pausing between steps.
  while (idx < ORDER.indexOf('COMPLETED')) {
    const from = ORDER[idx];
    const step = STEPS[from];
    if (!step) break;

    console.log(`-> ${step.label}`);
    await step.run(token, booking.id);
    idx += 1;
    console.log(`   ok. status is now ${ORDER[idx]}  — check the phone.`);

    if (idx < ORDER.indexOf('COMPLETED')) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone. ${bookingNumber} is COMPLETED. The trip screen should show the full timeline filled in.`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});