const { callAI } = require('./aiClient');
const { logger } = require('../../config/logger');

/**
 * Structured intents the extractor can return. The conversation engine
 * (conversation/stateMachine.js) decides what to DO with an intent —
 * this module only classifies free text into structured data.
 */
const INTENTS = {
  BOOK_CAB: 'BOOK_CAB',
  FARE_ENQUIRY: 'FARE_ENQUIRY',
  MY_BOOKINGS: 'MY_BOOKINGS',
  TRACK_BOOKING: 'TRACK_BOOKING',
  CANCEL_BOOKING: 'CANCEL_BOOKING',
  MODIFY_BOOKING: 'MODIFY_BOOKING',
  INVOICE_REQUEST: 'INVOICE_REQUEST',
  SUPPORT_REQUEST: 'SUPPORT_REQUEST',
  HUMAN_REQUEST: 'HUMAN_REQUEST',
  PAYMENT_STATUS_QUERY: 'PAYMENT_STATUS_QUERY',
  PROVIDE_INFO: 'PROVIDE_INFO', // e.g. answering the current question in-flow
  GREETING: 'GREETING',
  UNKNOWN: 'UNKNOWN',
};

const RULES = [
  { intent: INTENTS.CANCEL_BOOKING, patterns: [/cancel/i, /रद्द/i, /ರದ್ದು/i] },
  { intent: INTENTS.TRACK_BOOKING, patterns: [/where.*cab/i, /track/i, /live location/i] },
  { intent: INTENTS.INVOICE_REQUEST, patterns: [/invoice/i, /receipt/i, /bill/i] },
  { intent: INTENTS.MY_BOOKINGS, patterns: [/my booking/i, /my trips?/i, /booking history/i] },
  {
    intent: INTENTS.SUPPORT_REQUEST,
    patterns: [/support/i, /help/i, /complain/i, /issue/i, /problem/i],
  },
  { intent: INTENTS.HUMAN_REQUEST, patterns: [/human/i, /agent/i, /talk to (a )?person/i] },
  {
    intent: INTENTS.PAYMENT_STATUS_QUERY,
    patterns: [/payment (status|failed|not (done|working))/i],
  },
  {
    intent: INTENTS.FARE_ENQUIRY,
    patterns: [/how much/i, /fare/i, /price/i, /cost/i, /ಎಷ್ಟು/i, /कितना/i],
  },
  {
    intent: INTENTS.BOOK_CAB,
    patterns: [
      /\bbook\b/i,
      /need (a )?cab/i,
      /cab (chahiye|bhejo|book)/i,
      /ಬೇಕು/i,
      / to .+ (tomorrow|today|on )/i,
    ],
  },
  { intent: INTENTS.GREETING, patterns: [/^hi\b/i, /^hello\b/i, /^hey\b/i, /^namaste/i] },
];

/**
 * Fast, deterministic first pass. Runs before any AI call so the bot
 * never depends on an external API for basic routing — the AI layer
 * only assists with entity extraction and ambiguous free text.
 */
function ruleBasedIntent(text) {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return rule.intent;
    }
  }
  return INTENTS.UNKNOWN;
}

/**
 * Extracts structured entities (pickup, drop, date phrase, vehicle
 * preference, passenger count) from free text. Uses the AI model to
 * handle mixed-language / natural phrasing, but the output is treated
 * as a *hint* — every downstream value is still validated (see
 * conversation/nlu/dateParser.js) before being trusted.
 */
async function extractEntities(text, { language = 'en' } = {}) {
  const system = `You extract structured trip-booking entities from a WhatsApp message that may mix ${language} and English (Latin or native script). 
Return ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"pickup": string|null, "drop": string|null, "datePhrase": string|null, "timePhrase": string|null, "vehiclePreference": string|null, "passengerCount": number|null, "tripTypeHint": "ONE_WAY"|"ROUND_TRIP"|"AIRPORT"|"HOURLY"|null, "rentalHoursHint": number|null}
Only fill fields explicitly present in the message. Do not guess a city if none is mentioned. Do not resolve dates yourself — return the phrase as the user said it (e.g. "tomorrow", "next Sunday", "ನಾಳೆ").`;

  const raw = await callAI({
    system,
    messages: [{ role: 'user', content: text }],
    maxTokens: 300,
  });

  if (!raw) {
    return { pickup: null, drop: null, datePhrase: null, timePhrase: null, vehiclePreference: null, passengerCount: null, tripTypeHint: null, rentalHoursHint: null };
  }

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    logger.warn({ raw }, '[intentExtractor] failed to parse AI entity JSON');
    return { pickup: null, drop: null, datePhrase: null, timePhrase: null, vehiclePreference: null, passengerCount: null, tripTypeHint: null, rentalHoursHint: null };
  }
}

module.exports = { INTENTS, ruleBasedIntent, extractEntities };
