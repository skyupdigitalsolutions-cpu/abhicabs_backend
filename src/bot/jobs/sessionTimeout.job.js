const dayjs = require('dayjs');
const env = require('../config/env');
const { logger } = require('../config/logger');
const { getPrisma } = require('../config/db');
const { wrapSession } = require('../conversation/sessionRecord');
const { STATES } = require('../conversation/states');

/**
 * Runs periodically: any session idle past SESSION_TIMEOUT_MINUTES
 * that still has an in-progress booking draft (vehicle+fare selected
 * but not yet confirmed) is snapshotted into AbandonedBooking for the
 * follow-up job, then flipped to SESSION_EXPIRED so the next inbound
 * message shows a "continue or start new" prompt rather than silently
 * losing context. Bookings/payments already created are never touched.
 *
 * Also opportunistically prunes old ProcessedMessage rows (Postgres has
 * no native TTL index the way MongoDB did, so this replaces that).
 */
async function runSessionTimeoutSweep() {
  const prisma = getPrisma();
  const cutoff = dayjs().subtract(env.SESSION_TIMEOUT_MINUTES, 'minute').toDate();

  const idleRows = await prisma.whatsappSession.findMany({
    where: {
      lastMessageAt: { lt: cutoff },
      state: { notIn: [STATES.MAIN_MENU, STATES.LANGUAGE_SELECTION, STATES.SESSION_EXPIRED, STATES.HUMAN_HANDOFF] },
    },
  });

  for (const row of idleRows) {
    const session = wrapSession(row);
    const hasFareSelected = session.state === STATES.BOOKING_FARE_CONFIRMATION || session.draft?.fare;

    if (hasFareSelected && session.draft?.pickup?.address) {
      // eslint-disable-next-line no-await-in-loop
      const alreadySnapshotted = await prisma.whatsappAbandonedBooking.findFirst({
        where: { sessionId: session.id, recovered: false },
      });
      if (!alreadySnapshotted) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.whatsappAbandonedBooking.create({
          data: {
            whatsappNumber: session.whatsappNumber,
            sessionId: session.id,
            snapshot: session.draft,
          },
        });
      }
    }

    session.previousState = session.state;
    session.state = STATES.SESSION_EXPIRED;
    // eslint-disable-next-line no-await-in-loop
    await session.save();
  }

  if (idleRows.length) {
    logger.info({ count: idleRows.length }, '[job:sessionTimeout] expired idle sessions');
  }

  // Prune ProcessedMessage rows older than 30 days (replaces Mongo's TTL index).
  const thirtyDaysAgo = dayjs().subtract(30, 'day').toDate();
  const { count } = await prisma.whatsappProcessedMessage.deleteMany({
    where: { processedAt: { lt: thirtyDaysAgo } },
  });
  if (count) {
    logger.info({ count }, '[job:sessionTimeout] pruned old processed-message records');
  }
}

module.exports = { runSessionTimeoutSweep };
