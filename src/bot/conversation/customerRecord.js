'use strict';
const { prisma } = require('../../config/prisma');

/**
 * The WhatsApp customer, backed by the website's own `users` + `customers`
 * rows (found by phone). Keeps the small interface the handlers already use
 * (customer._id, name, customerType, companyName, gstNumber, ...).
 *
 * Bot-only preferences (language, last seen, company name) live in the
 * existing `customers.meta` JSON column under `bot`, so no new table or
 * column is needed.
 */
class CustomerRecord {
  constructor(user, customer, whatsappNumber) {
    this.id = user.id;                       // = users.id = customers.user_id
    this.whatsappNumber = whatsappNumber;
    this.name = user.name;
    this.email = /@whatsapp\.invalid$/.test(user.email || '') ? null : user.email;
    const bot = (customer && customer.meta && customer.meta.bot) || {};
    this.preferredLanguage = bot.language || 'en';
    this.customerType = customer && customer.accountType === 'CORPORATE' ? 'CORPORATE' : 'RETAIL';
    this.companyName = bot.companyName || null;
    this.gstNumber = (customer && customer.gstin) || null;
    this.lastInteractionAt = bot.lastInteractionAt || null;
  }

  get _id() { return this.id; }

  async save() {
    const row = await prisma.customer.findUnique({ where: { userId: this.id }, select: { meta: true } });
    const meta = { ...((row && row.meta) || {}) };
    meta.bot = { ...(meta.bot || {}), language: this.preferredLanguage, companyName: this.companyName, lastInteractionAt: this.lastInteractionAt };
    await prisma.customer.update({
      where: { userId: this.id },
      data: { gstin: this.gstNumber ? String(this.gstNumber).slice(0, 15) : null, meta },
    });
    // Only a real name is written back; the placeholder email is never replaced by a guess.
    if (this.name && this.name !== 'WhatsApp Customer') {
      await prisma.user.update({ where: { id: this.id }, data: { name: String(this.name).slice(0, 120) } });
    }
    return this;
  }
}

function wrapCustomer(user, customer, whatsappNumber) {
  return user ? new CustomerRecord(user, customer, whatsappNumber) : null;
}

module.exports = { CustomerRecord, wrapCustomer };
