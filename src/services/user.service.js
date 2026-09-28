'use strict';

/**
 * src/services/user.service.js
 *
 * CRUD over users. Used by both the self-service routes and the admin routes;
 * the difference is which middleware guards them, not the logic itself.
 */

const bcrypt = require('bcryptjs');
const { prisma, isUniqueViolation, isNotFound } = require('../config/prisma');
const { ApiError, publicUser, paginated } = require('../utils/helpers');

const { SAFE_SELECT } = require('../models/user.model');
const { PRIVILEGED_ROLES } = require('../validators/schemas');

const BCRYPT_ROUNDS = 12;

/* ---------------------------------------------------------------- *
 * READ
 * ---------------------------------------------------------------- */

async function findById(id) {
  const user = await prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

async function list({ page, limit, search, role, isActive, sortBy, order }) {
  const where = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (role) where.role = role;
  if (typeof isActive === 'boolean') where.isActive = isActive;

  // Run count and page in parallel — one round trip's worth of latency
  // instead of two.
  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: SAFE_SELECT,
      orderBy: { [sortBy]: order },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return paginated(items, { page, limit, total });
}

/* ---------------------------------------------------------------- *
 * CREATE  (admin only)
 * ---------------------------------------------------------------- */

async function create({ name, email, password, phone, role, isActive }, actor) {
  // Creating a staff account is a privilege grant, not a sign-up.
  //
  // USER_MANAGE is ADMIN-only in today's seed, so this is defence in depth —
  // but role_permissions is data, and the day someone grants USER_MANAGE to
  // OPS so they can add customers, that role must not also be able to mint
  // itself a FINANCE account with payment access. The guard belongs next to
  // the write, where it cannot be separated from it by a config change.
  if (PRIVILEGED_ROLES.includes(role) && actor?.role !== 'ADMIN') {
    throw ApiError.forbidden(
      `Only an admin can create a ${role} account`,
      'ROLE_ESCALATION_DENIED',
    );
  }

  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        phone: phone || null,
        role,
        isActive,
      },
      select: SAFE_SELECT,
    });
    return user;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');
    }
    throw err;
  }
}

/* ---------------------------------------------------------------- *
 * UPDATE
 * ---------------------------------------------------------------- */

/**
 * @param {object} data       already whitelisted by the zod schema
 * @param {object} actor      the authenticated user making the change
 */
async function update(id, data, actor) {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw ApiError.notFound('User not found');

  const patch = { ...data };

  // A non-admin can never change their own role or activation status, even if
  // those fields somehow reach here.
  if (actor.role !== 'ADMIN') {
    delete patch.role;
    delete patch.isActive;
    delete patch.email; // email changes go through a verification flow
  }

  // Guard rails so an admin cannot lock everyone out by accident.
  if (actor.role === 'ADMIN' && actor.id === id) {
    if (patch.role && patch.role !== 'ADMIN') {
      throw ApiError.badRequest('You cannot remove your own admin role', 'SELF_DEMOTION');
    }
    if (patch.isActive === false) {
      throw ApiError.badRequest('You cannot deactivate your own account', 'SELF_DEACTIVATION');
    }
  }

  // Same escalation guard as create(): promoting someone into a staff role is
  // a privilege grant. Non-admins already had `role` stripped above; this
  // catches the case where USER_MANAGE has been widened beyond ADMIN.
  if (patch.role && PRIVILEGED_ROLES.includes(patch.role) && actor.role !== 'ADMIN') {
    throw ApiError.forbidden(
      `Only an admin can grant the ${patch.role} role`,
      'ROLE_ESCALATION_DENIED',
    );
  }

  if (patch.role && patch.role !== 'ADMIN' && target.role === 'ADMIN') {
    await assertNotLastAdmin(id);
  }

  if (patch.password) {
    patch.password = await bcrypt.hash(patch.password, BCRYPT_ROUNDS);
  }

  try {
    return await prisma.user.update({ where: { id }, data: patch, select: SAFE_SELECT });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('That email is already in use', 'EMAIL_TAKEN');
    }
    if (isNotFound(err)) throw ApiError.notFound('User not found');
    throw err;
  }
}

/* ---------------------------------------------------------------- *
 * DELETE
 * ---------------------------------------------------------------- */

/**
 * Close an account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT ALWAYS A ROW DELETE
 * ---------------------------------------------------------------------------
 * It used to be `prisma.user.delete`, which threw a foreign-key error — and a
 * 500 — for anyone who had ever booked. Booking.customer is onDelete: Restrict,
 * so Postgres refuses to remove a customer that bookings point at. Accounts
 * with no bookings deleted fine, which is why it looked like it worked.
 *
 * Restrict is RIGHT, and loosening it would be the wrong fix. The delete screen
 * promises "completed trips keep their invoices, which we are required to
 * retain for tax purposes" — a GST invoice must stay intact and must keep
 * referring to a real counterparty. You cannot both erase the customer and
 * retain a compliant invoice trail.
 *
 * So there are two outcomes, and which one applies depends only on whether
 * there is anything the law requires us to keep:
 *
 *   NO history at all      -> the row really is deleted. Nothing to retain, so
 *                             nothing is kept.
 *   Any booking or ledger  -> the identity is destroyed and the rows stay. Name,
 *     entry                  email and phone are overwritten with values that
 *                             cannot be reversed to the originals, the password
 *                             is replaced with an unusable hash, sessions are
 *                             revoked, and addresses and device tokens are
 *                             deleted outright.
 *
 * In both cases the person can never sign in again and no readable personal
 * data about them remains. That is what the screen promises, and now it is
 * what happens.
 *
 * WHY THE PLACEHOLDERS LOOK LIKE THEY DO
 * email and phone are UNIQUE, so they cannot simply be blanked — two closed
 * accounts would collide on NULL-less uniqueness or on the same literal. The id
 * is already unique and is not personal data on its own, so it seeds both.
 */
