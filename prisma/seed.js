'use strict';

/**
 * prisma/seed.js
 *
 * Creates the first admin, plus a demo user in development.
 *
 * Run:  npm run seed
 *
 * There is no "register as admin" endpoint by design — that would let anyone
 * grant themselves admin. The first admin is seeded; every admin after that is
 * created by an existing admin.
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ROUNDS = 12;

async function main() {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  const adminName = process.env.SEED_ADMIN_NAME || 'Super Admin';

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {}, // never overwrite an existing admin's details
    create: {
      name: adminName,
      email: adminEmail,
      password: await bcrypt.hash(adminPassword, ROUNDS),
      role: 'ADMIN',
      isActive: true,
    },
    select: { id: true, email: true, role: true },
  });

  console.log(`[seed] admin ready: ${admin.email}`);

  if (process.env.NODE_ENV !== 'production') {
    const demo = await prisma.user.upsert({
      where: { email: 'user@example.com' },
      update: {},
      create: {
        name: 'Demo User',
        email: 'user@example.com',
        password: await bcrypt.hash('User@12345', ROUNDS),
        role: 'USER',
        isActive: true,
      },
      select: { email: true },
    });
    console.log(`[seed] demo user ready: ${demo.email} / User@12345`);
  }

  console.log('\n[seed] done. Log in with the admin credentials from your .env file.');
  console.warn('[seed] change the seeded admin password after first login.');
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });