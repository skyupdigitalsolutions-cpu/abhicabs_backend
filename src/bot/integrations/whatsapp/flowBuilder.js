/**
 * WhatsApp Flows — the tappable calendar date + time picker.
 *
 * A real tappable CALENDAR on WhatsApp is only possible with a WhatsApp Flow
 * (Meta's native DatePicker). On MSG91 a Flow is delivered through an APPROVED
 * TEMPLATE whose button opens the Flow, so we trigger it by template name.
 */

const dayjs = require('dayjs');
const dateParser = require('../../conversation/nlu/dateParser');

/** Builds the MSG91 outbound payload that sends the Flow template. */
function buildFlowTemplatePayload({ to, templateName, lang = 'en', flowToken }) {
  const template = {
    name: templateName,
    language: { code: lang, policy: 'deterministic' },
    components: [
      {
        type: 'button',
        sub_type: 'flow',
        index: '0',
        parameters: [{ type: 'action', action: { flow_token: flowToken || 'abhicabs' } }],
      },
    ],
  };
  return { to, type: 'template', template };
}

/** Turns a Flow's returned date value into a dayjs date (India time). */
function resolveFlowDate(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{10,}$/.test(raw)) {
    const d = dayjs(Number(raw)).tz(dateParser.TZ).startOf('day');
    return d.isValid() ? d : null;
  }
  return dateParser.resolveDatePhrase(raw);
}

/** Extracts { date, time } from a flow response object (message.flowResponse). */
function readDateTimeFromFlow(flowResponse) {
  if (!flowResponse || typeof flowResponse !== 'object') return { date: null, time: null };
  const date = resolveFlowDate(flowResponse.travel_date);
  const time = dateParser.resolveTimePhrase(flowResponse.travel_time);
  return { date, time };
}

module.exports = { buildFlowTemplatePayload, resolveFlowDate, readDateTimeFromFlow };
