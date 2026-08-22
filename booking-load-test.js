#!/usr/bin/env node
'use strict';

/**
 * booking-load-test.js — Day 14 load test for the booking + allocation path.
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000';
const CONCURRENCY = Number(process.env.CONCURRENCY || 25);
const TOTAL = Number(process.env.TOTAL || 500);

const TOKEN = process.env.TOKEN || ''; // admin access token
if (!TOKEN) {
  console.error('Set an admin access token: TOKEN=eyJ... node booking-load-test.js');
  process.exit(1);
}

const BODY = {
  cityId: 1,
  vehicleClass: 'sedan',
  tripType: 'ONE_WAY',
  pickup: { lat: 12.9716, lng: 77.5946 },
  drop: { lat: 12.9352, lng: 77.6245 },
  pickupAt: '2026-09-20T09:00:00.000Z',
  paymentMode: 'FULL',
};

const latencies = [];
const status = {};
let done = 0;

async function createBooking(i) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/v1/admin/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        // Unique key per request so idempotency does not collapse them all.
        'Idempotency-Key': `load-${process.pid}-${i}`,
      },
      body: JSON.stringify(BODY),
    });
    const ms = Date.now() - t0;
    latencies.push(ms);
    status[res.status] = (status[res.status] || 0) + 1;
    // Drain body so the socket frees up.
    await res.text();
  } catch (err) {
    status.ERR = (status.ERR || 0) + 1;
  } finally {
    done += 1;
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function worker(queue) {
  while (queue.length) {
    const i = queue.pop();
    // eslint-disable-next-line no-await-in-loop
    await createBooking(i);
  }
}

async function main() {
  console.log(`Load test: ${TOTAL} bookings, ${CONCURRENCY} concurrent -> ${BASE}`);
  const queue = Array.from({ length: TOTAL }, (_, i) => i);
  const start = Date.now();

  const progress = setInterval(() => {
    process.stdout.write(`\r${done}/${TOTAL} done  statuses ${JSON.stringify(status)}`);
  }, 250);

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  clearInterval(progress);
  const elapsed = (Date.now() - start) / 1000;
  const sorted = latencies.slice().sort((a, b) => a - b);

  console.log(`\n\n--- results ---`);
  console.log(`elapsed:      ${elapsed.toFixed(1)}s`);
  console.log(`throughput:   ${(done / elapsed).toFixed(1)} req/s`);
  console.log(`statuses:     ${JSON.stringify(status)}`);
  console.log(`p50 latency:  ${pct(sorted, 50)}ms`);
  console.log(`p95 latency:  ${pct(sorted, 95)}ms`);
  console.log(`p99 latency:  ${pct(sorted, 99)}ms`);
  console.log(`max latency:  ${sorted[sorted.length - 1] || 0}ms`);
  console.log('');
  const errors = (status['500'] || 0) + (status['502'] || 0) + (status['503'] || 0) + (status.ERR || 0);
  const hardErrors = (status['500'] || 0) + (status['502'] || 0) + (status.ERR || 0);
  console.log(hardErrors === 0
    ? 'PASS — no hard 5xx/connection errors. 409s (conflicts) and 429/503 (protection) are expected under load.'
    : `ATTENTION — ${hardErrors} hard errors; investigate.`);
}

main();