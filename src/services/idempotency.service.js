'use strict';

/**
 * src/services/idempotency.service.js
 *
 * Makes a repeated request safe.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * A customer taps Book. Their phone drops signal for four seconds. The app
 * retries. Without protection the server now creates a SECOND booking, holds a
 * second vehicle, and charges a second advance — and the customer sees one
 * confirmation and has no idea.
 *
 * ---------------------------------------------------------------------------
 * WHY "CLAIM BEFORE ACTING" AND NOT "CHECK THEN ACT"
 * ---------------------------------------------------------------------------
 * The obvious implementation is:
 *
 *     const existing = await findKey(key);      // <-- gap
 *     if (existing) return existing.response;
 *     await doTheWork();
 *
 * Two simultaneous retries both reach the findKey line, both find nothing, and
 * both proceed. The check does not prevent the thing it exists to prevent,
 * because there is a window between reading and writing.
 *
 * Instead we INSERT first and catch the unique violation. The database
 * serialises that insert, so exactly one caller wins. There is no window.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RESPONSE BODY IS STORED
 * ---------------------------------------------------------------------------
 * The step most implementations skip. When a client times out it genuinely does
 * not know whether the booking succeeded. Replaying the ORIGINAL response —
 * same booking number, same status — tells it the truth. Returning an error
 * instead would make the user book again, manufacturing the duplicate we were
 * trying to prevent.
 */

const crypto = require('crypto');
const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');

/** How long a key is honoured. Long enough for any realistic retry. */
const TTL_HOURS = Number(process.env.IDEMPOTENCY_TTL_HOURS || 24);

/**
 * An IN_FLIGHT key older than this is treated as abandoned — the process that
 * claimed it probably crashed. Without this a single crash would block that key
 * forever, and the customer could never complete the booking.
 */
const STALE_MINUTES = Number(process.env.IDEMPOTENCY_STALE_MINUTES || 2);

const hashBody = (body) =>
  crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');

/* ------------------------------------------------------------------ *
 * Claim
 * ------------------------------------------------------------------ */

/**
 * Attempts to claim a key.
 *
 * @returns {Promise<object>} one of:
 *   { outcome: 'CLAIMED' }                      caller should do the work
 *   { outcome: 'REPLAY', statusCode, body }     already done — return this
 *   { outcome: 'IN_FLIGHT' }                    another request is mid-flight
 */
async function claim({ key, userId, endpoint, requestBody }) {
  const requestHash = hashBody(requestBody);
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

  try {
    // INSERT FIRST. If two requests race, the database picks the winner.
    await prisma.idempotencyKey.create({
      data: { key, userId: userId || null, endpoint, requestHash, status: 'IN_FLIGHT', expiresAt },
    });
    return { outcome: 'CLAIMED' };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  // Someone else holds the key. Work out what to tell this caller.
  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });

  // Expired between the insert attempt and this read — extremely rare.
  if (!existing) return { outcome: 'CLAIMED' };

  // SAME KEY, DIFFERENT BODY.
  // Either a client bug reusing keys, or someone replaying a key to launder a
  // different transaction. Reject loudly rather than silently replaying an
  // answer that belongs to a different request.
  if (existing.requestHash !== requestHash) {
    throw ApiError.conflict(
      'This Idempotency-Key was already used with a different request body',
      'IDEMPOTENCY_KEY_REUSED'
    );
  }

  if (existing.status === 'COMPLETED') {
    return {
      outcome: 'REPLAY',
      statusCode: existing.responseCode || 200,
      body: existing.responseBody,
    };
  }

  if (existing.status === 'FAILED') {
    // The original attempt failed, so let this one try again. Reclaim the key.
    await prisma.idempotencyKey.update({
      where: { key },
      data: { status: 'IN_FLIGHT', responseCode: null, responseBody: null },
    });
    return { outcome: 'CLAIMED' };
  }

  // Still IN_FLIGHT.
  const ageMs = Date.now() - new Date(existing.createdAt).getTime();
  if (ageMs > STALE_MINUTES * 60 * 1000) {
    // The claiming process almost certainly died. Take it over.
    await prisma.idempotencyKey.update({
      where: { key },
      data: { status: 'IN_FLIGHT', createdAt: new Date() },
    });
    return { outcome: 'CLAIMED' };
  }

  return { outcome: 'IN_FLIGHT' };
}

/* ------------------------------------------------------------------ *
 * Complete / fail
 * ------------------------------------------------------------------ */

/**
 * Records the response so a later retry can be answered identically.
 *
 * Never throws: the work already succeeded, and failing to write the
 * bookkeeping row must not turn a successful booking into an error response.
 */
async function complete(key, statusCode, body) {
  try {
    await prisma.idempotencyKey.update({
      where: { key },
      data: { status: 'COMPLETED', responseCode: statusCode, responseBody: body },
    });
  } catch (err) {
    console.error(`[idempotency] could not record completion for ${key}:`, err.message);
  }
}

/** Marks a key failed so a retry is allowed to try again. */
async function fail(key) {
  try {
    await prisma.idempotencyKey.update({ where: { key }, data: { status: 'FAILED' } });
  } catch (err) {
    console.error(`[idempotency] could not mark ${key} failed:`, err.message);
  }
}

/** Housekeeping — schedule on Day 12. */
async function pruneExpired() {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

module.exports = { claim, complete, fail, pruneExpired, hashBody, TTL_HOURS, STALE_MINUTES };