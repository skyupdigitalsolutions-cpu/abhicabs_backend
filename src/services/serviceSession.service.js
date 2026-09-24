'use strict';

/**
 * src/services/serviceSession.service.js
 *
 * Turns a verified WhatsApp phone number into a normal customer session.
 *
 * The bot calls this once per conversation, gets back the same access token a
 * phone-app login produces, and uses it on the existing /fares, /bookings and
 * /payments routes with a standard Authorization header. No existing route
 * changes, and nothing downstream can tell a WhatsApp booking from an app one
 * — which is the point: a booking is a booking.
 *
 * ---------------------------------------------------------------------------
 * THE PHONE MUST COME FROM META, NOT FROM A MESSAGE
 * ---------------------------------------------------------------------------
 * This service trusts the phone number it is given, completely. It has no way
 * to verify it and does not try.
 *
 * So the bot MUST take it from the verified webhook payload — the `from` field
 * WhatsApp signs — and never from text a user typed. If a user can influence
 * that number, this endpoint becomes account takeover: type someone else's
 * number, receive their session. That rule lives in the bot, and it is the
 * single most important line in this integration.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const tokens = require('../utils/tokens');
const audit = require('./audit.service');

/**
 * E.164, loosely. WhatsApp sends digits with no '+' ("919876543210"), so it is
 * normalised to a leading '+' here — otherwise the same person creates a second
 * account depending on which channel they came through.
 */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw ApiError.badRequest('A valid phone number is required', 'INVALID_PHONE');
  }
  // A bare 10-digit Indian number gets the country code it was sent without.
  const withCc = digits.length === 10 ? `91${digits}` : digits;
  return `+${withCc}`;
}

/**
 * Resolve the customer behind a phone number, creating one if this is their
 * first contact.
 *
 * Runs in a transaction because a User without its Customer extension is a
 * half-built account: it authenticates and then fails at the first booking,
 * which is a worse state than not existing.
 */
async function resolveCustomerByPhone(phone, profileName) {
  const existing = await prisma.user.findFirst({
    where: { phone },
    select: { id: true, name: true, role: true, isActive: true, email: true },
  });

  if (existing) {
    if (!existing.isActive) {
      throw ApiError.forbidden('This account is deactivated', 'ACCOUNT_INACTIVE');
    }

    /*
     * A DRIVER or an ADMIN whose phone happens to be messaging the bot must
     * not be handed a customer session. Roles are not interchangeable: a
     * driver booking a cab through the bot would be acting as themselves in a
     * role the booking flow does not expect.
     */
    if (existing.role !== 'USER') {
      throw ApiError.forbidden(
        'This number belongs to a staff or driver account and cannot book over WhatsApp',
        'ROLE_NOT_BOOKABLE',
      );
    }

    // Make sure the Customer row exists — an older User may predate it.
    await prisma.customer.upsert({
      where: { userId: existing.id },
      update: {},
      create: { userId: existing.id },
    });

    return { user: existing, created: false };
  }

  /*
   * A synthetic email, because User.email is required and unique while
   * WhatsApp gives us only a phone number.
   *
   * `.invalid` is the RFC 2606 reserved TLD: it can never be registered, so a
   * stray invoice or password-reset can never be delivered to a stranger. A
   * real-looking domain would eventually send someone's booking confirmation
   * to whoever bought it.
   *
   * This address is a placeholder, not a contact. Anything that emails a
   * customer must check for it — see isPlaceholderEmail below.
   */
  const email = `${phone.replace('+', '')}@whatsapp.invalid`;

  /*
   * An unusable password, not a blank one.
   *
   * The account has no password login — WhatsApp is its only entry point — but
   * the column is NOT NULL and bcrypt-comparing against an empty or predictable
   * hash is how "log in as any WhatsApp user" gets discovered later. A random
   * 48-byte secret nobody ever learns cannot be guessed or reused.
   */
  const password = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        // WhatsApp's profile name, when the bot forwards it. It ends up on
        // invoices, so "WhatsApp Customer" is a poor default and the rider
        // should be able to correct it later in the app.
        name: (profileName || '').trim().slice(0, 120) || 'WhatsApp Customer',
        email,
        phone,
        password,
        role: 'USER',
      },
      select: { id: true, name: true, role: true, isActive: true, email: true },
    });

    await tx.customer.create({ data: { userId: created.id } });
    return created;
  });

  return { user, created: true };
}

/** True for an account that has never given us a real email address. */
function isPlaceholderEmail(email) {
  return typeof email === 'string' && email.endsWith('@whatsapp.invalid');
}

/**
 * Exchange a verified phone number for a customer access token.
 *
 * NO refresh token is issued, deliberately. A refresh token is a long-lived
 * credential for a device the customer controls; the bot is a server, and if
 * its session expires mid-conversation it can simply exchange the key again.
 * Handing out a long-lived credential per conversation would leave a trail of
 * them with nothing to revoke them.
 */
async function startWhatsAppSession({ phone, profileName }, meta = {}) {
  const normalised = normalisePhone(phone);
  const { user, created } = await resolveCustomerByPhone(normalised, profileName);

  const accessToken = tokens.signAccessToken({ userId: user.id, role: user.role });

  audit.recordAsync({
    actor: { id: user.id, role: user.role },
    action: created ? 'WHATSAPP_CUSTOMER_CREATED' : 'WHATSAPP_SESSION_STARTED',
    entityType: 'user',
    entityId: user.id,
    after: { phone: normalised, created },
    meta: { ...meta, channel: 'whatsapp' },
  });

  return {
    accessToken,
    // The bot needs this to know when to exchange again mid-conversation.
    expiresIn: 15 * 60,
    customer: {
      id: user.id,
      name: user.name,
      phone: normalised,
      // Lets the bot ask for an email before a trip that needs an invoice,
      // instead of the placeholder silently ending up on a GST document.
      needsEmail: isPlaceholderEmail(user.email),
      isNew: created,
    },
  };
}

module.exports = {
  startWhatsAppSession,
  resolveCustomerByPhone,
  normalisePhone,
  isPlaceholderEmail,
};