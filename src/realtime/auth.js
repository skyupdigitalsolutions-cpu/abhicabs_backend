'use strict';

/**
 * src/realtime/auth.js   — Day 10
 *
 * The connection handshake. A socket is authenticated ONCE, before it is
 * allowed to join any room — not per message. If the token is missing, invalid,
 * expired, or the account is gone/deactivated, the connection is refused here
 * and never reaches the room logic.
 *
 * ---------------------------------------------------------------------------
 * WHY RE-LOAD THE USER (same reasoning as requireAuth)
 * ---------------------------------------------------------------------------
 * A WebSocket connection is long-lived — it can outlast the token that opened
 * it by hours. We still verify the token's signature and expiry at connect, and
 * re-load the user from the database so a deactivated account cannot ride an
 * old-but-unexpired token onto the dispatch feed. (Revocation mid-connection is
 * a Day 12+ concern; at connect time we get it for free.)
 *
 * The client passes the access token the same way the mobile app will:
 *   const socket = io(URL, { auth: { token: accessToken } });
 * We also accept it in the Authorization header for browser tools that cannot
 * set the auth payload.
 */

const { verifyAccessToken } = require('../utils/tokens');
const { prisma } = require('../config/prisma');

function extractToken(socket) {
  // Preferred: Socket.IO auth payload.
  const fromAuth = socket.handshake.auth && socket.handshake.auth.token;
  if (fromAuth) return String(fromAuth).replace(/^Bearer\s+/i, '').trim();

  // Fallback: Authorization header (browser dev tools, curl-style clients).
  const header = socket.handshake.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();

  // Fallback: query string (?token=...), least preferred — tokens leak into
  // logs — but useful for a quick browser test.
  const q = socket.handshake.query && socket.handshake.query.token;
  return q ? String(q).trim() : null;
}

/**
 * Socket.IO middleware. Calls next() to accept, next(err) to refuse. The error
 * message reaches the client's `connect_error` handler.
 */
async function authenticateSocket(socket, next) {
  try {
    const token = extractToken(socket);
    if (!token) return next(new Error('AUTH_REQUIRED'));

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      return next(new Error(err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'));
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    if (!user) return next(new Error('USER_NOT_FOUND'));
    if (!user.isActive) return next(new Error('ACCOUNT_INACTIVE'));

    // Attach the identity to the socket for the connection's lifetime. Room
    // decisions and per-message authorisation read from here, never from a
    // value the client sent.
    socket.user = user;
    return next();
  } catch (err) {
    return next(new Error('HANDSHAKE_FAILED'));
  }
}

module.exports = { authenticateSocket };