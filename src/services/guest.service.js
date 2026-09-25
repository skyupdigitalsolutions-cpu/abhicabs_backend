'use strict';

/**
 * src/services/guest.service.js
 *
 * Web guest checkout: booking a cab without signing up.
 *
 * ---------------------------------------------------------------------------
 * ISOLATION IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 * A guest NEVER matches an existing account. Not by phone, not by email, not
 * by name.
 *
 * The temptation is obvious — recognise a returning guest, put their booking
 * in their app history — and it is exactly the wrong thing. `users.phone` is
 * unique and the WhatsApp bot resolves a customer by it, which is safe only
 * because Meta verified that number. A web form verifies nothing. If guest
 * checkout looked customers up by phone, typing a stranger's number would
 * hand over their saved addresses, their booking history and their corporate
 * billing. A public form must not be an account-takeover route.
 *
 * So each guest checkout creates its own isolated record with no phone on the
 * user row. Nothing is looked up, so nothing can be claimed.
 *
 * WHAT THIS COSTS, plainly: a guest who is already a customer gets a second
 * record, and their guest booking never appears in the app. Fixing that needs
 * phone verification — a different feature, and a different decision.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const tokens = require('../utils/tokens');

/** Digits only, for comparison. Display keeps whatever the guest typed. */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw ApiError.badRequest('Enter a valid mobile number', 'INVALID_PHONE');
  }
  return `+${digits.length === 10 ? `91${digits}` : digits}`;
}

/**
 * Start a guest session.
 *
 * Returns the same access token a normal login produces, so every existing
 * route — /fares, /bookings, /payments — works unchanged. The booking flow is
 * identical to a signed-in rider's, which is what was asked for.
 *
 * NO refresh token. A guest session is one checkout; a long-lived credential
 * for an account nobody can log into again is a liability with no use.
 */
async function startSession({ name, phone, email } = {}) {
  /*
   * Only normalised when supplied. A session with no phone is the normal case
   * now — the visitor is browsing, and the number arrives with the booking.
   */
  const displayPhone = phone ? normalisePhone(phone) : null;

  /*
   * A fresh user EVERY time, by design.
   *
   * Not findFirst-then-create. Reuse would require looking a guest up, and
   * looking a guest up by an unverified phone is the takeover route this whole
   * design exists to avoid.
   *
   * The duplicate records are the price of that safety, and they are
   * identifiable: customers.isGuest marks every one.
   */
  const unique = crypto.randomUUID();

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: String(name || '').trim().slice(0, 120) || 'Guest',
        /*
         * A synthetic address on the RFC 2606 reserved TLD, which can never be
         * registered — so nothing addressed here is ever delivered to a
         * stranger. The guest's real email, if they gave one, lives on the
         * booking where the invoice can find it.
         */
        email: `guest-${unique}@guest.invalid`,
        // NULL, deliberately. A phone here would make this record findable by
        // phone, which is the one thing that must not happen.
        phone: null,
        password: await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10),
        role: 'USER',
      },
      select: { id: true, name: true, role: true },
    });

    await tx.customer.create({ data: { userId: created.id, isGuest: true } });
    return created;
  });

  return {
    accessToken: tokens.signAccessToken({ userId: user.id, role: user.role }),
    expiresIn: 15 * 60,
    guest: {
      id: user.id,
      name: user.name,
      // Echoed back so the checkout form can carry it into the booking body;
      // it is NOT stored on the user row.
      phone: displayPhone,
      email: email || null,
    },
  };
}

/**
 * Find a guest's booking after the fact.
 *
 * Booking number AND phone, both required. The number alone would be an
 * enumeration oracle — ABH-2026-001027 is one away from someone else's trip —
 * and the phone alone would list every booking a number ever made, which is
 * the same takeover problem in a different shape.
 *
 * A wrong pair returns the SAME not-found as a missing one. Distinguishing
 * "no such booking" from "wrong phone" would confirm which booking numbers
 * exist, which is half of what an attacker needs.
 */
async function findBooking({ bookingNumber, phone }) {
  const normalised = normalisePhone(phone);

  const booking = await prisma.booking.findFirst({
    where: {
      bookingNumber: String(bookingNumber || '').trim().toUpperCase(),
      guestPhone: normalised,
    },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      tripType: true,
      pickupAddress: true,
      dropAddress: true,
      pickupAt: true,
      estimatedFare: true,
      finalFare: true,
      guestName: true,
    },
  });

  if (!booking) {
    throw ApiError.notFound(
      'No booking found with that number and mobile',
      'BOOKING_NOT_FOUND',
    );
  }

  return booking;
}

module.exports = { startSession, findBooking, normalisePhone };