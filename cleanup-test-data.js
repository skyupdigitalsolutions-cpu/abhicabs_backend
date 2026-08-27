/**
 * cleanup-test-data.js — release stale ACTIVE allocations left by repeated test
 * runs, so the vehicles are free again. Safe to run anytime in DEV.
 *
 *     node cleanup-test-data.js
 *
 * It only RELEASES allocations (sets status = RELEASED) — it does not delete any
 * bookings, invoices, or ledger rows. Run this if the extra-km test starts
 * failing allocation with 409 (vehicle already held).
 */
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const active = await prisma.allocation.count({ where: { status: 'ACTIVE' } });
  console.log(`Active allocations before: ${active}`);

  // Release allocations whose booking is already terminal, OR older than 1 hour
  // (test leftovers). Adjust the window if you want to be more/less aggressive.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);

  const released = await prisma.allocation.updateMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { booking: { status: { in: ['COMPLETED', 'CANCELLED', 'EXPIRED'] } } },
        { createdAt: { lt: cutoff } },
      ],
    },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });

  console.log(`Released ${released.count} stale allocation(s).`);
  const remaining = await prisma.allocation.count({ where: { status: 'ACTIVE' } });
  console.log(`Active allocations after: ${remaining}`);

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });