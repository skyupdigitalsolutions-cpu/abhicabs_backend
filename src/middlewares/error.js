'use strict';

/**
 * src/middlewares/error.js
 *
 * Every error in the app ends up here and becomes a consistent JSON response.
 *
 * The key idea: database constraint violations are EXPECTED outcomes, not
 * bugs. A unique violation on `email` means someone tried to register twice —
 * translate it to a clean 409 instead of letting it surface as a 500.
 */

const db = require('../config/prisma');
const env = require('../config/env');

function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` },
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Express requires the 4-argument signature; `next` must stay declared.

  let status = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Something went wrong';
  let fields;

  // ---- Zod validation -------------------------------------------------
  if (err.name === 'ZodError') {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid request data';
    fields = (err.issues || []).map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
  }

  // ---- Prisma ----------------------------------------------------------
  else if (db.isUniqueViolation(err)) {
    status = 409;
    code = 'DUPLICATE';
    const target = db.violatedFields(err);
    message = target.length
      ? `A record with that ${target.join(', ')} already exists`
      : 'This record already exists';
  } else if (err.code === db.CODES.RECORD_NOT_FOUND) {
    status = 404;
    code = 'NOT_FOUND';
    message = 'Record not found';
  } else if (err.code === db.CODES.FOREIGN_KEY_VIOLATION) {
    status = 400;
    code = 'INVALID_REFERENCE';
    message = 'Referenced record does not exist';
  }

  // ---- Body parser -----------------------------------------------------
  else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body too large';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Malformed JSON body';
  }

  // ---- Logging ---------------------------------------------------------
  // 5xx is our fault — log the stack. 4xx is the caller's — one line.
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  } else {
    console.warn(`[warn] ${req.method} ${req.originalUrl} -> ${status} ${code}`);
  }

  const body = {
    success: false,
    error: {
      code,
      // Never leak internals in production — stack traces and Prisma detail
      // strings tell an attacker your schema.
      message: status >= 500 && env.isProd ? 'Internal server error' : message,
    },
  };

  if (fields) body.error.fields = fields;
  if (!env.isProd && status >= 500) body.error.stack = err.stack;

  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };