'use strict';

/**
 * src/middlewares/upload.js
 *
 * Multipart file intake using multer's in-memory storage — the buffer is handed
 * straight to the storage service (Cloudinary/mock), so nothing is ever written
 * to the API server's disk. Size and MIME limits come from env.storage.
 *
 * Usage:  router.post('/x', uploadSingle('photo'), validate({...}), ctrl.x)
 *         -> req.file.buffer / req.file.mimetype available in the controller.
 */

const multer = require('multer');
const env = require('../config/env');
const { ApiError } = require('../utils/helpers');

const storage = multer.memoryStorage();

const limits = { fileSize: env.storage.maxUploadBytes, files: 1 };

function fileFilter(_req, file, cb) {
  if (env.storage.allowedMime.includes(file.mimetype)) return cb(null, true);
  return cb(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported file type ${file.mimetype}`));
}

const uploader = multer({ storage, limits, fileFilter });

/** Accept an OPTIONAL single file under `field`; convert multer errors to ApiError. */
function uploadSingle(field) {
  const handler = uploader.single(field);
  return (req, res, next) =>
    handler(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(413, 'FILE_TOO_LARGE', 'File too large'));
        }
        return next(new ApiError(400, 'UPLOAD_ERROR', err.message));
      }
      return next(err); // already an ApiError (e.g. from fileFilter)
    });
}

module.exports = { uploadSingle };