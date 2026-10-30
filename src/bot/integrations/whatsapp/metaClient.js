const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

/**
 * Sends WhatsApp messages straight to Meta's Cloud API (no MSG91 in between), so a message is not held in a provider's queue.
 * Used when WHATSAPP_PROVIDER=meta. The bot already builds its messages in Meta's own format, so the body is the same
 * message with Meta's envelope around it.
 *
 *   POST https://graph.facebook.com/<version>/<phone-number-id>/messages     Authorization: Bearer <token>
 */
const url = () => `https://graph.facebook.com/${env.META_API_VERSION || 'v21.0'}/${env.META_PHONE_NUMBER_ID}/messages`;
const headers = () => ({ Authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' });

// message id -> when the bot handed it to Meta, so the "delivered" report can say how long the delivery took
const sentAt = new Map();
function remember(id) {
  if (!id) return;
  if (sentAt.size > 5000) sentAt.clear();
  sentAt.set(id, Date.now());
}
/** For the delivery report: ms since this message was sent, or null. */
function takeSentAt(id) {
  const t = sentAt.get(id);
  return t ? Date.now() - t : null;
}

async function post(body, what) {
  const started = Date.now();
  try {
    const res = await axios.post(url(), body, { headers: headers(), timeout: 10000 });
    const ms = Date.now() - started;
    const id = res.data && res.data.messages && res.data.messages[0] && res.data.messages[0].id;
    remember(id);
    logger.info({ ms, path: 'meta/messages' }, ms >= 1500 ? '[perf] SLOW Meta call' : '[perf] Meta call');
    logger.info({ to: body.to, content_type: body.type, messageId: id || null, what }, '[meta] send response');
    return res.data;
  } catch (err) {
    const e = err.response && err.response.data && err.response.data.error;
    logger.error({ err: e ? `${e.code}: ${e.message}` : err.message, to: body.to, content_type: body.type, what }, '[meta] send failed');
    throw err;
  }
}

/** Same call shape as the MSG91 client: { to, type, text | interactive | document | location | ... }. */
async function sendMessage(payload) {
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: payload.to, type: payload.type };
  body[payload.type] = payload[payload.type];
  return post(body, payload.type);
}

/** An approved template (for example the trip reminders). `components` must be Meta's own array, or none. */
async function sendTemplate({ to, name, languageCode = 'en', components }) {
  const template = { name, language: { code: languageCode } };
  if (Array.isArray(components) && components.length) template.components = components;
  return post({ messaging_product: 'whatsapp', to, type: 'template', template }, `template:${name}`);
}

module.exports = { sendMessage, sendTemplate, takeSentAt, url };
