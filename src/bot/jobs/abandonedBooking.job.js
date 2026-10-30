const dayjs = require('dayjs');
const env = require('../config/env');
const { logger } = require('../config/logger');
const { getPrisma } = require('../config/db');
const { sendMessage } = require('../integrations/whatsapp/client');

/**
 * Sends a follow-up ONLY via an approved WhatsApp message template
 * (spec section 44) — never free-form text — because these customers
 * are outside the 24-hour customer-service messaging window by the
 * time this fires. Replace 'abandoned_booking_followup' with the
 * exact template name approved for your WhatsApp Business number
 * before go-live.
 */
async function sendAbandonedBookingFollowUps() {
  const prisma = getPrisma();
  const cutoff = dayjs().subtract(env.ABANDONED_BOOKING_FOLLOWUP_MINUTES, 'minute').toDate();

  const pending = await prisma.whatsappAbandonedBooking.findMany({
    where: {
      followUpSentAt: null,
      recovered: false,
      abandonedAt: { lt: cutoff },
    },
    take: 100,
  });

  for (const record of pending) {
    const { pickup, drop } = record.snapshot || {};
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendMessage({
        to: record.whatsappNumber,
        type: 'template',
        template: {
          name: 'abandoned_booking_followup',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: pickup?.address || 'your pickup' },
                { type: 'text', text: drop?.address || 'your destination' },
              ],
            },
          ],
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await prisma.whatsappAbandonedBooking.update({
        where: { id: record.id },
        data: { followUpSentAt: new Date() },
      });
    } catch (err) {
      logger.error(
        { err: err.message, whatsappNumber: record.whatsappNumber },
        '[job:abandonedBooking] follow-up send failed'
      );
    }
  }

  if (pending.length) {
    logger.info({ count: pending.length }, '[job:abandonedBooking] follow-ups sent');
  }
}

module.exports = { sendAbandonedBookingFollowUps };
