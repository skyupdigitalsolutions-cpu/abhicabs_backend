'use strict';

/**
 * src/services/address.service.js
 *
 * Saved pickup and drop locations, one set per customer.
 *
 * Two things this file is careful about:
 *
 *   1. EVERY query is scoped by customerId — never by address id alone. An
 *      address is someone's home; fetching one by id without an ownership check
 *      is the textbook IDOR vulnerability, and a home address is about the
 *      worst thing to leak.
 *
 *   2. Exactly one default per customer, enforced in a transaction. Two
 *      defaults means the booking form picks arbitrarily; zero means it picks
 *      nothing.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const { ADDRESS_SELECT } = require('../models/customer.model');

const MAX_ADDRESSES = Number(process.env.MAX_ADDRESSES_PER_CUSTOMER || 20);

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

async function listForCustomer(customerId) {
  return prisma.address.findMany({
    where: { customerId },
    select: ADDRESS_SELECT,
    // Default first, then most recent — matches how a booking form presents them.
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * Scoped fetch. The customerId is part of the WHERE clause, not checked after
 * the fact — so a mismatched id simply finds nothing.
 *
 * Returns 404 rather than 403 on a miss: a 403 would confirm the address
 * exists and belongs to someone else, which is itself a leak.
 */
async function findForCustomer(id, customerId) {
  const address = await prisma.address.findFirst({
    where: { id, customerId },
    select: ADDRESS_SELECT,
  });
  if (!address) throw ApiError.notFound('Address not found');
  return address;
}

async function getDefault(customerId) {
  return prisma.address.findFirst({
    where: { customerId, isDefault: true },
    select: ADDRESS_SELECT,
  });
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

async function create(customerId, data) {
  const count = await prisma.address.count({ where: { customerId } });
  if (count >= MAX_ADDRESSES) {
    throw ApiError.badRequest(
      `You can save at most ${MAX_ADDRESSES} addresses`,
      'ADDRESS_LIMIT_REACHED'
    );
  }

  // The first address a customer saves becomes their default automatically —
  // otherwise they would have a saved address that the booking form never
  // pre-selects.
  const makeDefault = data.isDefault === true || count === 0;

  return prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.address.updateMany({
        where: { customerId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return tx.address.create({
      data: { ...data, customerId, isDefault: makeDefault },
      select: ADDRESS_SELECT,
    });
  });
}

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

async function update(id, customerId, data) {
  await findForCustomer(id, customerId);   // ownership check

  return prisma.$transaction(async (tx) => {
    if (data.isDefault === true) {
      await tx.address.updateMany({
        where: { customerId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    return tx.address.update({
      where: { id },
      data,
      select: ADDRESS_SELECT,
    });
  });
}

/**
 * Promotes one address to default and demotes the rest, atomically.
 *
 * Done as two statements inside one transaction so there is no instant where a
 * customer has two defaults (or none) visible to a concurrent read.
 */
async function setDefault(id, customerId) {
  await findForCustomer(id, customerId);

  return prisma.$transaction(async (tx) => {
    await tx.address.updateMany({
      where: { customerId, isDefault: true },
      data: { isDefault: false },
    });

    return tx.address.update({
      where: { id },
      data: { isDefault: true },
      select: ADDRESS_SELECT,
    });
  });
}

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

/**
 * Deleting the default promotes the next most recent address, so the customer
 * is never left with saved addresses and no default.
 */
async function remove(id, customerId) {
  const address = await findForCustomer(id, customerId);

  return prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id } });

    if (address.isDefault) {
      const next = await tx.address.findFirst({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (next) {
        await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }

    return { message: 'Address deleted', id, promotedNewDefault: address.isDefault };
  });
}

/* ------------------------------------------------------------------ *
 * Geocoding cache hook — Day 4
 * ------------------------------------------------------------------ */

/**
 * Stores coordinates resolved by the maps provider.
 *
 * Geocoding is a paid API call and the answer never changes for a fixed
 * address, so caching it here means a repeat customer's "Home" pickup costs
 * nothing to resolve on every subsequent booking.
 */
async function setCoordinates(id, customerId, { lat, lng }) {
  await findForCustomer(id, customerId);
  return prisma.address.update({
    where: { id },
    data: { lat, lng },
    select: ADDRESS_SELECT,
  });
}

module.exports = {
  MAX_ADDRESSES,
  listForCustomer,
  findForCustomer,
  getDefault,
  create,
  update,
  setDefault,
  remove,
  setCoordinates,
};