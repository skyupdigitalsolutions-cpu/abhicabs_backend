const env = require('../config/env');
const { sendFlow } = require('../integrations/whatsapp/messageBuilder');
const dateParser = require('./nlu/dateParser');

/**
 * Diagnostic. With ENABLE_FLOW_TEST=true, typing "flowtest" in WhatsApp sends the calendar Flow
 * to the person who typed it and says in the chat whether MSG91 accepted or refused it.
 * Nothing to edit: it uses the sender's own number. Turn ENABLE_FLOW_TEST off when you are done.
 */
function timeSlots() {
  const slots = [];
  for (let m = 0; m < 24 * 60; m += 30) {
    const h = Math.floor(m / 60);
    const mi = m % 60;
    slots.push({ id: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, title: `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` });
  }
  return slots;
}

async function runTemplateTest(ctx) {
  try {
    const res = await ctx.send.flowTemplateRaw({ name: env.FLOW_TEMPLATE_NAME, namespace: env.FLOW_TEMPLATE_NAMESPACE || undefined, languageCode: env.FLOW_TEMPLATE_LANGUAGE });
    await ctx.send.raw(
      `Flow test (template "${env.FLOW_TEMPLATE_NAME}"): MSG91 ACCEPTED the template.\n` +
      'If a message with a Pick date and time button is shown above, the calendar works on your phone.\n' +
      'If you see no message, open the MSG91 Logs page and read the reason.\n' +
      `MSG91 said: ${JSON.stringify(res).slice(0, 300)}`
    );
  } catch (err) {
    await ctx.send.raw(`Flow test (template "${env.FLOW_TEMPLATE_NAME}"): MSG91 REFUSED the template.\n${JSON.stringify((err.response && err.response.data) || err.message).slice(0, 500)}`);
  }
}

async function runFlowTest(ctx) {
  if (env.FLOW_TEMPLATE_NAME) {
    await runTemplateTest(ctx);
    return;
  }
  if (!env.DATE_FLOW_ID) {
    await ctx.send.raw('Flow test: DATE_FLOW_ID is not set in Railway Variables, so there is no Flow to send.');
    return;
  }
  const { min, lastMonth } = dateParser.getCalendarBounds();
  try {
    const res = await sendFlow(ctx.session.whatsappNumber, {
      header: 'Pick Date',
      body: 'Flow test. Tap the button to open the calendar.',
      flowId: env.DATE_FLOW_ID,
      cta: env.DATE_FLOW_TIME ? 'Pick date and time' : 'Pick a date',
      screen: 'PICK_DATE',
      data: {
        min_date: min.format('YYYY-MM-DD'),
        max_date: lastMonth.endOf('month').format('YYYY-MM-DD'),
        ...(env.DATE_FLOW_TIME ? { time_slots: timeSlots() } : {}),
      },
    });
    await ctx.send.raw(
      'Flow test: MSG91 ACCEPTED the Flow message.\n' +
      'If a "Pick date" button is shown above, the Flow works on your phone.\n' +
      'If you see no button, WhatsApp refused it after MSG91 took it: open the MSG91 Logs page and read the reason.\n' +
      `MSG91 said: ${JSON.stringify(res).slice(0, 300)}`
    );
  } catch (err) {
    await ctx.send.raw(`Flow test: MSG91 REFUSED the Flow message.\n${JSON.stringify((err.response && err.response.data) || err.message).slice(0, 500)}`);
  }
}

module.exports = { runFlowTest };
