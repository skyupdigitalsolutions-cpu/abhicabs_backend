'use strict';

/**
 * src/lib/redact.js   — Day 14
 *
 * Strips secrets and personal data from anything before it reaches a log line.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MATTERS
 * ---------------------------------------------------------------------------
 * Logs leak. They get shipped to third-party aggregators, screen-shared, pasted
 * into tickets, and retained for months. An access token, OTP, or card-ish
 * number that lands in a log is a credential sitting in plaintext somewhere you
 * do not control. The error handler logs whole error objects — which can carry
 * the request body — so a login error could otherwise log the password attempt.
 *
 * redact() walks an object and masks any field whose NAME looks sensitive, plus
 * any VALUE that looks like a JWT. It is deep, cycle-safe, and never throws (a
 * logging helper that can throw is worse than the leak it prevents).
 */

// Field names (case-insensitive substring match) whose values are masked.
const SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization', 'auth',
  'secret', 'apikey', 'api_key', 'authkey', 'privatekey',
  'otp', 'code', 'pin',
  'cvv', 'cvc', 'cardnumber', 'card_number', 'pan',
  'ssn', 'aadhaar', 'aadhar',
  'cookie', 'set-cookie', 'session',
  'signature', 'x-razorpay-signature',
];

// Value shapes that are always secrets regardless of field name.
const JWT_RE = /\beyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\b/g;
const BEARER_RE = /\bBearer\s+[a-zA-Z0-9._-]+/gi;
const LONG_DIGITS_RE = /\b\d{12,19}\b/g; // card/aadhaar-length digit runs

const MASK = '[REDACTED]';
const MAX_DEPTH = 6;

function keyIsSensitive(key) {
  const k = String(key).toLowerCase();
  return SENSITIVE_KEYS.some((s) => k.includes(s));
}

function maskString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(JWT_RE, MASK)
    .replace(BEARER_RE, `Bearer ${MASK}`)
    .replace(LONG_DIGITS_RE, MASK);
}

/**
 * Partial phone mask: keep the last 4 so a support agent can still match a
 * customer, without logging the whole number. "9876500011" -> "******0011".
 */
function maskPhone(value) {
  const s = String(value);
  if (!/^\+?\d{7,15}$/.test(s)) return value;
  return s.slice(0, -4).replace(/./g, '*') + s.slice(-4);
}

function redact(input, depth = 0, seen = new WeakSet()) {
  try {
    if (input == null) return input;
    if (typeof input === 'string') return maskString(input);
    if (typeof input !== 'object') return input;

    if (seen.has(input)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    seen.add(input);

    if (Array.isArray(input)) {
      return input.map((v) => redact(v, depth + 1, seen));
    }

    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (keyIsSensitive(key)) {
        out[key] = MASK;
      } else if (/^phone|mobile|msisdn$/i.test(key)) {
        out[key] = maskPhone(value);
      } else if (typeof value === 'object' && value !== null) {
        out[key] = redact(value, depth + 1, seen);
      } else if (typeof value === 'string') {
        out[key] = maskString(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  } catch (_) {
    return '[Unredactable]';
  }
}

/**
 * Convenience for the error handler: given an Error, return a safe plain object
 * (message + code + redacted meta), never the raw object that may carry a body.
 */
function redactError(err) {
  if (!err) return err;
  return {
    name: err.name,
    message: maskString(String(err.message || '')),
    code: err.code || err.errorCode || undefined,
    // Deliberately NOT including err.stack verbatim in production callers; the
    // caller decides. Any attached meta is redacted.
    meta: err.meta ? redact(err.meta) : undefined,
  };
}

module.exports = { redact, redactError, maskString };