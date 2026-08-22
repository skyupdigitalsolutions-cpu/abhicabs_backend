#!/usr/bin/env node
'use strict';

/**
 * concurrency-bookings.js — parallel bookings, one idempotency key.
 *
 * RACE: N identical booking-create requests are fired SIMULTANEOUSLY with the
 * SAME Idempotency-Key. Without protection, several could each insert a booking.
 * The guarantee: the idempotency layer (INSERT-first on the key) lets exactly
 * ONE win; the rest return that same booking. So N concurrent creates → ONE
 * booking, not N.
 *
 * PASS: exactly one distinct bookingId across all responses.
 *
 * USAGE:
 *   1. Login as a customer, paste the token below (or set TOKEN env).
 *   2. node concurrency-bookings.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000/api/v1';
const TOKEN = process.env.TOKEN || ''; // customer access token
const N = Number(process.env.N || 12);

if (!TOKEN) { console.error('Set a customer token: TOKEN=eyJ... node concurrency-bookings.js'); process.exit(1); }

const KEY = `conc-book-${Date.now()}`; // ONE key shared by all N requests
const BODY = {
  cityId: 1, vehicleClass: 'sedan', tripType: 'ONE_WAY',
  pickup: { lat: 12.9716, lng: 77.5946 }, drop: { lat: 12.9352, lng: 77.6245 },
  pickupAt: '2026-09-20T09:00:00.000Z', paymentMode: 'FULL',
};

async function fire(i) {
  try {
    const res = await fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'Idempotency-Key': KEY },
      body: JSON.stringify(BODY),
    });
    const j = await res.json().catch(() => ({}));
    const id = j?.data?.booking?.id || j?.data?.id || null;
    return { i, status: res.status, id, code: j?.error?.code };
  } catch (e) { return { i, status: 'ERR', id: null }; }
}

(async () => {
  console.log(`Firing ${N} concurrent bookings with ONE key: ${KEY}\n`);
  const results = await Promise.all(Array.from({ length: N }, (_, i) => fire(i)));

  const ids = new Set(results.map((r) => r.id).filter(Boolean));
  const statuses = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});

  console.log('statuses:', JSON.stringify(statuses));
  console.log('distinct bookingIds:', ids.size, ids.size ? `(${[...ids][0]})` : '');
  console.log('');

  const pass = ids.size === 1;
  console.log(pass
    ? `*** PASS: ${N} concurrent creates produced exactly ONE booking ***`
    : `*** FAIL: ${ids.size} distinct bookings created (expected 1) ***`);
  process.exit(pass ? 0 : 1);
})();