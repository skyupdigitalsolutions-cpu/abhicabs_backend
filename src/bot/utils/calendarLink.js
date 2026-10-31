const crypto = require('crypto');
const env = require('../config/env');

// Signed, short-lived links to the calendar page. The link carries who it is for and the
// first/last date that can be picked; nothing in it is trusted without its signature.
const secret = () => env.CALENDAR_LINK_SECRET || env.MSG91_WEBHOOK_SECRET;
const enabled = () => Boolean(env.PUBLIC_BASE_URL && secret());
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

// kind: 'date' (calendar page), 'routemap' (pickup + drop map page), 'pickup' or 'drop' (older pages). A link only works for its own kind.
function createToken({ number, min = null, max = null, returnTrip = false, kind = 'date', near = null, extra = null, ttlMinutes = 60 }) {
  const payload = Buffer.from(
    JSON.stringify({ n: number, a: min, b: max, r: returnTrip ? 1 : 0, k: kind, c: near, x: extra, e: Date.now() + ttlMinutes * 60000 })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Returns { number, min, max, returnTrip, kind, near } for a valid, unexpired token, otherwise null. */
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2000 || !secret()) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const given = Buffer.from(sig);
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!p.e || Date.now() > p.e) return null;
    return { number: p.n, min: p.a, max: p.b, returnTrip: !!p.r, kind: p.k || 'date', near: p.c || null, extra: p.x || null };
  } catch {
    return null;
  }
}

const linkFor = (token, path = 'calendar') => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/${path}/${token}`;

module.exports = { enabled, createToken, verifyToken, linkFor };
