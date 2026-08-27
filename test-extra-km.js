/**
 * test-extra-km.js  —  End-to-end test for the driver extra-distance feature.
 *
 * Run from the backend root while `npm run dev` is running in another terminal:
 *
 *     node test-extra-km.js
 *
 * It drives a real booking through its lifecycle against your live server and
 * verifies:
 *   1. a booking is created and quoted at some distance,
 *   2. the assigned DRIVER can report a longer actual distance,
 *   3. the extra km are charged at the frozen per-km rate,
 *   4. the final fare rises by exactly that surcharge,
 *   5. the invoice shows a separate "Extra distance" line and foots to the total,
 *   6. a NON-assigned driver is refused (403).
 *
 * Requires the DB to be seeded (admin@example.com, driver1@example.com, etc.)
 * and reads driver/vehicle IDs straight from Postgres via Prisma so it does not
 * depend on hard-coded UUIDs.
 */

'use strict';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5000/api/v1';

// ---- tiny fetch helper -----------------------------------------------------
async function api(method, path, { token, body, idem } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

function ok(label, cond, extra = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

function money(n) { return Number(n).toFixed(2); }

async function login(email, password, tries = 0) {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  if (r.status === 429) {
    // Auth limiter tripped (10/15min per IP). Back off briefly a couple of times;
    // if it persists, tell the user how to clear it rather than hammering it.
    if (tries < 2) {
      const waitMs = 3000 * (tries + 1);
      console.log(`  … login rate-limited for ${email}, retrying in ${waitMs / 1000}s`);
      await new Promise((res) => setTimeout(res, waitMs));
      return login(email, password, tries + 1);
    }
    throw new Error(
      `Auth rate limit hit for ${email}. Wait 15 min, OR flush the cache Redis ` +
      `(e.g. docker exec -it <redis> redis-cli FLUSHDB), then re-run. ` +
      `This is the login limiter, not a feature failure.`
    );
  }
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.accessToken;
}

(async () => {
  console.log('\n=== Extra-distance feature — end-to-end test ===\n');

  // Pull driver + vehicle identities straight from the DB so the test is seed-agnostic.
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const driver1 = await prisma.user.findFirst({ where: { email: 'driver1@example.com' }, select: { id: true } });
  const driver2 = await prisma.user.findFirst({ where: { email: 'driver2@example.com' }, select: { id: true } });

  // Pick a vehicle with NO active allocation, so a stale hold from an earlier
  // run does not cause a 409 on allocate.
  const busy = (await prisma.allocation.findMany({ where: { status: 'ACTIVE' }, select: { vehicleId: true } }))
    .map((a) => a.vehicleId);
  const notBusy = busy.length ? { id: { notIn: busy } } : {};
  const vehicle =
    (await prisma.vehicle.findFirst({ where: { vehicleClass: 'sedan', ...notBusy }, select: { id: true, vehicleClass: true } })) ||
    (await prisma.vehicle.findFirst({ where: notBusy, select: { id: true, vehicleClass: true } })) ||
    (await prisma.vehicle.findFirst({ select: { id: true, vehicleClass: true } }));

  const city = await prisma.city.findFirst({ select: { id: true, centreLat: true, centreLng: true } });

  if (!driver1 || !vehicle || !city) {
    console.error('Missing seed data (driver1 / vehicle / city). Run your seed first.');
    process.exit(1);
  }
  console.log(`Using vehicle ${vehicle.id} (${vehicle.vehicleClass}), city ${city.id}, driver1 ${driver1.id}\n`);

  // --- tokens ---------------------------------------------------------------
  const adminToken = await login('admin@example.com', process.env.SEED_ADMIN_PASSWORD || 'Admin@12345');
  const custToken = await login('user@example.com', 'User@12345');
  const driver1Token = await login('driver1@example.com', 'Driver@12345');
  const driver2Token = driver2 ? await login('driver2@example.com', 'Driver@12345') : null;

  // --- 1. customer creates a booking ---------------------------------------
  const pickupAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min out
  const create = await api('POST', '/bookings', {
    token: custToken,
    idem: `test-extra-${Date.now()}`,
    body: {
      cityId: city.id,
      vehicleClass: vehicle.vehicleClass,
      tripType: 'ONE_WAY',
      pickup: { lat: Number(city.centreLat) || 12.9716, lng: Number(city.centreLng) || 77.5946 },
      drop: { lat: (Number(city.centreLat) || 12.9716) + 0.12, lng: (Number(city.centreLng) || 77.5946) + 0.12 },
      pickupAt,
      paymentMode: 'ZERO',
      scheduled: true,
    },
  });
  ok('booking created', create.status === 201 || create.status === 200, `status ${create.status}`);
  const booking = create.body?.data?.booking;
  if (!booking) { console.error('No booking returned:', JSON.stringify(create.body, null, 2)); process.exit(1); }

  const id = booking.id;
  // The quote is frozen under fareBasis.components (booking.service.js), so the
  // rate card lives at fareBasis.components.configSnapshot.
  const comp = booking.fareBasis?.components || booking.fareBasis || {};
  const quotedKm = Number(comp.meta?.actualKm ?? booking.distanceKm ?? 0);
  const estimatedFare = Number(booking.estimatedFare);
  const perKm = Number(comp.configSnapshot?.perKm ?? 0);
  console.log(`  booking ${booking.bookingNumber}: quotedKm=${quotedKm}, estimate=₹${money(estimatedFare)}, perKm=₹${money(perKm)}\n`);

  // --- 2. admin drives it forward to ONGOING -------------------------------
  await api('PATCH', `/admin/bookings/${id}/confirm`, { token: adminToken, body: {} });
  const alloc = await api('PATCH', `/admin/bookings/${id}/allocate`, {
    token: adminToken,
    body: { vehicleId: vehicle.id, driverId: driver1.id },
  });
  ok('vehicle + driver allocated', alloc.status === 201 || alloc.status === 200, `status ${alloc.status}`);
  await api('PATCH', `/admin/bookings/${id}/en-route`, { token: adminToken, body: {} });
  const started = await api('PATCH', `/admin/bookings/${id}/start`, { token: adminToken, body: {} });
  ok('trip started (ONGOING)', started.status === 200, `status ${started.status}`);

  // --- 3. WRONG driver is refused ------------------------------------------
  if (driver2Token) {
    const wrong = await api('PATCH', `/bookings/${id}/trip-distance`, {
      token: driver2Token,
      body: { actualKm: quotedKm + 5 },
    });
    ok('non-assigned driver refused (403)', wrong.status === 403, `status ${wrong.status}, code ${wrong.body?.error?.code}`);
  }

  // --- 4. assigned driver reports a LONGER distance -------------------------
  const extraKm = 8;
  const actualKm = quotedKm + extraKm;
  const rec = await api('PATCH', `/bookings/${id}/trip-distance`, {
    token: driver1Token,
    body: { actualKm, odometerKm: 45120 },
  });
  ok('assigned driver records distance', rec.status === 200, `status ${rec.status}`);
  const extra = rec.body?.data?.extra;
  const expectedExtraCharge = extraKm * perKm;
  ok('extra km computed correctly', extra && Number(extra.extraKm) === extraKm, `got ${extra?.extraKm}`);
  ok('extra charge = extraKm × perKm',
     extra && money(extra.extraCharge) === money(expectedExtraCharge),
     `got ₹${money(extra?.extraCharge)}, expected ₹${money(expectedExtraCharge)}`);

  // --- 5. final fare rose by the surcharge ---------------------------------
  const afterRecord = await api('GET', `/bookings/${id}`, { token: custToken });
  const finalFare = Number(afterRecord.body?.data?.booking?.finalFare);
  ok('final fare = estimate + extra',
     money(finalFare) === money(estimatedFare + expectedExtraCharge),
     `final ₹${money(finalFare)}, expected ₹${money(estimatedFare + expectedExtraCharge)}`);

  // --- 6. re-report is idempotent (does not compound) ----------------------
  await api('PATCH', `/bookings/${id}/trip-distance`, { token: driver1Token, body: { actualKm } });
  const afterRepeat = await api('GET', `/bookings/${id}`, { token: custToken });
  ok('re-reporting is idempotent (no compounding)',
     money(Number(afterRepeat.body?.data?.booking?.finalFare)) === money(estimatedFare + expectedExtraCharge),
     `final still ₹${money(estimatedFare + expectedExtraCharge)}`);

  // --- 7. complete + invoice shows the extra line --------------------------
  const done = await api('PATCH', `/admin/bookings/${id}/complete`, { token: adminToken, body: {} });
  ok('trip completed', done.status === 200, `status ${done.status}`);

  const inv = await api('GET', `/bookings/${id}/invoice`, { token: custToken });
  ok('invoice fetched', inv.status === 200, `status ${inv.status}`);
  const invoice = inv.body?.data?.invoice || inv.body?.data;
  const lines = invoice?.lines || [];
  const extraLine = lines.find((l) => /extra distance/i.test(l.description || ''));

  // Only expect an extra-distance line when the surcharge is actually > 0. If the
  // route's per-km rate is 0 (some flat-fare configs), there is legitimately no
  // extra line — report that rather than failing.
  if (expectedExtraCharge > 0) {
    ok('invoice HAS an "Extra distance" line', !!extraLine,
       extraLine ? `"${extraLine.description}" = ₹${money(extraLine.amount)}` : 'not found');
    if (extraLine) {
      ok('extra line amount = surcharge', money(extraLine.amount) === money(expectedExtraCharge),
         `₹${money(extraLine.amount)}`);
    }
  } else {
    console.log(`  [SKIP] extra-distance line — perKm is 0 for this route, so no surcharge applies`);
  }

  // Lines are PRE-TAX (taxable value). For a NON_TAX (retail) invoice the total
  // equals the taxable value; for a TAX (corporate) invoice the total adds GST,
  // so lines foot to taxableValue, NOT totalAmount.
  const lineSum = lines.reduce((s, l) => s + Number(l.amount), 0);
  const taxable = Number(invoice?.taxableValue ?? invoice?.subtotal ?? invoice?.totalAmount ?? 0);
  ok('invoice lines foot to the taxable value',
     money(lineSum) === money(taxable),
     `lines Σ ₹${money(lineSum)} vs taxable ₹${money(taxable)} (total incl. GST ₹${money(invoice?.totalAmount)})`);

  console.log('\n--- invoice ---');
  console.log(`   type: ${invoice?.type}`);
  for (const l of lines) console.log(`   ${l.description}  ×${l.quantity}  = ₹${money(l.amount)}`);
  console.log(`   taxable = ₹${money(taxable)}   |   total (incl GST) = ₹${money(invoice?.totalAmount)}\n`);

  // Cleanup: release THIS test's allocation so the vehicle is free next run.
  try {
    await prisma.allocation.updateMany({
      where: { bookingId: id, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  } catch (e) { /* best effort */ }

  await prisma.$disconnect();
  console.log(process.exitCode ? '=== SOME CHECKS FAILED ===\n' : '=== ALL CHECKS PASSED ===\n');
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); }); 