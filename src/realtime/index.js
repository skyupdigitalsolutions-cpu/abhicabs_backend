'use strict';

/**
 * src/realtime/index.js   — Day 10
 *
 * Owns the Socket.IO server: creates it on the existing HTTP server, wires the
 * auth handshake, attaches the Redis adapter for multi-instance fan-out, and
 * manages the connection lifecycle (join rooms, watch bookings, disconnect).
 *
 * ---------------------------------------------------------------------------
 * WHY THE REDIS ADAPTER  (the "multi-instance safe" requirement)
 * ---------------------------------------------------------------------------
 * With more than one API instance behind a load balancer, a customer's socket
 * lands on instance A while the dispatcher's lands on instance B. A trip update
 * emitted on B must still reach the customer on A. Socket.IO's default adapter
 * only knows about sockets on its OWN process, so the customer would hear
 * nothing.
 *
 * The Redis adapter fixes this: every emit is published to Redis, every
 * instance is subscribed, so a broadcast on any instance reaches sockets on all
 * of them. It uses a pub/sub channel — NOT the cache keyspace — so eviction
 * does not apply; we build it on dedicated duplicate connections.
 *
 * Redis is degradable here, consistent with the rest of the app: if it is down
 * at boot we still start, just without cross-instance fan-out. Single-instance
 * dev (and the two-tab done-line test) works either way.
 */

const { Server } = require('socket.io');
const env = require('../config/env');
const { authenticateSocket } = require('./auth');
const rooms = require('./rooms');

let io = null;

/**
 * Attaches Socket.IO to the given HTTP server. Call once, from server.js, after
 * the HTTP server exists and Redis has had its chance to connect.
 *
 * Async because the Redis adapter's pub/sub connections must be READY before the
 * adapter subscribes on them — otherwise ioredis (configured to fail fast, no
 * offline queue) throws "Stream isn't writeable" from inside the adapter.
 */
async function init(httpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    // Same origin allow-list the REST API uses. A socket connection is a
    // cross-origin request too, so it needs the same gate.
    cors: {
      origin(origin, callback) {
        // In development, allow any origin — the test page runs from file://
        // (a null/file origin) and localhost pages vary by port, and none of
        // that should need to be enumerated in CORS_ORIGINS to test locally.
        if (env.nodeEnv !== 'production') return callback(null, true);
        // Non-browser clients (no Origin) and allow-listed origins pass.
        if (!origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Origin not allowed'), false);
      },
      credentials: true,
    },
    // Give a backgrounded mobile app room to miss a heartbeat or two before we
    // call it disconnected — see the mobile note in the connection handler.
    pingInterval: 25_000,
    pingTimeout: 60_000,
  });

  await attachRedisAdapter(io);

  // Authenticate BEFORE any connection event fires. A socket that fails here
  // never reaches handleConnection.
  io.use(authenticateSocket);

  io.on('connection', handleConnection);

  console.log('[realtime] Socket.IO ready');
  return io;
}

/**
 * Wires the Redis adapter using two DEDICATED pub/sub connections.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST duplicate() THE CACHE CLIENT
 * ---------------------------------------------------------------------------
 * The cache client is configured to FAIL FAST: enableOfflineQueue is false, so
 * a command issued before the socket is writeable throws immediately. That is
 * right for a cache (a queued read that resolves late is worse than a miss), but
 * WRONG for the adapter: it calls psubscribe the instant it is constructed, and
 * if the duplicated connection has not finished its handshake yet, ioredis
 * throws "Stream isn't writeable" — an async throw the constructor cannot catch,
 * which becomes an unhandled rejection and takes the process down.
 *
 * So we build fresh connections from the same URL with offline queue ENABLED,
 * and — crucially — WAIT for both to be ready before handing them to the
 * adapter. Any failure degrades to the in-memory adapter (single-instance);
 * boot never fails on account of this.
 */
