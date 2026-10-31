const dayjs = require('dayjs');
const dateParser = require('./nlu/dateParser'); // loads the dayjs time zone plugins
const { logger } = require('../config/logger');

/**
 * "ping": a one-word speed test. The bot answers with where the time went:
 *   - how long MSG91 took to pass the customer's message to the bot (needs MSG91's own message time)
 *   - how long the bot itself worked before replying
 *   - how long MSG91 took to accept the reply
 * If all three are small and the reply still feels slow, the delay is after MSG91 accepted it (MSG91 or WhatsApp delivery).
 */
function toMs(ts) {
  if (ts == null || ts === '') return null;
  const n = Number(ts);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(ts);
  return Number.isFinite(d) ? d : null;
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function runPing(ctx) {
  const { message } = ctx;
  const gotAt = message.receivedAt || Date.now();
  const sentAt = toMs(message.timestamp);
  const botMs = Date.now() - gotAt;

  const lines = ['🏓 Ping'];
  if (sentAt && sentAt <= gotAt + 5000) {
    const inbound = Math.max(0, gotAt - sentAt);
    lines.push(`Your message was sent at ${dayjs(sentAt).tz(dateParser.TZ).format('h:mm:ss A')} (IST).`);
    lines.push(`MSG91 passed it to the bot after about ${secs(inbound)}.`);
  } else {
    lines.push('MSG91 did not give the time your message was sent, so that part cannot be measured.');
  }
  lines.push(`The bot itself worked for ${botMs} ms before replying.`);

  const t0 = Date.now();
  await ctx.send.raw(lines.join('\n'));
  const sendMs = Date.now() - t0;
  await ctx.send.raw(`MSG91 accepted that reply in ${sendMs} ms. If this still reached your phone late, the wait is after MSG91 accepted it.`);
  logger.info({ botMs, sendMs, inboundMs: sentAt ? Math.max(0, gotAt - sentAt) : null }, '[perf] ping');
}

module.exports = { runPing, toMs };
