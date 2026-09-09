'use strict';

/**
 * src/services/providers/storage.provider.js
 *
 * File/image storage behind an interface — same reasoning as the maps, payment
 * and notify providers. The mock returns a deterministic fake URL so the entire
 * upload pipeline (route -> multer -> service -> DB) works offline with no
 * account and no cost. Switching to Cloudinary is one env var + credentials.
 *
 * Contract:
 *   upload({ buffer, mimetype, folder, publicId? })
 *       -> { url, publicId, bytes, format, width?, height?, provider }
 *   destroy(publicId) -> { deleted, provider }
 */

const crypto = require('crypto');
const env = require('../../config/env');

/* --------------------------------- mock ---------------------------------- */

const mock = {
  name: 'mock',
  async upload({ buffer, mimetype = 'image/jpeg', folder = 'misc', publicId }) {
    const id = publicId || crypto.randomUUID();
    const ext = (mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const key = `${folder}/${id}`;
    // Deterministic, obviously-fake URL so it's clear this wasn't a real upload.
    const url = `https://mock-storage.local/${key}.${ext}`;
    // eslint-disable-next-line no-console
    console.log(`[storage:mock] stored ${key} (${buffer ? buffer.length : 0} bytes) -> ${url}`);
    return { url, publicId: key, bytes: buffer ? buffer.length : 0, format: ext, provider: 'mock' };
  },
  async destroy(publicId) {
    // eslint-disable-next-line no-console
    console.log(`[storage:mock] destroy ${publicId}`);
    return { deleted: true, provider: 'mock' };
  },
};

/* ------------------------------ cloudinary ------------------------------- */

function makeCloudinary() {
  // Lazily require so the dependency is only needed when actually selected.
  // eslint-disable-next-line global-require, import/no-unresolved
  const cloudinary = require('cloudinary').v2;
  const c = env.storage.cloudinary;
  cloudinary.config({
    cloud_name: c.cloudName,
    api_key: c.apiKey,
    api_secret: c.apiSecret,
    secure: true,
  });

  return {
    name: 'cloudinary',
    async upload({ buffer, folder = 'misc', publicId, resourceType = 'image' }) {
      const base = env.storage.cloudinary.folder;
      const fullFolder = base ? `${base}/${folder}` : folder;
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: fullFolder, public_id: publicId, resource_type: resourceType, overwrite: true },
          (err, res) => (err ? reject(err) : resolve(res)),
        );
        stream.end(buffer);
      });
      return {
        url: result.secure_url,
        publicId: result.public_id, // store this so the file can be deleted/replaced later
        bytes: result.bytes,
        format: result.format,
        width: result.width,
        height: result.height,
        provider: 'cloudinary',
      };
    },
    async destroy(publicId) {
      const res = await cloudinary.uploader.destroy(publicId);
      return { deleted: res.result === 'ok', provider: 'cloudinary' };
    },
  };
}

/* -------------------------------- factory -------------------------------- */

function selectProvider() {
  const want = env.storage.provider;
  if (want === 'cloudinary') {
    const c = env.storage.cloudinary;
    if (c.cloudName && c.apiKey && c.apiSecret) {
      try {
        return makeCloudinary();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[storage] cloudinary selected but init failed (${err.message}); falling back to mock`);
        return mock;
      }
    }
    // eslint-disable-next-line no-console
    console.warn('[storage] cloudinary selected but credentials incomplete; falling back to mock');
    return mock;
  }
  return mock;
}

const provider = selectProvider();

module.exports = { provider };