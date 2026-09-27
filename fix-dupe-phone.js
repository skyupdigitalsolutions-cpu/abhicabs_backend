/**
 * fix-dupe-phone.js
 *
 * Unblocks the 20260924140000_unique_phone migration, which refuses to create
 * users_phone_key while two accounts share a number.
 *
 * WHY A SCRIPT AND NOT PRISMA STUDIO
 * ----------------------------------
 * Studio (and every normal Prisma query) builds its SELECT from schema.prisma,
 * which now expects columns that later migrations add — customers.is_guest,
 * for one. Those migrations are queued BEHIND the failed one, so the columns
 * do not exist yet and the query dies. That is the deadlock: Studio cannot
 * show you the rows you must fix in order to make Studio work.
 *
 * $queryRaw goes straight to Postgres and never consults the schema, so it is
 * unaffected. Nothing here touches a Prisma model.
 *
 * USAGE
 *   node fix-dupe-phone.js               list duplicates, change nothing
 *   node fix-dupe-phone.js <user-id>     clear the phone on that ONE row
 *
 * Clearing rather than deleting is deliberate: NULL is exempt from a Postgres
 * unique index, so the account, its login and its booking history all survive.
 * The number is simply freed. Deleting a user would cascade to their bookings.
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function list() {
  const rows = await prisma.$queryRaw`
    SELECT id, name, email, phone, role, is_active, created_at
    FROM users
    WHERE phone IN (
      SELECT phone FROM users
      WHERE phone IS NOT NULL
      GROUP BY phone HAVING count(*) > 1
    )
    ORDER BY phone, created_at
  `;

  if (rows.length === 0) {
    console.log('\nNo duplicate phone numbers. You can run the migration now.\n');
    return;
  }

  console.log(`\n${rows.length} rows share a phone number:\n`);
  for (const r of rows) {
    // A phone-first signup gets a generated address, and that is almost always
    // the row to clear — it holds no real identity.
    const placeholder = /@placeholder\.local$/i.test(r.email || '');
    console.log(`  phone    ${r.phone}`);
    console.log(`  id       ${r.id}`);
    console.log(`  name     ${r.name}`);
    console.log(`  email    ${r.email}${placeholder ? '   <-- placeholder, likely safe to clear' : ''}`);
    console.log(`  role     ${r.role}   active: ${r.is_active}`);
    console.log(`  created  ${new Date(r.created_at).toISOString()}`);
    console.log('');
  }

  console.log('Keep the real account. Clear the other:');
  console.log('  node fix-dupe-phone.js <id-to-clear>\n');
}

async function clearPhone(id) {
  const [before] = await prisma.$queryRaw`
    SELECT id, name, email, phone FROM users WHERE id = ${id}::uuid
  `;

  if (!before) {
    console.log(`\nNo user with id ${id}. Nothing changed.\n`);
    return;
  }
  if (before.phone === null) {
    console.log(`\n${before.email} already has no phone. Nothing to do.\n`);
    return;
  }

  console.log(`\nClearing phone ${before.phone} from ${before.email} (${before.name})`);

  // Pinned to this one id. No WHERE phone = ..., which would strip the number
  // from BOTH rows and leave the account you meant to keep unable to sign in.
  await prisma.$executeRaw`UPDATE users SET phone = NULL WHERE id = ${id}::uuid`;

  const remaining = await prisma.$queryRaw`
    SELECT phone, count(*)::int AS n FROM users
    WHERE phone IS NOT NULL
    GROUP BY phone HAVING count(*) > 1
  `;

  if (remaining.length === 0) {
    console.log('\nDone. No duplicates left. Now run:\n');
    console.log('  npx prisma migrate resolve --rolled-back 20260924140000_unique_phone');
    console.log('  npx prisma migrate deploy');
    console.log('  npx prisma generate\n');
  } else {
    console.log('\nStill duplicated:');
    for (const r of remaining) console.log(`  ${r.phone} x${r.n}`);
    console.log('\nRun this script with no arguments to see them.\n');
  }
}

const id = process.argv[2];

(id ? clearPhone(id) : list())
  .catch((e) => {
    console.error('\nFailed:', e.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());