const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

const http = axios.create({
  baseURL: 'https://api.anthropic.com/v1',
  timeout: 8000,
  headers: {
    'x-api-key': env.AI_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
});

/**
 * IMPORTANT — scope of the AI layer:
 *   - Extracts intent + entities from free-text WhatsApp messages
 *     (mixed-language, casual phrasing).
 *   - Drafts natural-language phrasing for confirmations.
 *   - NEVER calculates a fare, invents a vehicle, invents a booking ID,
 *     or decides payment status. Those always come from
 *     integrations/abhicabs/* services, which are the single source of
 *     truth enforced by the tool architecture in conversation/*.
 */
async function callAI({ system, messages, maxTokens = 500 }) {
  if (!env.AI_API_KEY) {
    logger.warn('[ai] AI_API_KEY not set — falling back to rule-based NLU only');
    return null;
  }
  try {
    const res = await http.post('/messages', {
      model: env.AI_MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    });
    const textBlock = res.data.content.find((b) => b.type === 'text');
    return textBlock ? textBlock.text : null;
  } catch (err) {
    logger.error({ err: err.response?.data || err.message }, '[ai] call failed');
    return null; // caller must fall back gracefully — never block the flow on AI failure
  }
}

module.exports = { callAI };
