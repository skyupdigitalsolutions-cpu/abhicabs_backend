'use strict';

/**
 * prisma/seed.js
 *
 * Idempotent — safe to run repeatedly. Cities, fare configs and RBAC
 * permissions are seeded by the MIGRATION (day1-constraints.sql); this file
 * seeds the accounts and fleet you need to develop against.
 *
 * Run:  npm run seed
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ROUNDS = 12;

async function main() {
  /* ------------------------------------------------------------------ *
   * 1. Admin
   * ------------------------------------------------------------------ */

  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},                       // never overwrite an existing admin
    create: {
      name: process.env.SEED_ADMIN_NAME || 'Super Admin',
      email: adminEmail,
      password: await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'Admin@12345', ROUNDS),
      role: 'ADMIN',
    },
    select: { id: true, email: true },
  });
  console.log(`[seed] admin: ${admin.email}`);

  if (process.env.NODE_ENV === 'production') {
    console.log('[seed] production — skipping demo data');
    return;
  }

  /* ------------------------------------------------------------------ *
   * 2. Staff accounts — one per role, to exercise the RBAC middleware
   * ------------------------------------------------------------------ */

  const staff = [
    ['ops@example.com', 'Ops Executive', 'OPS'],
    ['finance@example.com', 'Finance Executive', 'FINANCE'],
    ['fleet@example.com', 'Fleet Manager', 'FLEET'],
    ['support@example.com', 'Support Agent', 'SUPPORT'],
  ];

  for (const [email, name, role] of staff) {
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: { name, email, password: await bcrypt.hash('Staff@12345', ROUNDS), role },
    });
  }
  console.log(`[seed] ${staff.length} staff accounts (password: Staff@12345)`);

  /* ------------------------------------------------------------------ *
   * 3. City lookup (seeded by the migration)
   * ------------------------------------------------------------------ */

  const city = await prisma.city.findFirst({ where: { name: 'Bengaluru' } });
  if (!city) {
    throw new Error('[seed] Bengaluru missing — did you paste day1-constraints.sql into the migration?');
  }

  /* ------------------------------------------------------------------ *
   * 4. Corporate account + its employee
   * ------------------------------------------------------------------ */

  const corporate = await prisma.corporateAccount.upsert({
    where: { gstin: '29AABCU9603R1ZM' },
    update: {},
    create: {
      companyName: 'Skyup Digital Solutions Pvt Ltd',
      gstin: '29AABCU9603R1ZM',
      billingEmail: 'accounts@skyupdigitalsolutions.com',
      billingAddress: '1st Floor, Residency Road',
      billingCity: 'Bengaluru',
      billingState: 'Karnataka',
      billingPincode: '560025',
      billingCycle: 'MONTHLY',
      creditLimit: 100000,
    },
  });

  const corpUser = await prisma.user.upsert({
    where: { email: 'corp@example.com' },
    update: {},
    create: {
      name: 'Corporate Customer',
      email: 'corp@example.com',
      phone: '9876500001',
      password: await bcrypt.hash('User@12345', ROUNDS),
      role: 'USER',
    },
  });

  // Corporate account type => TAX invoice downstream
  await prisma.customer.upsert({
    where: { userId: corpUser.id },
    update: {},
    create: {
      userId: corpUser.id,
      accountType: 'CORPORATE',
      corporateAccountId: corporate.id,
    },
  });

  /* ------------------------------------------------------------------ *
   * 5. Retail customer + a saved address
   * ------------------------------------------------------------------ */

  const retailUser = await prisma.user.upsert({
    where: { email: 'user@example.com' },
    update: {},
    create: {
      name: 'Demo User',
      email: 'user@example.com',
      phone: '9876500002',
      password: await bcrypt.hash('User@12345', ROUNDS),
      role: 'USER',
    },
  });

  const retailCustomer = await prisma.customer.upsert({
    where: { userId: retailUser.id },
    update: {},
    create: { userId: retailUser.id, accountType: 'RETAIL' },
  });

  const hasAddress = await prisma.address.findFirst({
    where: { customerId: retailCustomer.userId, label: 'Home' },
  });

  if (!hasAddress) {
    await prisma.address.create({
      data: {
        customerId: retailCustomer.userId,
        label: 'Home',
        line1: '12, 4th Cross, Koramangala',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560034',
        lat: 12.9352,
        lng: 77.6245,
        isDefault: true,
      },
    });
  }
  console.log('[seed] customers: corp@example.com (CORPORATE), user@example.com (RETAIL)');

  /* ------------------------------------------------------------------ *
   * 6. Fleet — one vehicle per class, so allocation has something to bind
   * ------------------------------------------------------------------ */

  const vehicles = [
    ['KA01AB1234', 'hatchback', 'Maruti Swift', 4],
    ['KA01AB5678', 'sedan', 'Honda City', 4],
    ['KA01AB9012', 'suv', 'Toyota Innova', 7],
    ['KA01AB3456', 'tempo', 'Force Traveller', 12],
  ];

  for (const [reg, cls, model, seats] of vehicles) {
    await prisma.vehicle.upsert({
      where: { registrationNumber: reg },
      update: {},
      create: {
        registrationNumber: reg,
        vehicleClass: cls,
        makeModel: model,
        seatingCapacity: seats,
        status: 'AVAILABLE',
        cityId: city.id,
      },
    });
  }
  console.log(`[seed] ${vehicles.length} vehicles`);

  /* ------------------------------------------------------------------ *
   * 7. Drivers — verified, so they can receive allocations immediately
   * ------------------------------------------------------------------ */

  const drivers = [
    ['driver1@example.com', 'Ravi Kumar', '9876500011', 'KA0120200001234'],
    ['driver2@example.com', 'Suresh Babu', '9876500012', 'KA0120200005678'],
  ];

  for (const [email, name, phone, licence] of drivers) {
    const u = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        name,
        email,
        phone,
        password: await bcrypt.hash('Driver@12345', ROUNDS),
        role: 'DRIVER',
      },
    });

    await prisma.driver.upsert({
      where: { userId: u.id },
      update: {},
      create: {
        userId: u.id,
        licenceNumber: licence,
        kycStatus: 'VERIFIED',
        kycVerifiedAt: new Date(),
        policeVerifiedAt: new Date(),
        inductedAt: new Date(),
      },
    });
  }
  console.log(`[seed] ${drivers.length} drivers (password: Driver@12345)`);

  /* ------------------------------------------------------------------ *
   * Summary
   * ------------------------------------------------------------------ */

  const fareCount = await prisma.fareConfig.count();
  const permCount = await prisma.rolePermission.count();

  console.log('\n[seed] ------------------------------------------');
  console.log(`[seed] city: ${city.name}  |  fare configs: ${fareCount}  |  permissions: ${permCount}`);
  if (fareCount === 0 || permCount === 0) {
    console.warn('[seed] WARNING: fare configs or permissions missing.');
    console.warn('[seed] You probably did not paste day1-constraints.sql into the migration.');
  }
  console.log('[seed] done. Change the seeded admin password after first login.');
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });