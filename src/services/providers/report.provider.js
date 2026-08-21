'use strict';

/**
 * src/services/providers/report.provider.js   — Day 13
 *
 * Where a generated CSV export is STORED once the documents-queue job has built
 * it. Behind an interface, same reasoning as the payment/notify providers: the
 * whole export pipeline — enqueue, generate off the request path, store, hand
 * back a link — is built and tested today against a mock, and swapping in real
 * object storage (S3 / Cloudinary) later changes only this file.
 *
 * Contract:
 *   store({ token, filename, csv }) -> { token, url, bytes, expiresInSeconds }
 *   fetch(token)                    -> { filename, csv } | null
 *
 * MOCK: stores the CSV in Redis (the cache database) under an `export:<token>`
 * key with a TTL, and returns an in-app URL the client fetches via
 * GET /admin/reports/exports/:token. Redis is fine for the modest CSVs this
 * project produces and keeps the demo self-contained; in production the real
 * provider streams straight to object storage and returns a signed URL, so a
 * large export never sits in Redis.
 */

const { cache: redis, isCacheUp } = require('../../config/redis');
const env = require('../../config/env');

const PREFIX = 'export:';
const TTL = env.reporting.exportTtlSeconds;

const mock = {
  name: 'mock',

  async store({ token, filename, csv }) {
    const payload = JSON.stringify({ filename, csv, storedAt: new Date().toISOString() });
    if (isCacheUp()) {
      await redis.set(`${PREFIX}${token}`, payload, 'EX', TTL);
    }
    return {
      token,
      // In-app retrieval URL. A real provider would return a signed storage URL.
      url: `/api/v1/admin/reports/exports/${token}`,
      bytes: Buffer.byteLength(csv, 'utf8'),
      expiresInSeconds: TTL,
    };
  },

  async fetch(token) {
    if (!isCacheUp()) return null;
    const raw = await redis.get(`${PREFIX}${token}`);
    if (!raw) return null;
    try {
      const { filename, csv } = JSON.parse(raw);
      return { filename, csv };
    } catch (_) {
      return null;
    }
  },
};

// S3 stub — real integration when object storage is provisioned. Kept thin: the
// mock already proved the surrounding pipeline.
const s3 = {
  name: 's3',
  async store() {
    throw new Error('[report:s3] not implemented yet — set REPORT_STORAGE=mock');
  },
  async fetch() {
    throw new Error('[report:s3] not implemented yet — set REPORT_STORAGE=mock');
  },
};

function getProvider() {
  const name = (process.env.REPORT_STORAGE || 'mock').toLowerCase();
  if (name === 's3') return s3;
  return mock;
}

module.exports = { getProvider };