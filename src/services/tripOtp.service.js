'use strict';

/**
 * src/services/tripOtp.service.js
 *
 * The code the rider reads out to the driver to start the trip.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS ACTUALLY FOR
 * ---------------------------------------------------------------------------
 * It proves the rider is PRESENT when the meter starts. Not who they are —
 * they already authenticated to book — but that the driver has physically met
 * them before the trip begins.
 *
 * That matters because "trip started" has money attached: it begins the billed
 * journey and, on a rental, the clock. Without a gate, a driver can start a
 * trip from the car park and a rider who was ten minutes late pays for it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT otp.service
 * ---------------------------------------------------------------------------
 * The login OTP is built for a different job and its defaults are wrong here:
 *
 *   - It expires in 5 minutes. A trip code is issued at booking and read out
 *     at pickup, possibly days later.
 *   - It is stored in Redis. A booking outlives any cache, and a code that
 *     evaporates on a Redis restart strands the rider at the kerb.
 *   - It is consumed once and hashed. The rider has to SEE this one, every
 *     time they open the booking.
 *
 * So this lives on the booking row, alongside the trip it gates.
 *
 * ---------------------------------------------------------------------------
 * IT IS STORED IN PLAIN TEXT — DELIBERATELY
 * ---------------------------------------------------------------------------
 * A login code is hashed because the server only ever needs to COMPARE it.
 * This one has to be displayed to the rider on demand, so a hash cannot work.
 *
 * The trade is acceptable because of what the code protects: knowing it lets
 * someone start a trip that is already booked, paid for and assigned to a
 * named driver. It is not a credential, grants no account access, and is
 * worthless once the trip is ONGOING. It is excluded from every select except
 * the owning customer's own booking detail — see BOOKING_OTP_SELECT.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');

/**
 * Four digits, matching the login code so riders are not learning two formats,
 * and short enough to read out across a car window.
 *
 * Four is enough HERE because of how it is attacked: only the driver assigned
 * to this booking can submit it (assertDriverOnBooking), only while the trip
 * is at pickup, and MAX_ATTEMPTS locks it after five wrong tries — so a
 * guesser gets five chances in ten thousand, once, on one trip.
 */
const OTP_LENGTH = 4;

/**
 * Wrong guesses before the code is locked.
 *
 * Lower than the login OTP's allowance. A driver standing next to the rider
 * reading digits off a screen does not need fifteen attempts, and a code that
 * tolerates many guesses is a code a dishonest driver can brute-force from the
 * car park — 6 digits at 5 attempts is a 1-in-20,000 shot.
 */
const MAX_ATTEMPTS = 5;

function generateCode() {
  const max = 10 ** OTP_LENGTH;
  // crypto, not Math.random: a predictable start code is a startable trip.
  const n = require('crypto').randomInt(0, max);
  return String(n).padStart(OTP_LENGTH, '0');
}

/* ------------------------------------------------------------------ *
 * Issue
 * ------------------------------------------------------------------ */

/**
 * Mints the code for a booking and stores it on the booking. NOTHING IS SENT.
 *
 * The code used to be emailed, then texted. It no longer leaves the backend
 * except through the rider's own booking detail in the app (the only select
 * that includes it — see BOOKING_OTP_SELECT). The rider reads it off their
 * trip screen, the driver types it in, and lifecycle.startTrip checks it.
 *
 * Keeping it in the app alone means no SMS cost per booking, no DLT template
 * for it, no delivery failures to handle, and no copy of the code sitting in
 * an inbox or a message thread after the trip.
 *
 * The second argument is accepted and ignored so existing callers need no
 * change.
 *
 * @returns {Promise<string>} the code
 */
// eslint-disable-next-line no-unused-vars
async function issue(bookingId, _opts = {}) {
  const code = generateCode();

  await prisma.booking.update({
    where: { id: bookingId },
    data: { startOtp: code, startOtpIssuedAt: new Date(), startOtpAttempts: 0 },
  });

  return code;
}

/* ------------------------------------------------------------------ *
 * Verify
 * ------------------------------------------------------------------ */

/**
 * Checks the code a driver typed. Throws on any failure; returns silently on
 * success, leaving the caller to perform the transition.
 *
 * Does NOT clear the code. The trip's own status is the record of whether it
 * started — a second call fails on the status transition, not here — and
 * keeping it means a rider looking at a running trip still sees the code they
 * read out, rather than a blank where it used to be.
 */
async function verify(bookingId, code) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      startOtp: true,
      startOtpAttempts: true,
      startOtpVerifiedAt: true,
    },
  });

  if (!booking) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');

  // Already verified — let it through so a retried request after a dropped
  // response does not strand a driver who typed the right code.
  if (booking.startOtpVerifiedAt) return { alreadyVerified: true };

  if (!booking.startOtp) {
    throw ApiError.badRequest(
      'This booking has no start code. Please contact support.',
      'NO_START_OTP',
    );
  }

  if (booking.startOtpAttempts >= MAX_ATTEMPTS) {
    throw new ApiError(
      429,
      'START_OTP_LOCKED',
      'Too many incorrect codes. Please contact support to start this trip.',
    );
  }

  const supplied = String(code || '').trim();

  if (supplied !== booking.startOtp) {
    // Counted BEFORE throwing, so a wrong guess costs an attempt whether or not
    // the caller reads the response.
    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: { startOtpAttempts: { increment: 1 } },
      select: { startOtpAttempts: true },
    });

    const left = Math.max(0, MAX_ATTEMPTS - updated.startOtpAttempts);
    throw ApiError.badRequest(
      left > 0
        ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'That code is not correct. No attempts left — please contact support.',
      'START_OTP_INVALID',
    );
  }

  await prisma.booking.update({
    where: { id: bookingId },
    data: { startOtpVerifiedAt: new Date() },
  });

  return { alreadyVerified: false };
}

/**
 * Re-issues a code, with the wrong-attempt counter back at zero. An ops action,
 * never something the driver can trigger.
 *
 * For a code that locked after too many wrong tries, or one the rider thinks
 * was seen by someone else. The new code replaces the old on the rider's trip
 * screen at once; the response also returns it, so ops can read it out to a
 * rider on the phone whose app will not open.
 */
async function reissue(bookingId) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      startOtpVerifiedAt: true,
    },
  });

  if (!booking) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
  if (booking.startOtpVerifiedAt) {
    throw ApiError.badRequest('This trip has already started', 'TRIP_ALREADY_STARTED');
  }

  const code = await issue(booking.id);

  return { reissued: true, code };
}

module.exports = { issue, verify, reissue, MAX_ATTEMPTS, OTP_LENGTH };