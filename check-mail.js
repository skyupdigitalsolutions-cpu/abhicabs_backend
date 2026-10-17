/**
 * check-mail.js
 *
 * Why a booking confirmation email did not arrive, narrowed to one cause.
 *
 * RUN IT ON THE WORKER SERVICE. The confirmation email is sent from
 * jobs/notification.job.js, which only runs in `node src/workers/index.js`.
 * Running this on the API tells you about the API's environment, which is not
 * the one that matters.
 *
 *   node check-mail.js ABH-2026-001183
 *   node check-mail.js ABH-2026-001183 --send
 *
 * --send calls sendBookingConfirmedEmail directly, with no queue, no event bus
 * and no runOnce in the way. If the mail arrives from --send but not from a
 * real confirmation, the mailer is fine and the break is upstream of it.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const bookingNumber = process.argv[2] || null;
const doSend = process.argv.includes('--send');

function mask(v) {
  const s = String(v || '');
  if (!s) return '(empty)';
  return s.length <= 8 ? `${s[0]}***` : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function main() {
  console.log('');

  /* 1. Is the deployed code the new code? -------------------------------- */

  console.log('1. Code actually loaded by THIS process\n');

  const emailService = require('./src/services/email.service');
  const hasFn = typeof emailService.sendBookingConfirmedEmail === 'function';
  console.log(`   email.service.sendBookingConfirmedEmail  ${hasFn ? 'present' : 'MISSING'}`);

  const jobSrc = require('fs').readFileSync('./src/jobs/notification.job.js', 'utf8');
  const hasCall = jobSrc.includes('sendConfirmationEmail');
  console.log(`   notification.job email step              ${hasCall ? 'present' : 'MISSING'}`);

  if (!hasFn || !hasCall) {
    console.log('\n   >> This service is running the OLD code. Redeploy it.');
    console.log('      Railway redeploys the API and the worker independently.\n');
    await prisma.$disconnect();
    return;
  }
  console.log('');

  /* 2. Mail configuration ------------------------------------------------ */

  console.log('2. Mail configuration\n');

  const env = require('./src/config/env');
  console.log(`   MAIL_PROVIDER  ${env.mail.provider}`);
  console.log(`   MAIL_FROM      ${env.mail.from}`);
  console.log(`   BREVO_API_KEY  ${mask(env.mail.brevoApiKey)}`);

  const provider = require('./src/services/providers/email.provider').getProvider();
  console.log(`   resolved to    ${provider.name} (configured=${provider.configured})`);

  if (!provider.configured) {
    console.log('\n   >> Falls back to console: every send is printed, not delivered.');
    console.log('      The variables are missing on THIS service.\n');
  }
  console.log('');

  if (!bookingNumber) {
    console.log('3. Booking trace — skipped. Pass a booking number as the first argument.\n');
    await prisma.$disconnect();
    return;
  }

  /* 3. The booking ------------------------------------------------------- */

  console.log(`3. Booking ${bookingNumber}\n`);

  const booking = await prisma.booking.findFirst({
    where: { bookingNumber },
    select: {
      id: true, bookingNumber: true, status: true, confirmedAt: true,
      tripType: true, vehicleClass: true, pickupAddress: true, dropAddress: true,
      pickupAt: true, returnAt: true, distanceKm: true,
      estimatedFare: true, finalFare: true, advancePaid: true, balanceDue: true,
      paymentMode: true, fareBasis: true, guestName: true,
      customer: { select: { user: { select: { name: true, email: true } } } },
    },
  });

  if (!booking) {
    console.log('   Not found. Wrong DATABASE_URL for this environment?\n');
    await prisma.$disconnect();
    return;
  }

  console.log(`   status       ${booking.status}`);
  console.log(`   confirmedAt  ${booking.confirmedAt ? booking.confirmedAt.toISOString() : '(never confirmed)'}`);
  console.log(`   fare         ${booking.finalFare ?? booking.estimatedFare}`);

  if (booking.status === 'PENDING') {
    console.log('\n   >> CAUSE: still PENDING. No admin confirmed it, so BOOKING_CONFIRMED');
    console.log('      never fired. The app\'s "Booking confirmed" screen shows on create');
    console.log('      and does not reflect this status.');
  }

  const to = booking.customer?.user?.email ?? null;
  console.log(`\n   rider email  ${to || '(none)'}`);
  if (!emailService.isDeliverableEmail(to)) {
    console.log('   >> CAUSE: not deliverable. Phone-first OTP signup generates a');
    console.log('      phone_<number>@placeholder.local address, skipped on purpose.');
  }

  const key = `notif:BOOKING_CONFIRMED:${booking.id}`.slice(0, 120);
  const claim = await prisma.idempotencyKey.findUnique({
    where: { key },
    select: { createdAt: true, responseBody: true },
  });

  console.log(`\n   runOnce key  ${claim ? `CLAIMED ${claim.createdAt.toISOString()}` : 'not claimed'}`);
  if (claim) {
    console.log('   >> CAUSE (if that timestamp predates your deploy): the job already ran');
    console.log('      for this booking. Redeliveries take the skipped branch and return');
    console.log('      before the email step. This booking can never send one — use a new one.');
    if (claim.responseBody) {
      console.log(`      recorded: ${JSON.stringify(claim.responseBody).slice(0, 200)}`);
    }
  } else if (booking.status !== 'PENDING') {
    console.log('   >> CAUSE: confirmed, but the job never ran. The worker is not consuming');
    console.log('      the notifications queue — check it is up and REDIS_URL matches the API.');
  }

  /* 4. Direct send, bypassing everything --------------------------------- */

  if (doSend) {
    console.log('\n4. Direct send (no queue, no runOnce)\n');
    const result = await emailService.sendBookingConfirmedEmail({
      to,
      name: booking.customer?.user?.name ?? null,
      booking,
    });
    console.log(`   ${JSON.stringify(result)}`);
    if (result.skipped) console.log('\n   >> Skipped on the address. See above.');
    else if (result.failed) console.log(`\n   >> Provider rejected it: ${result.error}`);
    else console.log('\n   >> Accepted by the provider. Check inbox AND spam.');
    console.log('      If this arrives but a real confirmation does not, the mailer is fine');
    console.log('      and the break is upstream: deploy, dedupe key, or the worker.\n');
  } else {
    console.log('\n4. Direct send — skipped. Re-run with --send to force one.\n');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});