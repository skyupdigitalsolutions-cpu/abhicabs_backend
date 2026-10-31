const cron = require('node-cron');
const { logger } = require('../config/logger');
const { runSessionTimeoutSweep } = require('./sessionTimeout.job');
const { sendAbandonedBookingFollowUps } = require('./abandonedBooking.job');
const { sendBookingReminders } = require('./bookingReminder.job');

const scheduled = [];

function startJobs() {
  // Every 5 minutes: expire idle sessions safely.
  scheduled.push(
    cron.schedule('*/5 * * * *', () => {
      runSessionTimeoutSweep().catch((err) =>
        logger.error({ err: err.message }, '[jobs] sessionTimeout sweep failed')
      );
    })
  );

  // Every 10 minutes: send abandoned-booking template follow-ups.
  scheduled.push(
    cron.schedule('*/10 * * * *', () => {
      sendAbandonedBookingFollowUps().catch((err) =>
        logger.error({ err: err.message }, '[jobs] abandonedBooking sweep failed')
      );
    })
  );

  // Every minute: trip reminders, one hour and 30 minutes before the pickup.
  scheduled.push(
    cron.schedule('* * * * *', () => {
      sendBookingReminders().catch((err) =>
        logger.error({ err: err.message }, '[jobs] booking reminders failed')
      );
    })
  );

  logger.info('[jobs] scheduled background jobs started');
}

function stopJobs() {
  scheduled.forEach((task) => task.stop());
}

module.exports = { startJobs, stopJobs };
