#!/usr/bin/env node
'use strict';

/**
 * concurrency-webhooks.js — duplicate webhook replay.
 *
 * RACE: the SAME payment webhook event (same eventId) is delivered N times
 * concurrently — exactly what a gateway does when it retries and the network is
 * flaky. The Day 7 webhook pipeline inserts the event first (unique on eventId)
 * and only the first insert applies the state change; the rest are deduped. So
 * a payment is CAPTURED once, no matter how many times the event arrives.
 *
 * PASS: exactly one delivery reports "changed" (applied); the rest are duplicates.
 *
 * USAGE (mock provider / dev only — uses the simulate-webhook helper):
 *   1. Login as admin, set TOKEN.
 *   2. Create a booking + payment order; put the payment id in PAYMENT (or the
 *      script will create one for BOOKING if you set that instead).
 *   3. node concurrency-webhooks.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000/api/v1';
const TOKEN = process.env.TOKEN || '';       // admin token
let PAYMENT = process.env.PAYMENT || '';      // payment id with a gateway order
const BOOKING = process.env.BOOKING || '';    // optional: create a payment for this booking
const N = Number(process.env.N || 6);

if (!TOKEN) { console.error('Set an admin token: TOKEN=eyJ... node concurrency-webhooks.js'); process.exit(1); }

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const EVENT_ID = `evt-replay-${Date.now()}`; // ONE event id, replayed N times

async function ensurePayment() {
  if (PAYMENT) return PAYMENT;
  if (!BOOKING) throw new Error('Set PAYMENT=<paymentId> or BOOKING=<bookingId> so a payment can be created.');
  const res = await fetch(`${BASE}/payments/orders`, { method: 'POST', headers: H, body: JSON.stringify({ bookingId: BOOKING, purpose: 'FULL' }) });
  const j = await res.json();
  const id = j?.data?.payment?.id || j?.data?.id;
  if (!id) throw new Error(`could not create payment: ${JSON.stringify(j)}`);
  console.log(`created payment ${id} for booking ${BOOKING}`);
  return id;
}

async function deliver() {
  try {
    const res = await fetch(`${BASE}/payments/${PAYMENT}/simulate-webhook`, {
      method: 'POST', headers: H, body: JSON.stringify({ eventId: EVENT_ID, status: 'captured' }),
    });
    const j = await res.json().catch(() => ({}));
    // controller returns message: 'Event applied' | 'Duplicate event ignored' | ...
    const applied = /applied/i.test(j?.message || '');
    const dup = /duplicate/i.test(j?.message || '');
    return { status: res.status, applied, dup, message: j?.message };
  } catch (e) { return { status: 'ERR', applied: false, dup: false, message: e.message }; }
}

(async () => {
  PAYMENT = await ensurePayment();
  console.log(`Delivering event ${EVENT_ID} x${N} concurrently to payment ${PAYMENT}...\n`);

  const results = await Promise.all(Array.from({ length: N }, deliver));
  const applied = results.filter((r) => r.applied).length;
  const dups = results.filter((r) => r.dup).length;
  const msgs = results.reduce((m, r) => ((m[r.message] = (m[r.message] || 0) + 1), m), {});

  console.log('applied (changed):', applied);
  console.log('duplicates:       ', dups);
  console.log('messages:', JSON.stringify(msgs));
  console.log('');

  const pass = applied === 1;
  console.log(pass
    ? `*** PASS: ${N} concurrent deliveries -> applied exactly ONCE, ${N - 1} deduped ***`
    : `*** FAIL: applied ${applied} times (expected 1) ***`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });