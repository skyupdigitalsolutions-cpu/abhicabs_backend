const { sendMessage } = require('./client');

// ── Meta WhatsApp field limits (exceeding ANY of these = silent drop) ──
const LIMIT = {
  TEXT_BODY: 4096,   // text message body
  INT_BODY: 1024,    // interactive body text
  HEADER: 60,        // header text
  FOOTER: 60,        // footer text
  BTN_LABEL: 20,     // reply-button title / list "button" label
  ROW_TITLE: 24,     // list row title
  ROW_DESC: 72,      // list row description
  ROW_ID: 200,       // row / button id
  SECTION_TITLE: 24, // list section title
  MAX_BUTTONS: 3,    // reply buttons per message
  MAX_ROWS: 10,      // total rows across all list sections
};

// Trim to limit, coerce to string, strip nothing else.
const clamp = (v, n) => (v == null ? '' : String(v)).slice(0, n);

/** Plain text message. */
async function sendText(to, body) {
  return sendMessage({
    to,
    type: 'text',
    text: { body: clamp(body, LIMIT.TEXT_BODY), preview_url: false },
  });
}

/**
 * Interactive reply buttons — max 3 options, each label <= 20 chars.
 * buttons: [{ id: 'BOOK_CAB', title: 'Book a Cab' }, ...]
 */
async function sendButtons(to, bodyText, buttons, { header, footer } = {}) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('sendButtons: at least one button required.');
  }
  if (buttons.length > LIMIT.MAX_BUTTONS) {
    throw new Error('WhatsApp buttons support max 3 options; use sendList instead.');
  }
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text', text: clamp(header, LIMIT.HEADER) } } : {}),
      body: { text: clamp(bodyText, LIMIT.INT_BODY) },
      ...(footer ? { footer: { text: clamp(footer, LIMIT.FOOTER) } } : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: clamp(b.id, LIMIT.ROW_ID), title: clamp(b.title, LIMIT.BTN_LABEL) },
        })),
      },
    },
  });
}

/**
 * Interactive list — for menus with >3 options.
 * sections: [{ title: 'Menu', rows: [{ id, title, description }] }]
 */
async function sendList(to, bodyText, buttonLabel, sections, { header, footer } = {}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('sendList: at least one section required.');
  }

  let rowCount = 0;
  const cleanSections = sections.map((s) => {
    const rows = (s.rows || []).map((r) => {
      rowCount += 1;
      const row = {
        id: clamp(r.id, LIMIT.ROW_ID),
        title: clamp(r.title, LIMIT.ROW_TITLE),
      };
      // description is optional — only include if present & non-empty
      const desc = clamp(r.description, LIMIT.ROW_DESC);
      if (desc) row.description = desc;
      if (!row.title) throw new Error('sendList: every row needs a non-empty title.');
      return row;
    });
    if (rows.length === 0) throw new Error('sendList: every section needs at least one row.');
    const section = { rows };
    const title = clamp(s.title, LIMIT.SECTION_TITLE);
    if (title) section.title = title;
    return section;
  });

  if (rowCount > LIMIT.MAX_ROWS) {
    throw new Error(`sendList: ${rowCount} rows exceeds Meta's max of ${LIMIT.MAX_ROWS}.`);
  }

  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header ? { header: { type: 'text', text: clamp(header, LIMIT.HEADER) } } : {}),
      body: { text: clamp(bodyText, LIMIT.INT_BODY) },
      ...(footer ? { footer: { text: clamp(footer, LIMIT.FOOTER) } } : {}),
      action: {
        button: clamp(buttonLabel, LIMIT.BTN_LABEL) || 'Select',
        sections: cleanSections,
      },
    },
  });
}

async function sendDocument(to, link, filename, caption) {
  return sendMessage({
    to,
    type: 'document',
    document: { link, filename, caption },
  });
}

async function sendLocationRequest(to, bodyText) {
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: clamp(bodyText, LIMIT.INT_BODY) },
      action: { name: 'send_location' },
    },
  });
}

/**
 * A WhatsApp Flow message (e.g. the tap-a-date calendar). The Flow must be PUBLISHED in the same
 * WhatsApp Business Account as the sending number. Flows only open in the WhatsApp phone apps.
 */
async function sendFlow(to, { header, body, footer, flowId, cta, screen, data, token }) {
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      ...(header ? { header: { type: 'text', text: clamp(header, LIMIT.HEADER) } } : {}),
      body: { text: clamp(body, LIMIT.INT_BODY) },
      ...(footer ? { footer: { text: clamp(footer, LIMIT.FOOTER) } } : {}),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: token || 'abhicabs-date',
          flow_id: String(flowId),
          flow_cta: clamp(cta, LIMIT.BTN_LABEL),
          flow_action: 'navigate',
          flow_action_payload: { screen, data },
        },
      },
    },
  });
}

/** A map card: WhatsApp shows the place on a small map with its name and address. */
async function sendLocation(to, { latitude, longitude, name, address }) {
  return sendMessage({
    to,
    type: 'location',
    location: { latitude, longitude, name: clamp(name || '', 100), address: clamp(address || '', 200) },
  });
}

/**
 * A message with ONE button that opens a web page (WhatsApp's "call to action URL" button).
 * The customer sees a button such as "Pick date and time", not a long link.
 */
async function sendCtaUrl(to, { header, body, footer, text, url }) {
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(header ? { header: { type: 'text', text: clamp(header, LIMIT.HEADER) } } : {}),
      body: { text: clamp(body, LIMIT.INT_BODY) },
      ...(footer ? { footer: { text: clamp(footer, LIMIT.FOOTER) } } : {}),
      action: { name: 'cta_url', parameters: { display_text: clamp(text, 20), url } },
    },
  });
}

/** The calendar Flow, sent as an approved template with a Flow button (MSG91's documented way). */
async function sendFlowTemplate(to, { name, namespace, languageCode }) {
  return require('./client').sendTemplate({ to, name, namespace, languageCode });
}

module.exports = { sendText, sendButtons, sendList, sendDocument, sendLocationRequest, sendFlow, sendLocation, sendCtaUrl, sendFlowTemplate };
