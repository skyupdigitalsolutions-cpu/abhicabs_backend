#!/usr/bin/env node
'use strict';

/**
 * concurrency-allocations.js — parallel allocations, one vehicle.
 *
 * RACE: the SAME vehicle is assigned to N different CONFIRMED bookings whose
 * time windows overlap, all fired SIMULTANEOUSLY. The Day 9 GiST exclusion
 * constraint (excl_allocation_vehicle_overlap) lets exactly ONE commit; the rest
 * lose at the database with 23P01, surfaced as 409 VEHICLE_UNAVAILABLE.
 *
 * This is the true-concurrency version of the Day 9 done-line (Postman's runner
 * was sequential). It proves there is no race window: even fired together, only
 * one wins.
 *
 * PASS: exactly one 201, the rest 409 (VEHICLE_UNAVAILABLE / ALREADY_ALLOCATED).
 *
 * USAGE:
 *   1. Login as admin, set TOKEN.
 *   2. Set VEHICLE to a vehicle id of the right class (default: seeded sedan).
 *   3. node concurrency-allocations.js
 *   The script creates + confirms N overlapping bookings, then races the assign.
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000/api/v1';
const TOKEN = process.env.TOKEN || ''; // admin token
const VEHICLE = process.env.VEHICLE || '4ed6f266-f5d6-4c90-baa6-cbb05ce18601'; // seeded sedan
const N = Number(process.env.N || 8);

if (!TOKEN) { console.error('Set an admin token: TOKEN=eyJ... node concurrency-allocations.js'); process.exit(1); }

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
// All bookings share this pickup time so their hold windows overlap.
const PICKUP = '2026-10-05T09:00:00.000Z';
const body = () => ({
  cityId: 1, vehicleClass: 'sedan', tripType: 'ONE_WAY',
  pickup: { lat: 12.9716, lng: 77.5946 }, drop: { lat: 12.9352, lng: 77.6245 },
  pickupAt: PICKUP, paymentMode: 'FULL',
});

async function createConfirmed(i) {
  const c = await fetch(`${BASE}/admin/bookings`, {
    method: 'POST', headers: { ...H, 'Idempotency-Key': `conc-alloc-${Date.now()}-${i}` }, body: JSON.stringify(body()),
  });
  const cj = await c.json();
  const id = cj?.data?.booking?.id || cj?.data?.id;
  if (!id) throw new Error(`create failed: ${JSON.stringify(cj)}`);
  await fetch(`${BASE}/admin/bookings/${id}/confirm`, { method: 'PATCH', headers: H, body: '{}' });
  return id;
}

async function assign(id) {
  try {
    const res = await fetch(`${BASE}/admin/dispatch/bookings/${id}/assign`, {
      method: 'POST', headers: H, body: JSON.stringify({ vehicleId: VEHICLE }),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, code: j?.error?.code || (res.status === 201 ? 'OK' : '?') };
  } catch (e) { return { status: 'ERR', code: e.message }; }
}

(async () => {
  console.log(`Creating ${N} overlapping CONFIRMED bookings (pickup ${PICKUP})...`);
  const ids = [];
  for (let i = 0; i < N; i++) ids.push(await createConfirmed(i)); // eslint-disable-line no-await-in-loop
  console.log(`Racing assign of vehicle ${VEHICLE} to all ${N} at once...\n`);

  const results = await Promise.all(ids.map(assign));
  const wins = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  const codes = results.reduce((m, r) => ((m[r.code] = (m[r.code] || 0) + 1), m), {});

  console.log('201 (won):    ', wins);
  console.log('409 (rejected):', conflicts);
  console.log('by code:', JSON.stringify(codes));
  console.log('');

  const pass = wins === 1 && conflicts === N - 1;
  console.log(pass
    ? `*** PASS: ${N} concurrent allocations -> 1 winner, ${N - 1} clean rejections ***`
    : `*** FAIL: ${wins} winners (expected 1) ***`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });