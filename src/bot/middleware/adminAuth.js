const crypto = require('crypto');
const env = require('../config/env');

function requireAdminKey(req, res, next) {
  if (!env.ADMIN_API_KEY) return res.status(503).json({ error: 'Admin API disabled: set ADMIN_API_KEY' });
  const a = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const b = Buffer.from(env.ADMIN_API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

module.exports = { requireAdminKey };
