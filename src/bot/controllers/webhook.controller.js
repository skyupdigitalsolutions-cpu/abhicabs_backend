const { extractFlowDate } = require('../conversation/inbound');
const providerRoute = require('../integrations/whatsapp/providerRoute');
const { logger } = require('../config/logger');
const { normalizeInboundMessage } = require('../conversation/inbound');
const { processInboundMessage } = require('../conversation/stateMachine');
const { getOrCreateSession } = require('../conversation/sessionManager');
const { sendText } = require('../integrations/whatsapp/messageBuilder');
const env = require('../config/env');
const { getPrisma } = require('../config/db');
const { normalizeWhatsAppNumber } = require('../utils/phone');
const { toMs } = require('../conversation/ping');
const { perCustomerRateOk } = require('../middleware/rateLimiter');

/**
 * POST /webhook/whatsapp — receives MSG91's WhatsApp webhook events.
 *
 * Unlike Meta's direct Cloud API, MSG91 has no GET verification
 * handshake to register a callback URL — you just paste this URL into
 * MSG91's "Webhook (New)" config screen and it starts POSTing here.
 * Each call carries ONE flat event object (not an array), so there's
 * no batching loop like the direct-Meta version needed.
 *
 * Acknowledges immediately (200) and processes in the background, per
 * the same "don't block the webhook" principle as any provider.
 */
async function receiveWebhook(req, res) {
  res.sendStatus(200); // acknowledge first — everything below is best-effort background work

  try {
    const event = req.body;
    if (!event || !event.customerNumber) {
      logger.debug({ event }, '[webhook] ignored — not a recognizable inbound message event');
      return;
    }

    // Only "direction": "0" (inbound) or events with actual message content
    // are customer messages; outbound delivery-report events (direction "1",
    // or eventName like "sent"/"delivered"/"read") are not something the
    // conversation engine should reply to.
    if (event.direction === '1' || (!event.text && !event.button && !event.interactive && !event.latitude && !extractFlowDate(event))) {
      logger.debug({ eventName: event.eventName, requestId: event.requestId }, '[webhook] ignored — delivery/status report, not a customer message');
      return;
    }

    await handleSingleMessage(event);
  } catch (err) {
    logger.error({ err: err.message }, '[webhook] processing failed');
  }
}

async function handleSingleMessage(event, via = 'msg91') {
  const receivedAt = Date.now(); // when the bot got the message: used by the "ping" speed test
  const messageId = event.uuid || event.requestId;
  const whatsappNumber = normalizeWhatsAppNumber(event.customerNumber);
  providerRoute.remember(whatsappNumber, via); // in auto mode this customer is answered through the door they used

  // Start loading the customer and session NOW, while the duplicate check runs: they are independent database
  // trips, so doing them together saves one full round trip on every message.
  const loading = getOrCreateSession(whatsappNumber);
  loading.catch(() => {}); // if this message turns out to be a duplicate nobody waits for it

  // Duplicate delivery protection (spec section 47): unique index on
  // whatsappMessageId means a second insert throws — treat that as
  // "already processed". If MSG91 ever omits an id, fall back to
  // processing (better to risk a rare duplicate than silently drop it).
  if (messageId) {
    const prisma = getPrisma();
    try {
      await prisma.whatsappProcessedMessage.create({ data: { whatsappMessageId: messageId, whatsappNumber: event.customerNumber } });
    } catch (err) {
      if (err.code === 'P2002') {
        logger.info({ messageId }, '[webhook] duplicate message ignored');
        return;
      }
      throw err;
    }
  }

  if (!perCustomerRateOk(whatsappNumber)) {
    logger.warn({ whatsappNumber }, '[webhook] per-customer rate limit hit — message dropped');
    return;
  }

  const normalized = normalizeInboundMessage(event);
  normalized.receivedAt = receivedAt;
  const inboundMs = inboundDelayMs(normalized, receivedAt);
  const startedAt = Date.now();
  try {
    await processInboundMessage(whatsappNumber, normalized, loading);
  } catch (err) {
    await reportFailure(whatsappNumber, normalized, err);
    return;
  }
  // Timing: how long the bot took to handle this message, from receiving it to the last reply sent.
  const ms = Date.now() - startedAt;
  logger.info({ ms, inboundMs }, ms >= 3000 ? '[perf] SLOW message handled' : '[perf] message handled');
  // How late MSG91 passed the customer's message to the bot (their own time on the message, to our arrival time).
  // This is the part of the delay the bot can see but not fix, so it is called out loudly.
  if (inboundMs !== null && inboundMs >= 10000) {
    logger.warn({ inboundMs, seconds: Math.round(inboundMs / 1000) }, '[perf] SLOW inbound: MSG91 passed this message to the bot late (not the bot)');
  }
}

/** Milliseconds between the moment WhatsApp/MSG91 stamped the message and the moment it reached the bot, or null. */
function inboundDelayMs(normalized, receivedAt) {
  const sentAt = toMs(normalized && normalized.timestamp);
  if (!sentAt || sentAt > receivedAt + 5000) return null; // no time given, or a clock that disagrees: do not guess
  return Math.max(0, receivedAt - sentAt);
}

// A step that fails must never leave the customer in silence. The full error goes to the log under a short reference,
// and the customer gets a short apology with the same reference (at most one per minute for each customer).
const lastApology = new Map();
async function reportFailure(whatsappNumber, normalized, err) {
  const ref = `E-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  logger.error(
    {
      ref,
      err: err && err.message,
      stack: String((err && err.stack) || '').split('\n').slice(0, 7).join(' | '),
      messageType: normalized && normalized.type,
      text: normalized && normalized.text ? String(normalized.text).slice(0, 30) : undefined,
    },
    '[webhook] a step failed'
  );
  const now = Date.now();
  if (now - (lastApology.get(whatsappNumber) || 0) < 60 * 1000) return;
  lastApology.set(whatsappNumber, now);
  if (lastApology.size > 5000) lastApology.clear();
  try {
    await sendText(
      whatsappNumber,
      `⚠️ Sorry, something went wrong on our side. Please type *Hi* to start again${env.SUPPORT_PHONE ? `, or call us on ${env.SUPPORT_PHONE}` : ''}.\n(Ref: ${ref})`
    );
  } catch (sendErr) {
    logger.error({ err: sendErr.message }, '[webhook] could not send the apology message');
  }
}

module.exports = { receiveWebhook, handleSingleMessage, inboundDelayMs };
