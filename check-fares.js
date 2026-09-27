/**
 * check-fares.js
 *
 * Confirms the three 20260929 migrations actually landed in whichever database
 * DATABASE_URL points at.
 *
 * A file rather than a `node -e` one-liner because PowerShell expands `$` in a
 * double-quoted string, so `p.$queryRaw` arrives at Node as `p.queryRaw` and
 * the whole thing fails to parse.
 *
 * $queryRaw is used throughout so this works even when schema.prisma and the
 * database disagree — the same reason Prisma Studio could not read the users
 * table while migrations were blocked.
 *
 *   node check-fares.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const url = process.env.DATABASE_URL || '';
  const host = url.replace(/\/\/[^@]*@/, '//****@');
  console.log(`\nDatabase: ${host}\n`);

  const fares = await prisma.$queryRaw`
    SELECT DISTINCT trip_type, base_fare, min_surge, max_surge, return_empty_pct
    FROM fare_configs
    ORDER BY trip_type
  `;
  console.log('fare_configs');
  console.table(
    fares.map((r) => ({
      trip_type: r.trip_type,
      base_fare: String(r.base_fare),
      min_surge: String(r.min_surge),
      max_surge: String(r.max_surge),
      return_empty_pct: String(r.return_empty_pct),
    })),
  );

  const cities = await prisma.$queryRaw`
    SELECT name, state, radius_km, local_radius_km FROM cities ORDER BY name
  `;
  console.log('\ncities');
  console.table(cities);

  /* ---- the checks, stated as pass/fail rather than left to the eye ---- */

  const problems = [];

  if (fares.some((r) => Number(r.base_fare) !== 0)) {
    problems.push('base_fare is not 0 on every rate card');
  }
  if (fares.some((r) => Number(r.min_surge) !== 1 || Number(r.max_surge) !== 1)) {
    problems.push('surge band is not pinned to 1.00 on every rate card');
  }

  // Only ONE_WAY carries a return leg. ROUND_TRIP already counts both
  // directions in its distance, and a 100% return on an AIRPORT drop would
  // double a short transfer.
  const oneWay = fares.filter((r) => r.trip_type === 'ONE_WAY');
  if (oneWay.length === 0) {
    problems.push('no ONE_WAY rate cards found at all');
  } else if (oneWay.some((r) => Number(r.return_empty_pct) !== 100)) {
    problems.push('return_empty_pct is not 100 on every ONE_WAY rate card');
  }

  // The city-limits radius must be TIGHT and must never be the service radius,
  // which is the bug this column was added to fix.
  for (const c of cities) {
    const local = Number(c.local_radius_km);
    if (!Number.isFinite(local) || local <= 0) {
      problems.push(`${c.name}: local_radius_km is not set`);
    } else if (local >= Number(c.radius_km)) {
      problems.push(
        `${c.name}: local_radius_km (${local}) is not tighter than radius_km (${c.radius_km}) — ` +
          'satellite towns will still read as "same city"',
      );
    }
  }

  if (problems.length === 0) {
    console.log('\nAll three migrations are in effect.\n');
  } else {
    console.log('\nProblems:');
    for (const p of problems) console.log(`  - ${p}`);
    console.log('');
  }
}

main()
  .catch((e) => {
    console.error('\nFailed:', e.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());