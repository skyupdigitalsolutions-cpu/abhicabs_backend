'use strict';

/**
 * reset-migrations.js
 *
 * The ERP tables were dropped, but _prisma_migrations still lists all 47
 * migrations as applied — so `prisma migrate deploy` says "nothing pending"
 * and never rebuilds them. This clears that history (and only that), so the
 * next deploy replays every migration from scratch.
 *
 * It does NOT touch the bot_* tables; they belong to another application.
 *
 * Refuses to run if any ERP table still exists, so it cannot be used by
 * accident against a healthy database.
 *
 *   $env:DATABASE_URL="postgresql://..."
 *   $env:I_UNDERSTAND_DATA_LOSS="yes"
 *   node reset-migrations.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// If any of these exist, the schema is (at least partly) intact — stop.
const ERP_TABLES = ['users', 'bookings', 'vehicles', 'drivers', 'cities', 'customers'];

(async () => {
  if (process.env.I_UNDERSTAND_DATA_LOSS !== 'yes') {
    throw new Error('Set I_UNDERSTAND_DATA_LOSS="yes" to confirm.');
  }

  const present = await prisma.$queryRawUnsafe(
    `select tablename from pg_tables
      where schemaname = 'public' and tablename = any($1::text[])`,
    ERP_TABLES
  );

  if (present.length) {
    throw new Error(
      `Refusing to run — ERP tables still exist: ${present
        .map((t) => t.tablename)
        .join(', ')}. Nothing to rebuild.`
    );
  }

  const before = await prisma.$queryRawUnsafe(
    `select count(*)::int as n from _prisma_migrations`
  );
  console.log(`[reset] migration history rows: ${before[0].n}`);

  // Drop the table outright. migrate deploy recreates it and replays all 47.
  await prisma.$executeRawUnsafe(`drop table if exists _prisma_migrations`);
  console.log('[reset] _prisma_migrations dropped');

  const left = await prisma.$queryRawUnsafe(
    `select tablename from pg_tables where schemaname='public' order by 1`
  );
  console.log(`[reset] tables remaining: ${left.length}`);
  console.log(left.map((t) => `  - ${t.tablename}`).join('\n') || '  (none)');

  console.log('\n[reset] done. Now redeploy the backend on Railway.');
  console.log('[reset] Its start command runs `prisma migrate deploy`, which');
  console.log('[reset] will replay all 47 migrations and rebuild the schema.');
})()
  .catch((e) => {
    console.error('[reset] failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());