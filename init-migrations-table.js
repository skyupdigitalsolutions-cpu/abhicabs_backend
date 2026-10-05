'use strict';

/**
 * init-migrations-table.js
 *
 * `prisma migrate deploy` returns P3005 when the database has tables but no
 * _prisma_migrations table — it will not write into a schema it cannot account
 * for. Here the only tables are bot_*, which belong to a different app.
 *
 * Recreating the history table EMPTY tells Prisma the database is under its
 * management with nothing applied yet, so deploy replays all 47 migrations.
 * Nothing else is touched; the bot tables stay exactly as they are.
 *
 *   $env:DATABASE_URL="postgresql://..."
 *   node init-migrations-table.js
 *   npx prisma migrate deploy
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const existing = await prisma.$queryRawUnsafe(
    `select count(*)::int as n from pg_tables
      where schemaname = 'public' and tablename = '_prisma_migrations'`
  );

  if (existing[0].n > 0) {
    const rows = await prisma.$queryRawUnsafe(
      `select count(*)::int as n from _prisma_migrations`
    );
    console.log(`[init] _prisma_migrations already exists with ${rows[0].n} row(s).`);
    if (rows[0].n > 0) {
      console.log('[init] Not empty — stopping. Run reset-migrations.js first.');
      return;
    }
    console.log('[init] Empty already. Nothing to do.');
    return;
  }

  // Exactly the shape Prisma creates itself.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "_prisma_migrations" (
      "id"                    VARCHAR(36)  PRIMARY KEY NOT NULL,
      "checksum"              VARCHAR(64)  NOT NULL,
      "finished_at"           TIMESTAMPTZ,
      "migration_name"        VARCHAR(255) NOT NULL,
      "logs"                  TEXT,
      "rolled_back_at"        TIMESTAMPTZ,
      "started_at"            TIMESTAMPTZ  NOT NULL DEFAULT now(),
      "applied_steps_count"   INTEGER      NOT NULL DEFAULT 0
    )
  `);

  console.log('[init] _prisma_migrations created, empty.');
  console.log('[init] Now run:  npx prisma migrate deploy');
})()
  .catch((e) => {
    console.error('[init] failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());