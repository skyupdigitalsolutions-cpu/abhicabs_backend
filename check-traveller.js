/**
 * check-traveller.js
 *
 * Verifies the "booking for someone else" feature end to end.
 *
 * Two separate questions, because a null guestName has two very different
 * causes and the difference matters:
 *
 *   1. Is the SERVER CODE in place?  booking.service.js used to accept
 *      guestName/guestPhone only when customer.isGuest was true, so an app
 *      sending them for a signed-in rider had them silently dropped. This is
 *      checked by reading the file, not by guessing from the data.
 *
 *   2. Has anyone actually USED it?  A booking made without ticking the box
 *      stores null by design — that is correct behaviour, not a failure.
 *
 * Run it from the backend project root (where prisma/ and src/ live).
 *
 *   node check-traveller.js
 */

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function checkServerCode() {
  const file = path.join(__dirname, 'src', 'services', 'booking.service.js');

  if (!fs.existsSync(file)) {
    console.log('  ? src/services/booking.service.js not found here.');
    console.log('    Run this from the backend project root.\n');
    return;
  }

  const src = fs.readFileSync(file, 'utf8');

  // The old code gated the fields behind isGuest with a ternary. The new code
  // assigns them unconditionally. Looking for the gate is more reliable than
  // looking for its absence.
  const gated = /customerRow\?\.isGuest\s*\n?\s*\?\s*\{\s*\n?\s*guestName/.test(src);

  if (gated) {
    console.log('  ✗ OLD booking.service.js — traveller details are still gated');
    console.log('    behind customer.isGuest, so the app can send them and the');
    console.log('    server will drop them. Copy the updated file in.\n');
  } else if (src.includes('guestName: input.guestName')) {
    console.log('  ✓ booking.service.js accepts traveller details from any customer.\n');
  } else {
    console.log('  ? Could not tell — booking.service.js does not look like either version.\n');
  }
}

async function main() {
  console.log('\n1. Server code\n');
  checkServerCode();

  console.log('2. Recent bookings\n');

  const rows = await prisma.$queryRaw`
    SELECT booking_number, guest_name, guest_phone, created_at
    FROM bookings
    ORDER BY created_at DESC
    LIMIT 8
  `;

  if (rows.length === 0) {
    console.log('  No bookings yet.\n');
    return;
  }

  for (const r of rows) {
    const who = r.guest_name
      ? `for ${r.guest_name} (${r.guest_phone})`
      : 'for the account holder';
    console.log(`  ${r.booking_number}  ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}  ${who}`);
  }

  const withTraveller = rows.filter((r) => r.guest_name).length;
  console.log('');

  if (withTraveller > 0) {
    console.log(`  ✓ ${withTraveller} of the last ${rows.length} carry traveller details — it works.\n`);
  } else {
    console.log('  No recent booking has traveller details. That is EXPECTED unless');
    console.log('  you ticked "I\'m booking for someone else" in the confirm sheet.');
    console.log('  Make one with the box ticked, then run this again.\n');
  }
}

main()
  .catch((e) => {
    console.error('\nFailed:', e.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());