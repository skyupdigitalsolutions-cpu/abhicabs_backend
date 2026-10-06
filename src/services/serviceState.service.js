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

/**
 * Write the built-in four, but ONLY if the table has never been written to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS HAS TO HAPPEN BEFORE THE FIRST create()
 * ---------------------------------------------------------------------------
 * `serviceArea.load()` uses the table when it has active rows and BUILT_IN
 * when it does not. Nothing seeds the table — the migration creates it empty
 * and `prisma db seed` never touches it — so on a live deployment the
 * allowlist is usually the four built-ins, held implicitly, with zero rows
 * behind them.
 *
 * That makes the first INSERT a cliff edge. An admin opening a fifth state
 * writes one row; `rows.length > 0` flips true; and the allowlist becomes that
 * ONE state. Karnataka, Telangana, Andhra Pradesh and Maharashtra all vanish
 * in the same instant, every pickup in them starts failing
 * OUTSIDE_SERVICE_STATES, and each one quietly becomes a booking request. A
 * routine settings change takes the existing business offline, and the admin
 * who made it has no reason to connect the two.
 *
 * `seedDefaults` exists to prevent exactly this, but only if someone knows to
 * call it first — and the one person who needs to know is the one who has just
 * been handed a form with an "Add state" button on it.
 *
 * So the implicit four are materialised at the moment they would otherwise be
 * dropped. After this, what the table says and what the engine does are the
 * same thing, which is the property the cliff edge was violating.
 *
 * Closing a built-in state stays possible — it is now a deliberate
 * `deactivate` on a visible row rather than a side effect of adding a
 * different one.
 */
async function materialiseBuiltIns(actor, exceptName) {
  // Counts EVERY row, not just active ones: the question is whether the table
  // has ever been written to, not whether anything is currently open.
  const total = await prisma.serviceState.count();
  if (total > 0) return [];

  const skip = serviceArea.normalise(exceptName);

  return serviceArea.BUILT_IN
    // The incoming state is about to be inserted by the caller. Writing it here
    // too would collide on the unique name — which is the likely case when the
    // very first state an admin adds is one of the four.
    .filter((def) => serviceArea.normalise(def.name) !== skip)
    .map((def) => ({
      name: def.name,
      aliases: cleanAliases(def.aliases),
      isActive: true,
      note: 'Recorded automatically — in service before the allowlist had rows',
      createdById: actor?.id || null,
    }));
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

  const backfill = await materialiseBuiltIns(actor, name);

  const data = {
    name,
    code: input.code ? String(input.code).trim().toUpperCase() : null,
    aliases: cleanAliases(input.aliases),
    isActive: input.isActive ?? true,
    note: input.note || null,
    createdById: actor?.id || null,
  };

  /*
   * One transaction. If the backfill landed and the new state did not, the
   * allowlist would be the four built-ins — correct, but the admin would see
   * an error and retry, and the second attempt would find a non-empty table
   * and skip the backfill. Harmless here, but the two writes describe a single
   * decision and should not be separable.
   */
  const [, state] = await prisma.$transaction([
    prisma.serviceState.createMany({ data: backfill, skipDuplicates: true }),
    prisma.serviceState.create({ data }),
  ]);

  serviceArea.invalidate();
  return { state, backfilled: backfill.map((r) => r.name) };
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