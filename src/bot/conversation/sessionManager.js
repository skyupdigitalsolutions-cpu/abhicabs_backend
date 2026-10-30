const dayjs = require('dayjs');
const { logger } = require('../config/logger');
const { getPrisma } = require('../config/db');
const { wrapSession } = require('./sessionRecord');
const { wrapCustomer } = require('./customerRecord');
const env = require('../config/env');
const { STATES } = require('./states');

const { loadCustomer } = require('./customerStore');

/** Same purpose as before, but the customer is the website's own users + customers record. */
async function findOrCreateCustomer(whatsappNumber) {
  return loadCustomer(whatsappNumber);
}

async function getOrCreateSession(whatsappNumber) {
  const prisma = getPrisma();
  // The customer and the session are looked up TOGETHER: one database trip instead of two.
  const [customer, sessionRow] = await Promise.all([
    loadCustomer(whatsappNumber),
    prisma.whatsappSession.findUnique({ where: { whatsappNumber } }),
  ]);

  let row = sessionRow;

  if (!row) {
    try {
      row = await prisma.whatsappSession.create({
        data: {
          whatsappNumber,
          customerId: customer.id,
          // No language question: customers start in English on the main menu.
          language: 'en',
          state: STATES.MAIN_MENU,
        },
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err; // created at the same moment by another message
      row = await prisma.whatsappSession.findUnique({ where: { whatsappNumber } });
    }
    const created = wrapSession(row);
    created._touched = true;
    return { session: created, customer, resumed: false, wasExpired: false };
  }

  const session = wrapSession(row);

  const idleMinutes = dayjs().diff(dayjs(session.lastMessageAt), 'minute');
  const hasInProgressDraft = session.state.startsWith('BOOKING_') && session.draft?.tripType;

  const wasExpired =
    idleMinutes > env.SESSION_TIMEOUT_MINUTES &&
    ![STATES.MAIN_MENU, STATES.LANGUAGE_SELECTION, STATES.SESSION_EXPIRED].includes(session.state);

  if (wasExpired && hasInProgressDraft && session.state !== STATES.SESSION_EXPIRED) {
    session.previousState = session.state;
    session.state = STATES.SESSION_EXPIRED;
    await session.save();
  } else if (wasExpired) {
    session.state = session.language ? STATES.MAIN_MENU : STATES.LANGUAGE_SELECTION;
    session.resetDraft();
    await session.save();
  }

  // This message counts as activity: it is saved together with the first change made while answering.
  session.lastMessageAt = new Date();
  session._touched = true;

  return { session, customer, resumed: false, wasExpired };
}

async function touchSession(session) {
  if (!session._touched) session.lastMessageAt = new Date();
  await session.save(); // writes only if something changed since the last write
}

async function transition(session, nextState) {
  session.previousState = session.state;
  session.state = nextState;
  await session.save();
}

module.exports = { getOrCreateSession, touchSession, transition, findOrCreateCustomer };
