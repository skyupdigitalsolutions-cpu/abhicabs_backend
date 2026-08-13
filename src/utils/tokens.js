'use strict';

/**
 * src/utils/tokens.js
 *
 * Access token  = JWT, 15 minutes, sent in the Authorization header.
 * Refresh token = JWT signed with a SEPARATE secret, 7 days, and ALSO stored
 *                 in the database as a SHA-256 hash so it can be revoked.
 *
 * Why store a hash of the refresh token: a plain JWT cannot be revoked before
 * it expires. Keeping a row per issued refresh token lets you log a user out
 * everywhere, and lets you detect a stolen token being replayed.
 *
 * Why SHA-256 and not bcrypt for that hash: the token is high-entropy random
 * data, not a guessable password, so key stretching adds latency for nothing.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

/* ---------------------------------------------------------------- *
 * Access token
 * ---------------------------------------------------------------- */

/**
 * Keep the payload minimal — anyone holding the token can read it, and it is
 * re-sent on every single request.
 */
function signAccessToken({ userId, role }) {
  return jwt.sign({ role, typ: 'access' }, env.accessSecret, {
    subject: String(userId),
    expiresIn: env.accessTokenTtl,
    algorithm: 'HS256',
  });
}

function verifyAccessToken(token) {
  // `algorithms` is pinned explicitly. Omitting it is how the classic
  // "alg: none" and algorithm-confusion attacks get in.
  const payload = jwt.verify(token, env.accessSecret, { algorithms: ['HS256'] });
  if (payload.typ !== 'access') {
    throw new jwt.JsonWebTokenError('Wrong token type');
  }
  return payload;
}

/* ---------------------------------------------------------------- *
 * Refresh token
 * ---------------------------------------------------------------- */

function signRefreshToken({ userId }) {
  return jwt.sign(
    { typ: 'refresh', jti: crypto.randomUUID() },
    env.refreshSecret,
    {
      subject: String(userId),
      expiresIn: `${env.refreshTokenTtlDays}d`,
      algorithm: 'HS256',
    }
  );
}

function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.refreshSecret, { algorithms: ['HS256'] });
  if (payload.typ !== 'refresh') {
    throw new jwt.JsonWebTokenError('Wrong token type');
  }
  return payload;
}

/** What actually gets stored in the refresh_tokens table. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiryDate() {
  return new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  refreshExpiryDate,
};