'use strict';

/**
 * src/middlewares/loadShed.js   — Day 14
 *
 * Backpressure. When the process is overloaded, reject new work FAST with a 503
 * instead of accepting it into an ever-growing queue.
 *
 * ---------------------------------------------------------------------------
 * WHY EVENT-LOOP LAG IS THE RIGHT SIGNAL
 * ---------------------------------------------------------------------------
 * Node is single-threaded. When the process is saturated — CPU-bound work, a
 * slow dependency backing everything up — callbacks wait longer and longer to
 * run. That delay IS event-loop lag, and it is the earliest honest signal that
 * the process can no longer keep its promises.
 *
 * A server with no backpressure keeps accepting requests it cannot serve: the
 * queue grows, every response gets slower, timeouts cascade, and it falls over
 * having done no useful work. Shedding instead means: once lag crosses a
 * threshold, new requests get an immediate 503 + Retry-After. Clients back off,
 * the queue drains, and the requests already in flight actually complete. You
 * serve fewer requests, but you serve them — a graceful degradation rather than
 * a collapse.
 *
 * We measure lag with a self-correcting timer: schedule a check for T ms from
 * now, see how late it actually fired, and smooth it with an EWMA so a single
 * GC pause does not trip the breaker.
 */

const env = require('../config/env');

const SAMPLE_MS = 500;   // how often we probe the loop
const EWMA_ALPHA = 0.3;  // smoothing; higher = more reactive

// Threshold in ms of measured lag. Above this we start shedding. Configurable —
// a small box needs a lower bar than a big one. Default 250ms: comfortably above
// normal jitter, well below the point where users have given up.
const LAG_LIMIT_MS = Number(process.env.LOADSHED_LAG_MS || 250);

// Never shed these — a 503 on a health check would make an orchestrator kill a
// pod that is merely busy, and shedding webhooks would drop money events a
// gateway will not always retry politely.
const EXEMPT = [/^\/health/, /^\/api\/v1\/webhooks\//];

let lag = 0;
let last = Date.now();

// Self-correcting lag probe. If we asked for 500ms and it fired at 560ms, the
// loop was 60ms behind. EWMA-smoothed so one hiccup does not trip shedding.
const timer = setInterval(() => {
  const now = Date.now();
  const drift = Math.max(0, now - last - SAMPLE_MS);
  lag = EWMA_ALPHA * drift + (1 - EWMA_ALPHA) * lag;
  last = now;
}, SAMPLE_MS);

// Do not keep the process alive solely for this probe.
if (timer.unref) timer.unref();

let shedding = false;
let sheddingSince = 0;
let shedCount = 0;

function currentLag() {
  return Math.round(lag);
}

function middleware(req, res, next) {
  if (EXEMPT.some((re) => re.test(req.path))) return next();

  if (lag > LAG_LIMIT_MS) {
    if (!shedding) {
      shedding = true;
      sheddingSince = Date.now();
      console.warn(`[loadshed] shedding ON — lag ${currentLag()}ms > ${LAG_LIMIT_MS}ms`);
    }
    shedCount += 1;
    res.set('Retry-After', '2');
    return res.status(503).json({
      success: false,
      error: {
        code: 'SERVER_BUSY',
        message: 'Server is briefly overloaded; retry shortly.',
      },
    });
  }

  if (shedding) {
    shedding = false;
    console.warn(`[loadshed] shedding OFF — recovered after ${Date.now() - sheddingSince}ms, ${shedCount} shed`);
    shedCount = 0;
  }
  return next();
}

function stats() {
  return { lagMs: currentLag(), limitMs: LAG_LIMIT_MS, shedding, shedCount };
}

module.exports = { middleware, stats, currentLag };