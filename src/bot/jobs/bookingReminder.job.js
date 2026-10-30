const env = require('../config/env');
const { logger } = require('../config/logger');
const { getPrisma } = require('../config/db');
const { toBotBooking } = require('../adapters/bookingMapper');
const { sendText } = require('../integrations/whatsapp/messageBuilder');
const { sendTemplate } = require('../integrations/whatsapp/client');
const dayjs = require('dayjs');
const dateParser = require('../conversation/nlu/dateParser'); // also loads the dayjs time zone plugins

/**
 * Trip reminders: one hour and thirty minutes before the pickup time, for CONFIRMED bookings.
 *
 * WhatsApp only lets a business send free text within 24 hours of the customer's last message.
 * Most trips are booked earlier than that, so the reminder then has to be an approved TEMPLATE
 * (REMINDER_1H_TEMPLATE / REMINDER_30M_TEMPLATE, no variables needed). Without a template, a customer who is
 * outside the 24-hour window is skipped and it is written to the log.
 *
 * Each reminder is sent once: it is claimed in the processed-messages table before sending.
 */
// Reminders already claimed by this process: it is checked first so a booking inside its reminder window is not
// claimed again (and logged as a database error) every minute.
const claimed = new Set();

const WINDOW_MS = 23 * 60 * 60 * 1000; // a safe margin inside WhatsApp's 24-hour window

function reminders() {
  return [
    { minutes: 60, label: '1 hour', template: env.REMINDER_1H_TEMPLATE },
    { minutes: 30, label: '30 minutes', template: env.REMINDER_30M_TEMPLATE },
  ];
}

function reminderText(booking, label) {
  const when = dayjs(booking.pickupAt).tz(dateParser.TZ);
  const vehicle = booking.vehicle?.name || booking.vehicle?.vehicleName || null;
  const driver = booking.driver?.name ? `${booking.driver.name}${booking.driver.phone ? `, ${booking.driver.phone}` : ''}` : null;
  return (
    `⏰ Reminder: your ABHI CABS trip starts in ${label}.\n\n` +
    `Booking: ${booking.bookingNumber}\n` +
    `📅 ${when.format('ddd, D MMM YYYY')}\n` +
    `⏰ ${when.format('h:mm A')} (IST)\n` +
    `📍 Pickup: ${booking.pickup?.address || '-'}\n` +
    (booking.drop?.address ? `🏁 Drop: ${booking.drop.address}\n` : '') +
    (vehicle ? `🚗 ${vehicle}\n` : '') +
    (driver ? `👨‍✈️ Driver: ${driver}\n` : '') +
    `\nPlease be ready at your pickup point.` +
    (env.SUPPORT_PHONE ? ` Need help? ${env.SUPPORT_PHONE}` : '')
  );
}

async function sendOne(prisma, siteBooking, reminder, now) {
  const user = await prisma.user.findUnique({ where: { id: siteBooking.customerId }, select: { phone: true } });
  const number = user && user.phone ? String(user.phone).replace(/\D/g, '') : null;
  if (!number) return false;
  const booking = await toBotBooking(siteBooking);

  const key = `reminder:${booking.id}:${reminder.minutes}`;
  if (claimed.has(key)) return false;
  try {
    await prisma.whatsappProcessedMessage.create({ data: { whatsappMessageId: key, whatsappNumber: number } });
    if (claimed.size > 5000) claimed.clear();
    claimed.add(key);
  } catch (err) {
    if (err.code === 'P2002') {
      claimed.add(key); // sent earlier (maybe before a restart): remember it, do not try again
      return false;
    }
    throw err;
  }

  const session = await prisma.whatsappSession.findUnique({ where: { whatsappNumber: number } });
  const inWindow = session && session.lastMessageAt && now - new Date(session.lastMessageAt) < WINDOW_MS;
  try {
    if (inWindow) {
      await sendText(number, reminderText(booking, reminder.label));
    } else if (reminder.template) {
      await sendTemplate({ to: number, name: reminder.template, languageCode: 'en', namespace: env.REMINDER_TEMPLATE_NAMESPACE || env.FLOW_TEMPLATE_NAMESPACE || undefined });
    } else {
      logger.warn({ booking: booking.bookingNumber, reminder: reminder.minutes }, '[reminder] customer is outside the 24-hour window and no reminder template is set: not sent');
      return false;
    }
    logger.info({ booking: booking.bookingNumber, reminder: reminder.minutes, via: inWindow ? 'text' : 'template' }, '[reminder] sent');
    return true;
  } catch (err) {
    // Let the next run try again.
    claimed.delete(key);
    await prisma.whatsappProcessedMessage.deleteMany({ where: { whatsappMessageId: key } }).catch(() => {});
    logger.error({ err: err.message, booking: booking.bookingNumber }, '[reminder] send failed, will retry');
    return false;
  }
}

async function sendBookingReminders(now = new Date()) {
  if (!env.REMINDERS_ENABLED) return 0;
  const prisma = getPrisma();
  const list = reminders();
  const horizon = new Date(now.getTime() + (list[0].minutes + 1) * 60000);

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ['CONFIRMED', 'ALLOCATED', 'EN_ROUTE'] },
      pickupAt: { gte: now, lte: horizon },
      meta: { path: ['source'], equals: 'whatsapp-bot' }, // only trips booked on WhatsApp
    },
    take: 200,
  });

  let sent = 0;
  for (const booking of bookings) {
    const minutesLeft = (new Date(booking.pickupAt) - now) / 60000;
    for (let i = 0; i < list.length; i += 1) {
      const upper = list[i].minutes;
      const lower = list[i + 1] ? list[i + 1].minutes : 0;
      if (minutesLeft <= upper && minutesLeft > lower) {
        // eslint-disable-next-line no-await-in-loop
        if (await sendOne(prisma, booking, list[i], now)) sent += 1;
      }
    }
  }
  return sent;
}

module.exports = { sendBookingReminders, reminderText, _claimed: claimed };
