'use strict';
/**
 * WhatsApp's 24-hour customer-service window.
 *
 * A business may send FREE TEXT only within 24 hours of the customer's last
 * message. Outside that window WhatsApp refuses it — but MSG91 (and Meta's
 * send API) still answer "accepted", and the refusal arrives later as a
 * delivery failure (Meta error 131047). So a "Booking confirmed" or
 * "Driver assigned" message for a trip booked yesterday looked sent in our
 * logs and never reached the customer.
 *
 * deliver() picks the right kind of message:
 *   inside the window  -> plain text (any wording)
 *   outside the window -> the approved template, if one is configured
 *   otherwise          -> nothing is sent, and the reason is returned + logged
 */
const env = require('../config/env');
const { logger } = require('../config/logger');
const { sendText } = require('../integrations/whatsapp/messageBuilder');
const { sendTemplateParams } = require('../integrations/whatsapp/client');

const WINDOW_MS = 23 * 60 * 60 * 1000; // a safe margin inside WhatsApp's 24 hours

function inServiceWindow(lastMessageAt, now = Date.now()) {
  if (!lastMessageAt) return false;
  const t = new Date(lastMessageAt).getTime();
  return Number.isFinite(t) && now - t < WINDOW_MS;
}

/**
 * @param {object} o
 * @param {string} o.to            WhatsApp number, digits with country code
 * @param {Date|string} o.lastMessageAt  when the customer last wrote to us
 * @param {string} o.text          the free-text version
 * @param {string} [o.template]    approved template name for outside the window
 * @param {string[]} [o.params]    template body variables, in order
 * @param {string} [o.what]        label for the log
 * @returns {Promise<{ sent: boolean, via?: 'text'|'template', reason?: string, data?: any }>}
 */
async function deliver({ to, lastMessageAt, text, template, params = [], what = 'message' }) {
  if (inServiceWindow(lastMessageAt)) {
    const data = await sendText(to, text);
    return { sent: true, via: 'text', data };
  }
  if (template) {
    const data = await sendTemplateParams({
      to,
      name: template,
      params,
      languageCode: env.TEMPLATE_LANGUAGE || 'en',
      namespace: env.TEMPLATE_NAMESPACE || env.FLOW_TEMPLATE_NAMESPACE || undefined,
    });
    return { sent: true, via: 'template', data };
  }
  logger.warn(
    { to: `…${String(to).slice(-4)}`, what },
    '[whatsapp] NOT sent: the customer last wrote more than 24 hours ago and no approved template is set for this message'
  );
  return { sent: false, reason: 'OUTSIDE_24H_WINDOW' };
}

module.exports = { inServiceWindow, deliver, WINDOW_MS };
