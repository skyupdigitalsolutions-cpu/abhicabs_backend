const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');
const { providerFor } = require('./providerRoute');

const http = axios.create({
  baseURL: 'https://api.msg91.com/api/v5/whatsapp',
  timeout: 10000,
  headers: {
    authkey: env.MSG91_AUTH_KEY,
    'Content-Type': 'application/json',
  },
});

// Timing: how long each MSG91 call takes (this is a big part of the delay a customer feels).
http.interceptors.request.use((cfg) => { cfg.metadata = { start: Date.now() }; return cfg; });
http.interceptors.response.use(
  (res) => {
    const ms = Date.now() - (res.config.metadata ? res.config.metadata.start : Date.now());
    logger.info({ ms, path: res.config.url }, ms >= 1500 ? '[perf] SLOW MSG91 call' : '[perf] MSG91 call');
    return res;
  },
  (err) => {
    const ms = Date.now() - (err.config && err.config.metadata ? err.config.metadata.start : Date.now());
    logger.warn({ ms, path: err.config && err.config.url }, '[perf] MSG91 call failed');
    return Promise.reject(err);
  }
);

async function sendMessage(payload) {
  if (providerFor(payload.to) === 'meta') return require('./metaClient').sendMessage(payload); // straight to Meta, no MSG91
  const body = {
    integrated_number: env.MSG91_INTEGRATED_NUMBER,
    recipient_number: payload.to,
    content_type: payload.type,
  };

  if (payload.type === 'text') {
    body.text = payload.text?.body ?? '';
  } else if (payload.type === 'interactive') {
    body.interactive = payload.interactive;
  } else if (payload.type === 'document') {
    body.document = payload.document;
  } else {
    body[payload.type] = payload[payload.type];
  }

  try {
    const res = await http.post('/whatsapp-outbound-message/', body);
    logger.info({ to: payload.to, content_type: payload.type, msg91Response: res.data }, '[msg91] send response');
    return res.data;
  } catch (err) {
    logger.error(
      { err: err.response?.data || err.message, to: payload.to, content_type: payload.type },
      '[msg91] send failed'
    );
    throw err;
  }
}

/**
 * Sends an approved WhatsApp message template (this is how MSG91 sends a Flow: the Flow is attached to a
 * template with a Flow button). Uses MSG91's template endpoint; the template must be synced in MSG91.
 */
async function sendTemplate({ to, name, languageCode = 'en', namespace, components = {} }) {
  if (providerFor(to) === 'meta') return require('./metaClient').sendTemplate({ to, name, languageCode, components });
  const body = {
    integrated_number: env.MSG91_INTEGRATED_NUMBER,
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name,
        language: { code: languageCode, policy: 'deterministic' },
        ...(namespace ? { namespace } : {}),
        to_and_components: [{ to: [to], components }],
      },
    },
  };
  try {
    const res = await http.post('/whatsapp-outbound-message/bulk/', body);
    logger.info({ to, template: name, msg91Response: res.data }, '[msg91] template send response');
    return res.data;
  } catch (err) {
    logger.error({ err: err.response?.data || err.message, to, template: name }, '[msg91] template send failed');
    throw err;
  }
}

/**
 * An approved template with body variables {{1}}, {{2}}, ... filled from `params` (strings, in order).
 * Builds the components in whichever format the provider expects, so callers never deal with the difference:
 *   Meta:  [{ type: 'body', parameters: [{ type: 'text', text }] }]
 *   MSG91: { body_1: { type: 'text', value }, body_2: ... }
 */
async function sendTemplateParams({ to, name, params = [], languageCode = 'en', namespace }) {
  const values = params.map((p) => String(p == null || p === '' ? '-' : p).slice(0, 1000));
  if (providerFor(to) === 'meta') {
    const components = values.length
      ? [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }]
      : [];
    return require('./metaClient').sendTemplate({ to, name, languageCode, components });
  }
  const components = {};
  values.forEach((value, i) => { components[`body_${i + 1}`] = { type: 'text', value }; });
  return sendTemplate({ to, name, languageCode, namespace, components });
}

async function markAsRead() {
  return null;
}

module.exports = { sendMessage, sendTemplate, sendTemplateParams, markAsRead };
