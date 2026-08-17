'use strict';

/**
 * src/config/env.js   — UPDATED for Day 2 (Redis + OTP)
 *
 * Loads and validates environment variables ONCE at boot.
 * Failing loudly here is far better than a confusing runtime error later.
 */

require('dotenv').config();

function required(key, { min } = {}) {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`[env] Missing required variable: ${key}`);
  }
  if (min && value.length < min) {
    throw new Error(`[env] ${key} must be at least ${min} characters`);
  }
  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 5000),

  databaseUrl: required('DATABASE_URL'),

  // Two DIFFERENT secrets. Using one secret for both token types means a
  // stolen access token could be replayed as a refresh token.
  accessSecret: required('JWT_ACCESS_SECRET', { min: 32 }),
  refreshSecret: required('JWT_REFRESH_SECRET', { min: 32 }),

  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7),

  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  /* ---------------- Redis ---------------- */
  redis: {
    // Upstash gives a rediss:// URL. ioredis enables TLS from the scheme.
    cacheUrl: required('REDIS_URL'),

    // A SECOND Upstash database, with eviction DISABLED. Optional today;
    // required before BullMQ jobs go in on Day 12, because the cache database
    // uses allkeys-lru and would evict pending jobs under memory pressure.
    queueUrl: process.env.REDIS_QUEUE_URL || '',

    prefix: process.env.REDIS_PREFIX || 'abhi:',
  },

  /* ---------------- OTP ---------------- */
  otp: {
    length: Number(process.env.OTP_LENGTH || 6),
    ttlSeconds: Number(process.env.OTP_TTL_SECONDS || 300),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
    resendCooldownSeconds: Number(process.env.OTP_RESEND_COOLDOWN || 30),

    // SMS pumping fraud: attackers trigger OTPs to premium-rate numbers and
    // take a cut of the carrier revenue. This cap bounds the damage.
    maxPerDay: Number(process.env.OTP_MAX_PER_DAY || 10),

    // true = print the code to the server console instead of sending it.
    devMode: process.env.OTP_DEV_MODE !== 'false',
  },

  /* ---------------- Maps ---------------- */
  maps: {
    // mock | google | ola
    //
    // Defaults to mock: no API key, no network, no cost. Distances come from
    // the haversine formula times a road-detour factor, which is close enough
    // to develop and test the fare engine, booking flow and dispatch against.
    //
    // Falls back to mock automatically if a real provider is selected without
    // a key — a missing key should degrade fare accuracy, not take the app down.
    provider: process.env.MAPS_PROVIDER || 'mock',
    apiKey: process.env.MAPS_API_KEY || '',

    // A slow maps provider must not become a slow API. On timeout the request
    // falls back to an arithmetic estimate rather than failing.
    timeoutMs: Number(process.env.MAPS_TIMEOUT_MS || 5000),

    // Circuit breaker: after N consecutive failures, stop calling the provider
    // and use estimates for the cooldown. Retrying a dead API on every request
    // just adds latency to a failure you already know about.
    breakerThreshold: Number(process.env.MAPS_BREAKER_THRESHOLD || 5),
    breakerCooldownMs: Number(process.env.MAPS_BREAKER_COOLDOWN_MS || 30000),
  },

  /* ---------------- MSG91 (unused until DLT approval) ---------------- */
  msg91: {
    authKey: process.env.MSG91_AUTH_KEY || '',
    templateId: process.env.MSG91_OTP_TEMPLATE_ID || '',
    senderId: process.env.MSG91_SENDER_ID || '',
  },

  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Super Admin',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@example.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
  },
};

if (env.accessSecret === env.refreshSecret) {
  throw new Error('[env] JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
}

if (env.isProd && env.otp.devMode) {
  throw new Error(
    '[env] OTP_DEV_MODE must be "false" in production — otherwise codes are ' +
    'only printed to the server console and nobody can log in.'
  );
}

module.exports = env;