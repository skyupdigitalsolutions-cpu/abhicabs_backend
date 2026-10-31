'use strict';
const { prisma } = require('../../config/prisma');
const { resolveCustomerByPhone, normalisePhone } = require('../../services/serviceSession.service');
const { wrapCustomer } = require('./customerRecord');

/**
 * Finds (or creates) the customer for a WhatsApp number in the website's own
 * users + customers tables. Uses the backend's resolver so the rules are the
 * same as everywhere else: one account per phone, staff / driver / deactivated
 * accounts are refused, a new account gets a placeholder email and an
 * unusable password.
 *
 * A short cache keeps a chatty conversation from paying 2-3 queries per message.
 */
const TTL_MS = 60 * 1000;
const cache = new Map();

async function loadCustomer(whatsappNumber, profileName) {
  const hit = cache.get(whatsappNumber);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.customer;

  const { user } = await resolveCustomerByPhone(normalisePhone(whatsappNumber), profileName);
  const full = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, email: true } });
  const customerRow = await prisma.customer.findUnique({ where: { userId: user.id } });
  const customer = wrapCustomer(full, customerRow, whatsappNumber);
  cache.set(whatsappNumber, { at: Date.now(), customer });
  return customer;
}

/** Call after the customer's own record changed (name, GST...) so the next message sees it. */
function forget(whatsappNumber) { cache.delete(whatsappNumber); }

module.exports = { loadCustomer, forget };
