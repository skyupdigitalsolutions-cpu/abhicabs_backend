'use strict';

/**
 * src/config/env.js
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

  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Super Admin',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@example.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
  },
};

if (env.accessSecret === env.refreshSecret) {
  throw new Error('[env] JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
}

module.exports = env;