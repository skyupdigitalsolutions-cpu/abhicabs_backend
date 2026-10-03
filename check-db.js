'use strict';

/**
 * check-db.js — read-only. Reports what is actually in the database.
 *
 *   $env:DATABASE_URL="postgresql://..."
 *   node check-db.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const url = process.env.DATABASE_URL || '';
  const host = url.replace(/\/\/[^@]*@/, '//***@');
  console.log(`connected via: ${host}\n`);

  const tables = await prisma.$queryRawUnsafe(
    `select tablename from pg_tables where schemaname = 'public' order by 1`
  );
  console.log(`TABLES IN public: ${tables.length}`);
  console.log(tables.map((t) => t.tablename).join('\n') || '(none)');

  // Other schemas, in case everything moved rather than vanished.
  const schemas = await prisma.$queryRawUnsafe(
    `select table_schema, count(*)::int as n
       from information_schema.tables
      where table_schema not in ('pg_catalog','information_schema')
      group by 1 order by 2 desc`
  );
  console.log('\nTABLES BY SCHEMA:');
  console.table(schemas);

  // Migration history: the key signal.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `select migration_name, finished_at, rolled_back_at
         from _prisma_migrations order by started_at desc limit 8`
    );
    const total = await prisma.$queryRawUnsafe(
      `select count(*)::int as n from _prisma_migrations`
    );
    console.log(`\n_prisma_migrations rows: ${total[0].n}`);
    console.table(rows);
  } catch (e) {
    console.log(`\n_prisma_migrations: NOT PRESENT (${e.code || e.message})`);
  }

  // What search_path resolves to, in case the app and you differ.
  const sp = await prisma.$queryRawUnsafe(`show search_path`);
  console.log(`\nsearch_path: ${JSON.stringify(sp)}`);

  const db = await prisma.$queryRawUnsafe(
    `select current_database() as db, current_user as usr`
  );
  console.log(`database: ${db[0].db}   user: ${db[0].usr}`);
})()
  .catch((e) => {
    console.error('failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());