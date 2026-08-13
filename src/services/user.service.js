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

async function create({ name, email, password, phone, role, isActive }) {
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

async function remove(id, actor) {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw ApiError.notFound('User not found');

  if (actor.id === id && actor.role === 'ADMIN') {
    throw ApiError.badRequest('You cannot delete your own admin account', 'SELF_DELETE');
  }
  if (target.role === 'ADMIN') await assertNotLastAdmin(id);

  // Cascade removes the user's refresh tokens, so their sessions die with the
  // account.
  await prisma.user.delete({ where: { id } });
  return { message: 'User deleted', id };
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