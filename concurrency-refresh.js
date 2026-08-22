#!/usr/bin/env node
'use strict';

/**
 * concurrency-refresh.js — refresh-token reuse / rotation.
 *
 * A refresh token is single-use: refreshing rotates it (issues a new one and
 * revokes the old). Replaying a used refresh token must FAIL — that is how a
 * stolen token is caught. The claim is atomic (updateMany where revokedAt is
 * null), so even two SIMULTANEOUS refreshes with the same token cannot both win.
 *
 * Two checks:
 *   A. Sequential: refresh once (ok), replay the SAME token (rejected).
 *   B. Concurrent: fire two refreshes with the same token at once → exactly one
 *      succeeds, the other is rejected. No race window.
 *
 * PASS: A's replay is rejected AND B yields exactly one success.
 *
 * USAGE:
 *   1. Set CREDS or use the seeded customer default below.
 *   2. node concurrency-refresh.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000/api/v1';
const EMAIL = process.env.EMAIL || 'user@example.com';
const PASSWORD = process.env.PASSWORD || 'User@12345';

const H = { 'Content-Type': 'application/json' };

async function login() {
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const j = await res.json();
  const rt = j?.data?.refreshToken || j?.data?.tokens?.refreshToken;
  if (!rt) throw new Error(`login failed / no refreshToken: ${JSON.stringify(j)}`);
  return rt;
}

async function refresh(rt) {
  const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: H, body: JSON.stringify({ refreshToken: rt }) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.status === 200, code: j?.error?.code, newRt: j?.data?.refreshToken || j?.data?.tokens?.refreshToken };
}

(async () => {
  let passA = false;
  let passB = false;

  // ---- A. sequential reuse ----
  console.log('A. Sequential reuse:');
  const rtA = await login();
  const first = await refresh(rtA);
  const replay = await refresh(rtA); // same (now-rotated) token
  console.log(`   first refresh:  ${first.status} ${first.ok ? '(ok)' : first.code}`);
  console.log(`   replay same:    ${replay.status} ${replay.ok ? '(OK - BAD)' : '(rejected: ' + replay.code + ')'}`);
  passA = first.ok && !replay.ok;

  // ---- B. concurrent double-refresh ----
  console.log('\nB. Concurrent double-refresh (same token):');
  const rtB = await login();
  const [r1, r2] = await Promise.all([refresh(rtB), refresh(rtB)]);
  const wins = [r1, r2].filter((r) => r.ok).length;
  console.log(`   results: ${r1.status}/${r1.ok ? 'ok' : r1.code} , ${r2.status}/${r2.ok ? 'ok' : r2.code}`);
  console.log(`   winners: ${wins}`);
  passB = wins === 1;

  console.log('');
  const pass = passA && passB;
  console.log(pass
    ? '*** PASS: reuse rejected (A) and exactly one concurrent winner (B) ***'
    : `*** FAIL: A=${passA ? 'pass' : 'FAIL'} B=${passB ? 'pass' : 'FAIL'} ***`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });