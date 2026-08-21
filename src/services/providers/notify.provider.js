'use strict';

/**
 * src/services/providers/notify.provider.js   — Day 12
 *
 * WhatsApp / SMS delivery behind an interface, same reasoning as the payment
 * and maps providers: MSG91 needs DLT-template approval that can take weeks, and
 * nothing else should wait on it. The mock logs the message so the whole
 * notification pipeline — enqueue, idempotent handler, retry, DLQ — is built and
 * tested today; going live later is one env var.
 *
 * Contract:
 *   send({ to, channel, template, params }) -> { messageId, status }
 */

const env = require('../../config/env');

const mock = {
  name: 'mock',
  async send({ to, channel, template, params }) {
    const messageId = `msg_mock_${Math.random().toString(36).slice(2, 11)}`;
    console.log(`[notify:mock] ${channel} -> ${to} [${template}] ${JSON.stringify(params)} (${messageId})`);
    return { messageId, status: 'SENT' };
  },
};

// MSG91 stub — real integration once DLT templates are approved. Kept thin: the
// mock already proved the surrounding pipeline.
const msg91 = {
  name: 'msg91',
  async send({ to, channel, template, params }) {
    if (!env.msg91.authKey) {
      throw new Error('[notify:msg91] MSG91_AUTH_KEY not set');
    }
    // Placeholder: POST to MSG91 flow/SMS API with authKey + template. Left
    // unimplemented until DLT approval; the factory falls back to mock so this
    // never runs without credentials.
    throw new Error('[notify:msg91] not implemented yet — awaiting DLT approval');
  },
};

let cached = null;

function getProvider() {
  if (cached) return cached;
  const name = env.notify.provider;
  if (name === 'msg91' && env.msg91.authKey) {
    cached = msg91;
  } else {
    if (name === 'msg91') console.warn('[notify] msg91 selected but no auth key — using mock');
    cached = mock;
  }
  return cached;
}

module.exports = { getProvider };