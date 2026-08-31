/**
 * fix-constraint.js — fixes the chk_booking_round_trip_return constraint so
 * AIRPORT and HOURLY bookings are allowed (they were rejected because the old
 * constraint only knew ONE_WAY and ROUND_TRIP).
 *
 * Run from the backend root:   node fix-constraint.js
 *
 * Safe to run multiple times.
 */
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  console.log('Dropping old constraint (if present)…');
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "chk_booking_round_trip_return"`
  );

  console.log('Adding widened constraint (ONE_WAY, AIRPORT, HOURLY → no return; ROUND_TRIP → return)…');
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "bookings"
       ADD CONSTRAINT "chk_booking_round_trip_return"
       CHECK (
         ("trip_type" = 'ROUND_TRIP' AND "return_at" IS NOT NULL AND "return_at" > "pickup_at")
         OR
         ("trip_type" IN ('ONE_WAY', 'AIRPORT', 'HOURLY') AND "return_at" IS NULL)
       )`
  );

  // Verify it now allows AIRPORT by reading the constraint definition back.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'chk_booking_round_trip_return'`
  );
  console.log('\n✓ Constraint is now:');
  console.log('   ' + (rows[0]?.def || '(could not read back)'));
  console.log('\nDone. AIRPORT and HOURLY bookings will now insert. Restart the backend if needed.');

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('\n✗ Failed:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});