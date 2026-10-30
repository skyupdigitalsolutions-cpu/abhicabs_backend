const env = require('../../config/env');

/**
 * Which service carries a customer's replies.
 *   WHATSAPP_PROVIDER=msg91   everything through MSG91 (the default)
 *   WHATSAPP_PROVIDER=meta    everything straight through Meta
 *   WHATSAPP_PROVIDER=auto    each customer is answered through the SAME door they wrote to. This lets you test Meta with your own
 *                             phone while your real customers carry on through MSG91, with no outage and no second bot.
 * A message that is not an answer (a reminder, a follow-up) uses MSG91 in auto mode unless the customer last wrote through Meta.
 */
const via = new Map();

function remember(number, provider) {
  if (via.size > 5000) via.clear();
  via.set(String(number), provider === 'meta' ? 'meta' : 'msg91');
}

function providerFor(number) {
  const mode = env.WHATSAPP_PROVIDER;
  if (mode === 'meta' || mode === 'msg91') return mode;
  return via.get(String(number)) || 'msg91';
}

module.exports = { remember, providerFor };
