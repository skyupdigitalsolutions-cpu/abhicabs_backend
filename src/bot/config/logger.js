const pino = require('pino');
const env = require('./env');

const SENSITIVE_KEYS = [
  'access_token',
  'accessToken',
  'password',
  'secret',
  'api_key',
  'apiKey',
  'razorpay_key_secret',
  'card',
  'cvv',
];

/**
 * Recursively mask sensitive fields before logging.
 * Never log raw tokens, secrets, or full card/payment details.
 */
function maskSensitive(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitive);

  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_KEYS.some((k) => key.toLowerCase().includes(k.toLowerCase()));
    if (isSensitive) {
      out[key] = '***REDACTED***';
    } else if (typeof value === 'object') {
      out[key] = maskSensitive(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-webhook-secret"]',
      'req.headers["x-admin-key"]',
      'req.headers["x-razorpay-signature"]',
      'req.headers.cookie',
      '*.accessToken',
      '*.access_token',
      '*.password',
      '*.secret',
      '*.apiKey',
      '*.api_key',
    ],
    censor: '***REDACTED***',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = { logger, maskSensitive };
