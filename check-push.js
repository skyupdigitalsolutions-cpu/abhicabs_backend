/**
 * check-push.js
 *
 * Why a notification did not arrive, narrowed to one of four causes.
 *
 * "[push] Firebase ready" in the worker log only means the worker can TALK to
 * Firebase. It says nothing about whether there is a device to send to, or
 * whether anything asked it to send. Those are the parts that actually break.
 *
 * Run from the backend project root:
 *   node check-push.js                 (uses .env — your local database)
 *   $env:DATABASE_URL="<railway url>"; node check-push.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const url = process.env.DATABASE_URL || '';
  console.log(`\nDatabase: ${url.replace(/\/\/[^@]*@/, '//****@')}\n`);

  /* 1. Is there a device registered at all? ------------------------------- */

  const tokens = await prisma.$queryRaw`
    SELECT dt.id, dt.platform, dt.created_at, dt.last_seen_at,
           u.name, u.email, u.role,
           length(dt.token) AS token_len
    FROM device_tokens dt
    JOIN users u ON u.id = dt.user_id
    ORDER BY dt.last_seen_at DESC
    LIMIT 10
  `;

  console.log('1. Registered devices\n');
  if (tokens.length === 0) {
    console.log('   NONE. This is almost certainly the whole problem.\n');
    console.log('   The app posts to /device-tokens on sign-in (store/session.ts).');
    console.log('   No rows means that call never succeeded. Usual causes:');
    console.log('     - notification permission was denied on the device');
    console.log('     - running in Expo Go: getDevicePushTokenAsync needs a dev/production build');
    console.log('     - google-services.json missing or for a different package name');
    console.log('     - the user has not signed in since push was added\n');
  } else {
    for (const t of tokens) {
      console.log(`   ${t.platform.padEnd(8)} ${String(t.role).padEnd(8)} ${t.name ?? t.email}`);
      console.log(`     token length ${t.token_len}, last seen ${new Date(t.last_seen_at).toISOString().slice(0, 16).replace('T', ' ')}`);
    }
    console.log('');
  }

  /* 2. Did anything try to send? ----------------------------------------- */
  // notification_log may not exist in every build; treated as optional so a
  // missing table reports as "no log" rather than crashing the whole check.

  console.log('2. Recent send attempts\n');
  try {
    const sends = await prisma.$queryRawUnsafe(`
      SELECT * FROM notification_log ORDER BY created_at DESC LIMIT 8
    `);
    if (sends.length === 0) {
      console.log('   No attempts logged. Nothing ASKED for a notification —');
      console.log('   the problem is upstream of push, in whatever should have queued it.\n');
    } else {
      for (const s of sends) {
        console.log(`   ${JSON.stringify(s).slice(0, 180)}`);
      }
      console.log('');
    }
  } catch {
    console.log('   (no notification_log table in this schema — skipping)\n');
  }

  /* 3. Are there bookings whose events should have notified? -------------- */

  const recent = await prisma.$queryRaw`
    SELECT booking_number, status, updated_at
    FROM bookings
    ORDER BY updated_at DESC
    LIMIT 5
  `;
  console.log('3. Recent booking activity (what should have triggered a push)\n');
  for (const b of recent) {
    console.log(`   ${b.booking_number}  ${String(b.status).padEnd(12)} ${new Date(b.updated_at).toISOString().slice(0, 16).replace('T', ' ')}`);
  }

  console.log('\nHow to read this:');
  console.log('  devices 0                  -> the app never registered. Fix the app side first.');
  console.log('  devices > 0, no attempts   -> nothing is queueing notifications.');
  console.log('  devices > 0, attempts fail -> Firebase/APNs credential or token problem.\n');
}

main()
  .catch((e) => console.error('\nFailed:', e.message, '\n'))
  .finally(() => prisma.$disconnect());