async function remove(id, actor) {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw ApiError.notFound('User not found');

  if (actor.id === id && actor.role === 'ADMIN') {
    throw ApiError.badRequest('You cannot delete your own admin account', 'SELF_DELETE');
  }
  if (target.role === 'ADMIN') await assertNotLastAdmin(id);

  /*
   * A trip that is still running cannot be abandoned: a driver is en route, or
   * a car is occupied, and money may still be owed in either direction.
   * Refused with a message the rider can act on rather than a foreign-key
   * error they cannot.
   */
  const liveBooking = await prisma.booking.findFirst({
    where: {
      customerId: id,
      status: {
        in: ['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE', 'REACHED', 'ONGOING', 'ARRIVED'],
      },
    },
    select: { bookingNumber: true, status: true },
  });

  if (liveBooking) {
    throw ApiError.badRequest(
      `You have a trip in progress (${liveBooking.bookingNumber}). Complete or cancel it before closing your account.`,
      'ACTIVE_BOOKING'
    );
  }

  const [bookingCount, ledgerCount] = await Promise.all([
    prisma.booking.count({ where: { customerId: id } }),
    prisma.ledgerEntry.count({ where: { userId: id } }),
  ]);

  const mustRetain = bookingCount > 0 || ledgerCount > 0;

  return prisma.$transaction(async (tx) => {
    // Sessions die first, in both paths. Doing it inside the transaction means
    // an account cannot end up scrubbed but still signed in somewhere.
    await tx.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Not personal history — just settings and routing. Removed outright in
    // both paths, which is what "saved addresses and notification settings are
    // removed" on the delete screen means.
    await tx.deviceToken.deleteMany({ where: { userId: id } });
    await tx.address.deleteMany({ where: { customerId: id } });

    if (!mustRetain) {
      // Nothing to keep. Cascades take refresh tokens and the customer row.
      await tx.user.delete({ where: { id } });
      return { message: 'Account deleted', id, retained: false };
    }

    const tag = id.replace(/-/g, '').slice(0, 12);

    await tx.user.update({
      where: { id },
      data: {
        name: 'Deleted user',
        email: `deleted+${tag}@deleted.invalid`,
        phone: null,
        // A bcrypt-shaped string that no password can produce, so the row can
        // never authenticate even if isActive were flipped back by mistake.
        password: `!deleted!${tag}`,
        isActive: false,
      },
    });

    // The customer record carries its own contact details and a GSTIN.
    await tx.customer.updateMany({
      where: { userId: id },
      data: { alternatePhone: null, gstin: null },
    });

    /*
     * Guest contact on past bookings is a THIRD party's data — someone the
     * account holder booked for, who never agreed to our retaining their
     * number. Cleared with the account.
     */
    await tx.booking.updateMany({
      where: { customerId: id },
      data: { guestName: null, guestPhone: null, guestEmail: null },
    });

    return { message: 'Account closed', id, retained: true };
  });
}

/** Soft alternative to deletion — preserves history, blocks access. */
async function setActive(id, isActive, actor) {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw ApiError.notFound('User not found');

  if (actor.id === id && !isActive) {
    throw ApiError.badRequest('You cannot deactivate your own account', 'SELF_DEACTIVATION');
  }
  if (!isActive && target.role === 'ADMIN') await assertNotLastAdmin(id);

  const user = await prisma.user.update({
    where: { id },
    data: { isActive },
    select: SAFE_SELECT,
  });

  // Deactivating must also kill live sessions, or the user keeps working until
  // their access token expires.
  if (!isActive) {
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return user;
}

/* ---------------------------------------------------------------- *
 * Guards
 * ---------------------------------------------------------------- */

/** Prevents the system ending up with zero usable admins. */
async function assertNotLastAdmin(excludingId) {
  const remaining = await prisma.user.count({
    where: { role: 'ADMIN', isActive: true, id: { not: excludingId } },
  });
  if (remaining === 0) {
    throw ApiError.badRequest('At least one active admin must remain', 'LAST_ADMIN');
  }
}

async function stats() {
  const [total, admins, active, recent] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: 'ADMIN' } }),
    prisma.user.count({ where: { isActive: true } }),
    prisma.user.count({
      where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    }),
  ]);
  return { total, admins, users: total - admins, active, inactive: total - active, newLast7Days: recent };
}

module.exports = {
  SAFE_SELECT,
  findById,
  list,
  create,
  update,
  remove,
  setActive,
  stats,
  publicUser,
};