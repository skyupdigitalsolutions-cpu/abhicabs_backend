'use strict';

/**
 * src/middlewares/rateLimit.js   — FIXED
 *
 * Redis-backed rate limiters with automatic failover to in-process memory.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS MORE THAN `new RedisStore(...)`
 * ---------------------------------------------------------------------------
 * Two problems with using RedisStore directly, both found by running it:
 *
 * 1. UNHANDLED REJECTION AT BOOT.
 *    rate-limit-redis's constructor eagerly loads its Lua scripts and stores the
 *    UNRESOLVED promises:
 *
 *        this.incrementScriptSha = this.loadIncrementScript();
 *
 *    Nothing attaches a .catch(). Redis is never connected at require time, so
 *    those promises reject with no handler — and in modern Node an unhandled
 *    rejection terminates the process. A try/catch around `new RedisStore()`
 *    does NOT help, because the failure is asynchronous.
 *
 * 2. A REDIS OUTAGE WOULD RETURN 500.
 *    express-rate-limit passes a store error to next(err), so a cache outage
 *    would break /auth/login completely — turning a degradation into an outage,
 *    which is the opposite of a rate limiter's purpose.
 *
 * FailoverStore fixes both: it swallows the constructor rejection (the library
 * reloads its scripts on first use, so it self-heals) and falls back to a
 * MemoryStore whenever a Redis call fails.
 *
 * The degraded trade-off is explicit and acceptable: with N instances an
 * in-memory limit of 10 becomes an effective 10*N. Weaker protection for the
 * duration of the outage, but the endpoint keeps serving.
 */

const { rateLimit, MemoryStore } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { cache: redis } = require('../config/redis');

/* ------------------------------------------------------------------ *
 * FailoverStore
 * ------------------------------------------------------------------ */

class FailoverStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.memory = new MemoryStore();
    this.usingMemory = false;
    this.loggedFallback = false;

    this.redisStore = new RedisStore({
      // rate-limit-redis needs raw command access; ioredis exposes .call
      sendCommand: (...args) => redis.call(...args),
      prefix: `rl:${prefix}:`,
    });

    // Swallow the constructor's eager script-load rejections. Safe because
    // retryableIncrement() reloads the script on its first failure, so the store
    // recovers by itself once Redis is reachable.
    for (const p of [this.redisStore.incrementScriptSha, this.redisStore.getScriptSha]) {
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  init(options) {
    this.memory.init(options);
    this.redisStore.init(options);
  }

  /** Marks the store degraded and logs ONCE, not per request. */
  fallback(err) {
    this.usingMemory = true;
    if (!this.loggedFallback) {
      this.loggedFallback = true;
      console.warn(
        `[ratelimit:${this.prefix}] Redis unavailable (${err.message}) — ` +
        'falling back to in-process counters. Limits are now per-instance.'
      );
    }
  }

  async increment(key) {
    // Skip Redis while it is known down — no point paying a timeout on every
    // request for the duration of an outage.
    if (redis.status !== 'ready') {
      this.usingMemory = true;
      return this.memory.increment(key);
    }

    try {
      const result = await this.redisStore.increment(key);
      if (this.usingMemory) {
        this.usingMemory = false;
        this.loggedFallback = false;
        console.log(`[ratelimit:${this.prefix}] Redis recovered — shared counters resumed`);
      }
      return result;
    } catch (err) {
      this.fallback(err);
      return this.memory.increment(key);
    }
  }

  async decrement(key) {
    if (redis.status !== 'ready') return this.memory.decrement(key);
    try {
      return await this.redisStore.decrement(key);
    } catch (err) {
      return this.memory.decrement(key);
    }
  }

  async resetKey(key) {
    // Reset both, so a support-triggered unlock works regardless of which store
    // is currently authoritative.
    await Promise.allSettled([
      redis.status === 'ready' ? this.redisStore.resetKey(key) : Promise.resolve(),
      this.memory.resetKey(key),
    ]);
  }

  async get(key) {
    if (redis.status !== 'ready') return this.memory.get(key);
    try {
      return await this.redisStore.get(key);
    } catch (err) {
      return this.memory.get(key);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Limiter factory
 * ------------------------------------------------------------------ */

const message = (msg) => ({
  success: false,
  error: { code: 'RATE_LIMITED', message: msg },
});

function make({ name, windowMs, max, keyGenerator, msg }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new FailoverStore(name),
    keyGenerator,
    message: message(msg),
  });
}

/* ------------------------------------------------------------------ *
 * Tiers
 * ------------------------------------------------------------------ */

/** Password login and register. */
const authLimiter = make({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  max: 10,
  msg: 'Too many attempts. Try again in 15 minutes.',
});

/**
 * OTP request. Keyed by ip AND phone together, so one abusive IP cannot lock out
 * a phone number and one abusive number cannot lock out a whole office.
 *
 * otp.service adds a 30s cooldown and a daily cap on top; this is the outer edge.
 */
const otpRequestLimiter = make({
  name: 'otpreq',
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip}:${req.body?.phone || 'none'}`,
  msg: 'Too many code requests. Please wait before trying again.',
});

/** OTP verification — bounds brute force at the HTTP edge. */
const otpVerifyLimiter = make({
  name: 'otpver',
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => `${req.ip}:${req.body?.phone || 'none'}`,
  msg: 'Too many verification attempts. Request a new code.',
});

/** Refresh: generous, but not unlimited. */
const refreshLimiter = make({
  name: 'refresh',
  windowMs: 60 * 1000,
  max: 30,
  msg: 'Too many refresh attempts.',
});

/** Default ceiling for authenticated API use. Keyed by user when known. */
const apiLimiter = make({
  name: 'api',
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req) => req.user?.id || req.ip,
  msg: 'Request rate exceeded. Please slow down.',
});

module.exports = {
  FailoverStore,
  authLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  refreshLimiter,
  apiLimiter,
};