async function attachRedisAdapter(server) {
  let pubClient;
  let subClient;
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const Redis = require('ioredis');

    const url = env.redis.cacheUrl;
    // Fresh clients, NOT duplicated: offline queue on (so an early subscribe is
    // buffered, not thrown), no keyPrefix (the adapter manages its own channel
    // names and a prefix would corrupt them), lazy so we control connect timing.
    const opts = {
      enableOfflineQueue: true,
      maxRetriesPerRequest: null, // pub/sub connections should not cap retries
      lazyConnect: true,
    };
    pubClient = new Redis(url, opts);
    subClient = new Redis(url, opts);

    pubClient.on('error', (e) => logAdapterError('pub', e));
    subClient.on('error', (e) => logAdapterError('sub', e));

    // Connect and WAIT. If either cannot connect within the timeout, bail to the
    // in-memory adapter rather than hanging or crashing.
    await Promise.race([
      Promise.all([pubClient.connect(), subClient.connect()]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 8_000)),
    ]);

    server.adapter(createAdapter(pubClient, subClient));
    console.log('[realtime] Redis adapter attached (multi-instance fan-out on)');
  } catch (err) {
    console.warn(
      `[realtime] Redis adapter unavailable (${err.message}) — ` +
      'running single-instance. Cross-instance broadcasts are off; ' +
      'the app and the two-tab test still work.'
    );
    // Tidy up half-open connections so they do not emit further errors.
    try { pubClient && pubClient.disconnect(); } catch (_) { /* noop */ }
    try { subClient && subClient.disconnect(); } catch (_) { /* noop */ }
    // Do NOT rethrow — single-instance is a valid, working mode.
  }
}

let adapterErrCount = 0;
function logAdapterError(which, err) {
  adapterErrCount += 1;
  if (adapterErrCount % 20 === 1) {
    console.error(`[realtime] adapter ${which} error: ${err.message}`);
  }
}

/**
 * A socket has connected AND authenticated. socket.user is set.
 */
function handleConnection(socket) {
  const { user } = socket;

  // Auto-join the rooms this identity always belongs to (dispatch/admin for
  // ops, the driver's own channel for a driver). Customers join nothing here.
  for (const room of rooms.defaultRoomsFor(user)) {
    socket.join(room);
  }

  // Tell the client who we think it is and what it is subscribed to, so a
  // reconnecting mobile app can confirm state without a REST round-trip.
  socket.emit('ready', {
    userId: user.id,
    role: user.role,
    rooms: [...socket.rooms].filter((r) => r !== socket.id),
    at: new Date().toISOString(),
  });

  /* ---- watch/unwatch a specific booking ---- */

  // A client asks to receive live updates for one booking. We only let them
  // into a booking room they are entitled to: the owner, or any ops/admin user.
  socket.on('booking:watch', async (bookingId, ack) => {
    try {
      const allowed = await canWatchBooking(user, bookingId);
      if (!allowed) {
        if (typeof ack === 'function') ack({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      socket.join(rooms.booking(bookingId));
      if (typeof ack === 'function') ack({ ok: true, room: rooms.booking(bookingId) });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: 'WATCH_FAILED' });
    }
  });

  socket.on('booking:unwatch', (bookingId, ack) => {
    socket.leave(rooms.booking(bookingId));
    if (typeof ack === 'function') ack({ ok: true });
  });

  /* ---- mobile reality: disconnect on background, reconnect + re-sync ---- */

  // A mobile client that was backgrounded reconnects with a fresh socket. The
  // socket auto-rejoins its default rooms (above), but any booking rooms it was
  // watching are gone. Rather than trust the socket to replay live events it
  // may have missed while asleep, the client re-fetches current state over REST
  // and then re-watches. This event lets it re-declare its booking watches in
  // one round-trip on reconnect.
  socket.on('resync', async (bookingIds, ack) => {
    const list = Array.isArray(bookingIds) ? bookingIds.slice(0, 50) : [];
    const rejoined = [];
    for (const id of list) {
      // eslint-disable-next-line no-await-in-loop
      if (await canWatchBooking(user, id)) {
        socket.join(rooms.booking(id));
        rejoined.push(id);
      }
    }
    if (typeof ack === 'function') ack({ ok: true, watching: rejoined });
  });

  socket.on('disconnect', (reason) => {
    // Nothing to clean up manually — Socket.IO removes the socket from all its
    // rooms on disconnect. Logged at debug level only; a backgrounded mobile
    // app disconnecting is normal, not an error.
    if (env.nodeEnv !== 'production') {
      console.log(`[realtime] ${user.role} ${user.id} disconnected (${reason})`);
    }
  });
}

/**
 * May this user watch this booking's room? Owner or any ops/admin.
 * Kept here (not in a service) because it is purely a room-access decision.
 */
async function canWatchBooking(user, bookingId) {
  if (!bookingId || typeof bookingId !== 'string') return false;
  if (['ADMIN', 'OPS'].includes(user.role)) return true;

  const { prisma } = require('../config/prisma');
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { customerId: true },
  });
  return !!booking && booking.customerId === user.id;
}

/** Accessor for the bridge and any emitter. Throws if init() has not run. */
function getIO() {
  if (!io) throw new Error('[realtime] getIO() called before init()');
  return io;
}

module.exports = { init, getIO, rooms };