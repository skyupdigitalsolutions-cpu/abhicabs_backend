'use strict';
/**
 * The WhatsApp bot, running INSIDE the website backend.
 * Same process, same Prisma client, same tables as the website and mobile apps.
 */
const express = require('express');
const webhookRoutes = require('./routes/webhook.routes');
const adminRoutes = require('./routes/admin.routes');
const calendarRoutes = require('./routes/calendar.routes');
const placeRoutes = require('./routes/place.routes');
const placeMapRoutes = require('./routes/placeMap.routes');
const routeMapRoutes = require('./routes/routeMap.routes');
const { logger } = require('./config/logger');

function router() {
  const r = express.Router();
  r.use('/webhook', webhookRoutes);        // POST /webhook/whatsapp   <- MSG91
  r.use('/bot-admin', adminRoutes);        // stats, handoffs, WhatsApp support requests
  r.use('/calendar', calendarRoutes);      // date picker page opened from WhatsApp
  r.use('/route-map', routeMapRoutes);     // route / place picker page opened from WhatsApp
  r.use('/place', placeRoutes);            // place search page opened from WhatsApp
  r.use('/place-map', placeMapRoutes);     // map + search bar page opened from WhatsApp
  return r;
}

let started = false;
function start() {
  if (started || process.env.BOT_ENABLED === 'false') return;
  started = true;
  require('./notifications').start();
  require('./jobs').startJobs();
  logger.info('[bot] WhatsApp bot started inside the backend');
}
function stop() {
  if (!started) return;
  require('./jobs').stopJobs();
}

module.exports = { router, start, stop };
