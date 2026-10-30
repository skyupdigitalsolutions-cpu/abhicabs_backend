/**
 * Converts an MSG91 inbound WhatsApp webhook payload into the same
 * small, predictable shape the state machine and handlers work with.
 */
function safeParseJSON(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Pulls a WhatsApp Flow completion payload out of an MSG91 inbound event,
 * whichever place it lands in. Returns the parsed object (the Footer payload,
 * e.g. { travel_date, travel_time }) or null if this isn't a flow reply.
 */
function extractFlowResponse(msg91Payload) {
  const fromInteractive = (interactive) => {
    if (!interactive || interactive.type !== 'nfm_reply' || !interactive.nfm_reply) return null;
    const rj = interactive.nfm_reply.response_json;
    const parsed = typeof rj === 'string' ? safeParseJSON(rj) : rj;
    return parsed && typeof parsed === 'object' ? parsed : null;
  };

  // 1) Directly on the `interactive` field (mirrors list/button handling).
  const direct = fromInteractive(safeParseJSON(msg91Payload.interactive));
  if (direct) return direct;

  // 2) Inside Meta's raw `messages` array (stringified), if MSG91 forwards it.
  const messages = safeParseJSON(msg91Payload.messages);
  const arr = Array.isArray(messages) ? messages : messages ? [messages] : [];
  for (const m of arr) {
    const found = fromInteractive(m && m.interactive);
    if (found) return found;
  }
  return null;
}

function normalizeInboundMessage(msg91Payload) {
  const base = {
    id: msg91Payload.uuid || msg91Payload.requestId || null,
    from: msg91Payload.customerNumber,
    timestamp: msg91Payload.ts || null,
    type: msg91Payload.contentType || 'text',
    text: null,
    interactiveId: null,
    interactiveTitle: null,
    location: null,
    flowResponse: null, // parsed WhatsApp Flow completion payload (calendar date+time picker)
  };

  // WhatsApp Flow completion (nfm_reply) → the tappable calendar's date+time.
  const flow = extractFlowResponse(msg91Payload);
  if (flow) {
    base.type = 'flow';
    base.flowResponse = flow;
    return base;
  }

  // Quick-reply button tap: {"payload":"MENU_BOOK_CAB","text":"Book a Cab"}
  const button = safeParseJSON(msg91Payload.button);
  if (button) {
    base.interactiveId = button.payload || button.id || null;
    base.interactiveTitle = button.text || button.title || null;
    return base;
  }

  // Interactive list/button reply (Meta's own nested shape, relayed as-is)
  const interactive = safeParseJSON(msg91Payload.interactive);
  if (interactive) {
    if (interactive.type === 'button_reply' && interactive.button_reply) {
      base.interactiveId = interactive.button_reply.id;
      base.interactiveTitle = interactive.button_reply.title;
    } else if (interactive.type === 'list_reply' && interactive.list_reply) {
      base.interactiveId = interactive.list_reply.id;
      base.interactiveTitle = interactive.list_reply.title;
    }
    if (base.interactiveId) return base;
  }

  // Location share
  if (msg91Payload.latitude && msg91Payload.longitude) {
    base.type = 'location';
    // A shared PLACE also carries its name and address (MSG91 may relay them as plain fields or under "location";
    // Meta's webhook sends them as name / address).
    const nested = msg91Payload.location && typeof msg91Payload.location === 'object' ? msg91Payload.location : {};
    const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim()) || null;
    base.location = {
      latitude: parseFloat(msg91Payload.latitude),
      longitude: parseFloat(msg91Payload.longitude),
      name: pick(msg91Payload.name, msg91Payload.locationName, msg91Payload.location_name, nested.name),
      address: pick(msg91Payload.address, msg91Payload.locationAddress, msg91Payload.location_address, nested.address),
    };
    return base;
  }

  // Plain text (the common case)
  if (msg91Payload.text) {
    base.type = 'text';
    base.text = String(msg91Payload.text).trim();
    return base;
  }

  return base;
}

/** The single piece of "free text" a handler should reason over, whichever channel it came from. */
function effectiveText(normalized) {
  return normalized.interactiveTitle || normalized.text || '';
}

module.exports = { normalizeInboundMessage, effectiveText };
