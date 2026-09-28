/**
 * check-fleet.js
 *
 * Verifies 20260930100000_real_fleet_only_rentals_airport.
 *
 * Four questions, each matching one thing the migration claimed to do:
 *   1. Are the legacy classes gone from what riders can see?
 *   2. Does every active vehicle have all three real packages?
 *   3. Is the 12 hrs / 80 km product gone?
 *   4. Does every active vehicle have every trip type priced?
 *
 *   node check-fleet.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const LEGACY = ['hatchback', 'sedan', 'suv', 'tempo'];
const LABELS = ['4 hrs / 40 km', '8 hrs / 80 km', '12 hrs / 120 km'];
const TRIPS = ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'];

async function main() {
  const problems = [];

  /* 1. active catalogue */
  const active = await prisma.$queryRaw`
    SELECT key FROM vehicle_catalog WHERE is_active = true ORDER BY key
  `;
  const keys = active.map((v) => v.key);

  console.log(`\nActive vehicles (${keys.length})\n  ${keys.join(', ')}\n`);

  const stragglers = keys.filter((k) => LEGACY.includes(k));
  if (stragglers.length) problems.push(`legacy class still active: ${stragglers.join(', ')}`);

  /* 2. packages per vehicle */
  const pkgs = await prisma.$queryRaw`
    SELECT vehicle_class, label, package_fare::text AS fare
    FROM rental_packages WHERE is_active = true
    ORDER BY vehicle_class, included_hours
  `;

  console.log('Rental packages\n');
  console.log('  vehicle'.padEnd(22) + LABELS.map((l) => l.padStart(16)).join(''));
  for (const k of keys) {
    const mine = pkgs.filter((p) => p.vehicle_class === k);
    const cells = LABELS.map((l) => {
      const hit = mine.find((p) => p.label === l);
      return (hit ? `Rs ${Number(hit.fare).toLocaleString('en-IN')}` : '—').padStart(16);
    });
    console.log('  ' + k.padEnd(20) + cells.join(''));
    const missing = LABELS.filter((l) => !mine.some((p) => p.label === l));
    if (missing.length) problems.push(`${k}: missing package ${missing.join(', ')}`);
  }

  /* 3. the retired product */
  const [stale] = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM rental_packages WHERE label = '12 hrs / 80 km'
  `;
  if (stale.n > 0) problems.push(`${stale.n} '12 hrs / 80 km' packages still present`);

  // A package belonging to a retired class would still be offered by label.
  const orphan = pkgs.filter((p) => !keys.includes(p.vehicle_class));
  if (orphan.length) {
    problems.push(
      `packages exist for inactive classes: ${[...new Set(orphan.map((p) => p.vehicle_class))].join(', ')}`,
    );
  }

  /* 4. fare cards per trip type */
  const cfgs = await prisma.$queryRaw`
    SELECT DISTINCT vehicle_class, trip_type FROM fare_configs WHERE is_active = true
  `;

  console.log('\nFare cards\n');
  console.log('  vehicle'.padEnd(22) + TRIPS.map((t) => t.padStart(12)).join(''));
  for (const k of keys) {
    const have = cfgs.filter((c) => c.vehicle_class === k).map((c) => c.trip_type);
    console.log('  ' + k.padEnd(20) + TRIPS.map((t) => (have.includes(t) ? 'yes' : '—').padStart(12)).join(''));
    const missing = TRIPS.filter((t) => !have.includes(t));
    if (missing.length) problems.push(`${k}: no ${missing.join(', ')} rate card`);
  }

  console.log('');
  if (problems.length === 0) {
    console.log('All four checks pass. Every active vehicle is bookable on every trip type.\n');
  } else {
    console.log('Problems:');
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