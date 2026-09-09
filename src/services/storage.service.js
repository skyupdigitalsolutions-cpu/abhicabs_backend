'use strict';

/**
 * src/services/storage.service.js
 *
 * The app-facing storage API. Controllers/services call this, never the provider
 * directly, so the storage backend (mock/Cloudinary/S3) stays swappable.
 */

const { provider } = require('./providers/storage.provider');
const { ApiError } = require('../utils/helpers');

/**
 * Upload one file buffer.
 * @param {Buffer} buffer
 * @param {object} opts { folder, mimetype, publicId? }
 * @returns {{url, publicId, bytes, format, provider, width?, height?}}
 */
async function uploadImage(buffer, { folder = 'misc', mimetype = 'image/jpeg', publicId } = {}) {
  if (!buffer || !buffer.length) {
    throw ApiError.badRequest('No file provided', 'NO_FILE');
  }
  return provider.upload({ buffer, folder, mimetype, publicId, resourceType: 'image' });
}

/** Delete a previously uploaded file by its stored publicId. */
async function destroy(publicId) {
  if (!publicId) return { deleted: false };
  return provider.destroy(publicId);
}

module.exports = { uploadImage, destroy, providerName: provider.name };