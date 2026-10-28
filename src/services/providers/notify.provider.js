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
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED WHEN THE FIRST TEMPLATE WAS APPROVED
 * ---------------------------------------------------------------------------
 * `booking_confirmed` is now live on DLT, so msg91 is no longer a stub that
 * throws. It is still a PARTIAL provider, and that is the important part: only
 * templates with an approved id send: every other template falls through to
 * the mock's log line rather than throwing. The old behaviour — throw on
 * everything — meant that turning NOTIFY_PROVIDER=msg91 on for the one working
 * template would have broken the driver-assigned and cancellation legs at the
 * same moment.
 */

const env = require('../../config/env');
const smsService = require('../sms.service');

const mock = {
  name: 'mock',
  async send({ to, channel, template, params }) {
    const messageId = `msg_mock_${Math.random().toString(36).slice(2, 11)}`;
    console.log(`[notify:mock] ${channel} -> ${to} [${template}] ${JSON.stringify(params)} (${messageId})`);
    return { messageId, status: 'SENT' };
  },
};

/**
 * Template name (as used by notification.job) -> the sms.service kind that
 * holds its DLT id. A template absent here, or present with no id configured,
 * is not sendable by MSG91 yet.
 */
const SMS_KIND = {
  booking_confirmed: 'BOOKING_CONFIRMED',
};

const msg91 = {
  name: 'msg91',
  async send({ to, channel, template, params }) {
    const kind = SMS_KIND[template];

    /*
     * NOT APPROVED YET -> MOCK, NOT AN EXCEPTION.
     *
     * driver_assigned, booking_cancelled, trip_reminder and booking_received
     * have no DLT template behind them. Throwing here would turn every one of
     * them into a logged failure the moment MSG91 went live for bookings, and
     * (worse) a retry storm in the notifications queue. Logging it keeps the
     * pipeline honest about what did and did not go out.
     */
    if (!kind || !smsService.isConfigured(kind)) {
      const why = kind
        ? `missing ${smsService.missingConfig(kind).join(', ')}`
        : 'no DLT template mapped';
      console.warn(`[notify:msg91] ${template} not sendable (${why}) — logging instead`);
      return mock.send({ to, channel, template, params });
    }

    /*
     * The variables come from the job's render step, already ASCII-clean and
     * capped at the DLT per-variable length. A template that is mapped above
     * but whose params carry no `sms` block is a bug in that render, not a
     * reason to send a half-filled message: MSG91 would substitute nothing and
     * the rider would get a text with literal ##var2## in it.
     */
    const vars = params?.sms;
    if (!vars) {
      console.error(`[notify:msg91] ${template} carried no sms vars — not sending`);
      return { messageId: null, status: 'SKIPPED' };
    }

    const result = await smsService.sendTemplate({ kind, phone: to, vars });
    return { messageId: result.requestId, status: 'SENT', to: result.to };
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