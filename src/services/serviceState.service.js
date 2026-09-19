'use strict';

/**
 * src/services/serviceState.service.js
 *
 * Admin management of the state allowlist. See src/lib/serviceArea.js for why
 * the list is a table and how it is cached.
 *
 * Every write invalidates that cache, so a state opened at 11:00 is live on the
 * next quote rather than up to a TTL later. Without it an admin would add a
 * state, test it, see it refused, and reasonably conclude the feature is broken.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const serviceArea = require('../lib/serviceArea');

/**
 * Aliases are stored NORMALISED — lower-case, no spaces or punctuation —
 * because that is how they are compared. Storing "Andhra Pr." and normalising
 * on every read would do the same work on every quote instead of once here.
 */
function cleanAliases(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const raw of list) {
    const a = serviceArea.normalise(raw);
    if (a) seen.add(a);
  }
  return [...seen];
}

async function list({ includeInactive = false } = {}) {
  const states = await prisma.serviceState.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  return { states, total: states.length };
}

async function create(input, actor) {
  const name = String(input.name).trim();

  const existing = await prisma.serviceState.findUnique({ where: { name } });
  if (existing) {
    throw ApiError.badRequest(
      `${name} is already on the list${existing.isActive ? '' : ' (currently inactive — reactivate it instead)'}`,
      'STATE_EXISTS',
    );
  }

  const state = await prisma.serviceState.create({
    data: {
      name,
      code: input.code ? String(input.code).trim().toUpperCase() : null,
      aliases: cleanAliases(input.aliases),
      isActive: input.isActive ?? true,
      note: input.note || null,
      createdById: actor?.id || null,
    },
  });

  serviceArea.invalidate();
  return state;
}

async function update(id, input) {
  const existing = await prisma.serviceState.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('State not found', 'STATE_NOT_FOUND');

  const state = await prisma.serviceState.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: String(input.name).trim() } : {}),
      ...(input.code !== undefined
        ? { code: input.code ? String(input.code).trim().toUpperCase() : null }
        : {}),
      ...(input.aliases !== undefined ? { aliases: cleanAliases(input.aliases) } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.note !== undefined ? { note: input.note || null } : {}),
    },
  });

  serviceArea.invalidate();
  return state;
}

/**
 * Deactivates. Never deletes.
 *
 * Closing a state does not undo the trips and requests it produced, and a row
 * that vanishes takes the explanation with it. Deactivating also leaves the
 * aliases in place, so reopening is one flag rather than re-entering them.
 *
 * Refuses to remove the LAST active state: an empty allowlist turns every
 * booking in the country into an out-of-area request, which is an outage
 * wearing the clothes of a configuration change.
 */
async function deactivate(id) {
  const existing = await prisma.serviceState.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('State not found', 'STATE_NOT_FOUND');

  if (existing.isActive) {
    const activeCount = await prisma.serviceState.count({ where: { isActive: true } });
    if (activeCount <= 1) {
      throw ApiError.badRequest(
        'Cannot deactivate the last remaining state — every booking would be refused',
        'LAST_ACTIVE_STATE',
      );
    }
  }

  const state = await prisma.serviceState.update({
    where: { id },
    data: { isActive: false },
  });

  serviceArea.invalidate();
  return state;
}

/**
 * Writes the built-in four, skipping any that already exist.
 *
 * Idempotent, so it is safe to run on every deploy. Exposed as an endpoint
 * rather than left to a seed script because the table has to be populated on an
 * existing production database, where `prisma db seed` is not something you run
 * casually.
 */
async function seedDefaults(actor) {
  const created = [];

  for (const def of serviceArea.BUILT_IN) {
    const existing = await prisma.serviceState.findUnique({ where: { name: def.name } });
    if (existing) continue;

    created.push(
      await prisma.serviceState.create({
        data: {
          name: def.name,
          aliases: cleanAliases(def.aliases),
          isActive: true,
          note: 'Seeded default',
          createdById: actor?.id || null,
        },
      }),
    );
  }

  serviceArea.invalidate();
  return { created, skipped: serviceArea.BUILT_IN.length - created.length };
}

module.exports = { list, create, update, deactivate, seedDefaults };