#!/usr/bin/env node
'use strict';

/**
 * ping-storm.js — Day 11 done-line load test.
 *
 * Simulates N drivers each pinging every INTERVAL_MS. The whole point is to
 * watch your Postgres write count while this runs: it must stay FLAT, because
 * every ping goes to Redis GEO, not Postgres.
 *
 * ---------------------------------------------------------------------------
 * SETUP
 * ---------------------------------------------------------------------------
 * This needs driver tokens. The seed creates two drivers; for a real 100-driver
 * test you either seed more drivers or reuse a handful of tokens (the ping path
 * does not care that ids repeat — it is the WRITE COUNT that matters). Simplest:
 * paste one or more driver access tokens into TOKENS below.
 *
 *   1. Login as driver1@example.com / Driver@12345, copy the accessToken.
 *   2. Paste it (and any others) into TOKENS.
 *   3. In a separate psql session, run the query in HOW TO MEASURE below,
 *      note the number.
 *   4. node ping-storm.js
 *   5. Re-run the query. The delta should be ~0 (only online/offline or trip
 *      checkpoints move it — not the pings themselves).
 *
 * HOW TO MEASURE POSTGRES WRITES (run before and after):
 *   SELECT sum(n_tup_ins + n_tup_upd) AS writes
 *   FROM pg_stat_user_tables;
 *   -- or watch a specific table:
 *   SELECT relname, n_tup_ins, n_tup_upd
 *   FROM pg_stat_user_tables
 *   WHERE relname IN ('drivers','trip_events','bookings')
 *   ORDER BY relname;
 *
 * Expect trip_events / bookings / drivers to barely move: the pings do not
 * write there. Redis, meanwhile, will show the GEO set filling up:
 *   redis-cli ZCARD abhi:drivers:geo
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000';
const N_DRIVERS = Number(process.env.DRIVERS || 100);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 4000);
const DURATION_S = Number(process.env.DURATION_S || 30);

// Paste one or more driver access tokens here. If you only have one or two,
// they get reused round-robin across the simulated drivers — fine for proving
// the write count stays flat.
const TOKENS = [
 "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiRFJJVkVSIiwidHlwIjoiYWNjZXNzIiwiaWF0IjoxNzg3MjI5NzEwLCJleHAiOjE3ODcyMzA2MTAsInN1YiI6IjQ4MWY5MWRjLWNmMzItNGRiMS05YTIzLTc4N2MzMmFiNTM0ZiJ9.nSTASKj-ofoAGDM_dQoiQd48hZeLSvO3sUbBwdfV9yU"
];

if (TOKENS.length === 0) {
  console.error('Paste at least one DRIVER access token into TOKENS first.');
  process.exit(1);
}

// A cluster of drivers wandering around Bengaluru MG Road.
const CENTRE = { lat: 12.9716, lng: 77.5946 };

function jitter(base, i, tick) {
  return {
    lat: base.lat + (i % 20) * 0.0008 + tick * 0.0003,
    lng: base.lng + Math.floor(i / 20) * 0.0008 + tick * 0.0002,
  };
}

async function ping(token, i, tick) {
  const { lat, lng } = jitter(CENTRE, i, tick);
  try {
    const res = await fetch(`${BASE}/api/v1/driver/location/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ lat, lng, speed: 28, heading: 90 }),
    });
    return res.status;
  } catch (err) {
    return 'ERR';
  }
}

async function main() {
  const ticks = Math.floor((DURATION_S * 1000) / INTERVAL_MS);
  console.log(`Pinging ${N_DRIVERS} drivers every ${INTERVAL_MS}ms for ${DURATION_S}s (${ticks} rounds).`);
  console.log('Measure Postgres writes before and after — they should stay flat.\n');

  let sent = 0;
  const stats = {};
  for (let t = 0; t < ticks; t++) {
    const round = [];
    for (let i = 0; i < N_DRIVERS; i++) {
      const token = TOKENS[i % TOKENS.length];
      round.push(ping(token, i, t).then((s) => { stats[s] = (stats[s] || 0) + 1; sent++; }));
    }
    await Promise.all(round);
    process.stdout.write(`\rround ${t + 1}/${ticks}  sent ${sent}  statuses ${JSON.stringify(stats)}`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log('\n\nDone. Now re-run the Postgres write query — the delta should be ~0.');
}

main();