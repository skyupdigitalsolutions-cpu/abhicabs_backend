'use strict';

/**
 * set-admin.js
 *
 * One-off: point the ADMIN account at a new email and password.
 *
 * Unlike prisma/seed.js (whose upsert has `update: {}` and therefore never
 * touches an existing admin), this script WILL overwrite. That is the point.
 *
 * Usage, locally against prod:
 *   DATABASE_URL="<railway postgres url>" \
 *   ADMIN_EMAIL="you@yourdomain.com" \
 *   ADMIN_PASSWORD="YourNewStrongPassword" \
 *   node set-admin.js
 *
 * Or on Railway:  railway run node set-admin.js
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ROUNDS = 12;

async function main() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = process.env.ADMIN_NAME || 'Super Admin';

  if (!email || !password) {
    throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD.');
  }
  if (password.length < 8) {
    throw new Error('Pick a password of at least 8 characters.');
  }

  const hash = await bcrypt.hash(password, ROUNDS);

  // Find whichever admin already exists, so we move that row rather than
  // leaving an orphaned old admin behind.
  const existing =
    (await prisma.user.findUnique({ where: { email } })) ||
    (await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
    }));

  let admin;

  if (existing) {
    admin = await prisma.user.update({
      where: { id: existing.id },
      data: { email, password: hash, name, role: 'ADMIN', isActive: true },
      select: { id: true, email: true, role: true, isActive: true },
    });
    console.log(`[set-admin] updated existing user ${existing.id}`);
  } else {
    admin = await prisma.user.create({
      data: { name, email, password: hash, role: 'ADMIN' },
      select: { id: true, email: true, role: true, isActive: true },
    });
    console.log('[set-admin] no admin existed — created one');
  }

  // Any session issued to the old credentials should die with them.
  const killed = await prisma.refreshToken.updateMany({
    where: { userId: admin.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  console.log(`[set-admin] email:    ${admin.email}`);
  console.log(`[set-admin] role:     ${admin.role}`);
  console.log(`[set-admin] active:   ${admin.isActive}`);
  console.log(`[set-admin] sessions revoked: ${killed.count}`);

  // Prove the hash actually matches what you typed, so a failed login after
  // this is definitely not the password.
  const check = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { password: true },
  });
  console.log(`[set-admin] verify:   ${await bcrypt.compare(password, check.password)}`);

  // Warn about leftovers rather than deleting anything.
  const others = await prisma.user.findMany({
    where: { role: 'ADMIN', id: { not: admin.id } },
    select: { id: true, email: true, isActive: true },
  });
  if (others.length) {
    console.warn(`\n[set-admin] NOTE: ${others.length} other ADMIN account(s) still exist:`);
    for (const o of others) console.warn(`  - ${o.email} (active: ${o.isActive})`);
    console.warn('[set-admin] Deactivate or delete any you did not intend to keep.');
  }
}

main()
  .catch((err) => {
    console.error('[set-admin] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());