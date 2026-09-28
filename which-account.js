/**
 * which-account.js
 *
 * Shows how much real history sits on each account still sharing
 * 8431538785, so you can tell which one to keep.
 *
 * A file rather than a `node -e` one-liner because PowerShell mangles both
 * `$` and escaped quotes — `count(*)` ends up being run as a command.
 *
 * $queryRaw goes straight to Postgres without consulting schema.prisma, which
 * matters while migrations are blocked: the generated client expects columns
 * the database does not have yet, so any normal Prisma query fails here.
 *
 *   node which-account.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.$queryRaw`
    SELECT id, name, email, phone, created_at
    FROM users
    WHERE phone IN (
      SELECT phone FROM users
      WHERE phone IS NOT NULL
      GROUP BY phone HAVING count(*) > 1
    )
    ORDER BY created_at
  `;

  if (users.length === 0) {
    console.log('\nNo duplicates left. Run the migration.\n');
    return;
  }

  console.log('');
  for (const u of users) {
    // Counted per account rather than joined, so one account with no rows at
    // all still prints a line. A LEFT JOIN would be tidier but an empty result
    // is exactly the case being looked for.
    const [b] = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM bookings WHERE customer_id = ${u.id}::uuid
    `;
    const [p] = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM payments pay
      JOIN bookings bk ON bk.id = pay.booking_id
      WHERE bk.customer_id = ${u.id}::uuid
    `;

    console.log(`  ${u.email}`);
    console.log(`    id        ${u.id}`);
    console.log(`    name      ${u.name}`);
    console.log(`    created   ${new Date(u.created_at).toISOString().slice(0, 10)}`);
    console.log(`    bookings  ${b.n}`);
    console.log(`    payments  ${p.n}`);
    console.log('');
  }

  console.log('Keep the one with history. Clear the phone on the other:');
  console.log('  node fix-dupe-phone.js <id>\n');
}

main()
  .catch((e) => {
    console.error('\nFailed:', e.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());