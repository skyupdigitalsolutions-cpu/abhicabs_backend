const crypto = require('crypto');
const env = require('../config/env');
const { logger } = require('../config/logger');
const { handleSingleMessage } = require('./webhook.controller');
const { takeSentAt } = require('../integrations/whatsapp/metaClient');

/**
 * Meta's WhatsApp Cloud API webhook (used when WHATSAPP_PROVIDER=meta).
 *
 *   GET  /webhook/meta   Meta's one-time check when you save the webhook address: it sends hub.verify_token and hub.challenge.
 *   POST /webhook/meta   every message and every delivery report. Each POST is signed: X-Hub-Signature-256 = HMAC-SHA256 of the
 *                        raw body with the app secret. A POST without a valid signature is refused (so nobody else can
 *                        send your bot fake customer messages).
 *
 * Each customer message is turned into the same small event the MSG91 webhook produces, so everything after this point
 * (duplicate guard, sessions, steps, bookings) is exactly the same code.
 */
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function verifyMetaWebhook(req, res) {
  const ok = req.query['hub.mode'] === 'subscribe' && env.META_VERIFY_TOKEN && safeEqual(req.query['hub.verify_token'], env.META_VERIFY_TOKEN);
  if (!ok) return res.sendStatus(403);
  return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
}

function validSignature(req) {
  if (!env.META_APP_SECRET || !req.rawBody) return false; // no secret set: refuse everything rather than accept anything
  const expected = `sha256=${crypto.createHmac('sha256', env.META_APP_SECRET).update(req.rawBody).digest('hex')}`;
  return safeEqual(req.get('x-hub-signature-256'), expected);
}

/** Pure: one message from Meta's webhook in, the bot's event out (or null for a kind of message the bot does not read). */
function metaMessageToEvent(msg, contact) {
  const base = { customerNumber: msg.from, customerName: contact && contact.profile && contact.profile.name, uuid: msg.id, ts: msg.timestamp, direction: '0' };
  if (msg.type === 'text' && msg.text) return { ...base, contentType: 'text', text: msg.text.body };
  if (msg.type === 'interactive' && msg.interactive) {
    // list_reply, button_reply, or nfm_reply (a WhatsApp Flow answer): the bot already reads all three out of this one field.
    return { ...base, contentType: 'interactive', interactive: JSON.stringify(msg.interactive) };
  }
  if (msg.type === 'button' && msg.button) return { ...base, contentType: 'button', button: JSON.stringify({ payload: msg.button.payload, text: msg.button.text }) };
  if (msg.type === 'location' && msg.location) {
    return { ...base, contentType: 'location', latitude: String(msg.location.latitude), longitude: String(msg.location.longitude), name: msg.location.name, address: msg.location.address };
  }
  return null;
}

/** Delivery reports: how long the phone took to get a message, and why one failed. */
function logStatus(st) {
  if (st.status === 'failed') {
    logger.error({ to: st.recipient_id, messageId: st.id, errors: st.errors }, '[meta] a message could NOT be delivered');
  } else if (st.status === 'delivered') {
    const ms = takeSentAt(st.id);
    logger.info({ messageId: st.id, deliveredAfterMs: ms }, ms !== null && ms >= 10000 ? '[perf] SLOW delivery to the phone' : '[perf] delivered to the phone');
  }
}

async function receiveMetaWebhook(req, res) {
  if (!validSignature(req)) {
    logger.warn({ hasSecret: !!env.META_APP_SECRET }, '[meta] refused a webhook call: the signature is missing or wrong');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // Meta wants a quick answer; the rest is background work

  try {
    const body = req.body || {};
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Only the number this bot serves (Meta can send events for other numbers on the same business account).
        if (env.META_PHONE_NUMBER_ID && value.metadata && value.metadata.phone_number_id && String(value.metadata.phone_number_id) !== String(env.META_PHONE_NUMBER_ID)) continue;

        for (const st of value.statuses || []) logStatus(st);

        // One customer's messages stay in order; different customers run side by side.
        const byCustomer = new Map();
        for (const m of value.messages || []) {
          const contact = (value.contacts || []).find((c) => c.wa_id === m.from) || (value.contacts || [])[0];
          const event = metaMessageToEvent(m, contact);
          if (!event) {
            logger.debug({ type: m.type }, '[meta] ignored a message type the bot does not read');
            continue;
          }
          if (!byCustomer.has(m.from)) byCustomer.set(m.from, []);
          byCustomer.get(m.from).push(event);
        }
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([...byCustomer.values()].map(async (events) => {
          for (const e of events) {
            // eslint-disable-next-line no-await-in-loop
            await handleSingleMessage(e, 'meta');
          }
        }));
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, '[meta] processing failed');
  }
}

module.exports = { verifyMetaWebhook, receiveMetaWebhook, metaMessageToEvent, validSignature };
