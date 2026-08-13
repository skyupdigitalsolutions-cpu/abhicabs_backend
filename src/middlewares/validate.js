'use strict';

/**
 * src/middlewares/validate.js
 *
 * Usage:
 *   router.post('/login', validate({ body: loginSchema }), controller.login)
 *
 * The parsed (and coerced) result replaces req.body / req.query / req.params,
 * so downstream code works with clean, typed values and unknown fields are
 * stripped rather than silently passed through.
 */

const { ApiError } = require('../utils/helpers');

function validate(schemas = {}) {
  return function validateMiddleware(req, res, next) {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      if (schemas.params) req.params = schemas.params.parse(req.params ?? {});

      if (schemas.query) {
        // Express 5 makes req.query a getter, so it cannot be reassigned.
        // Store the parsed result separately and read it via req.validatedQuery.
        req.validatedQuery = schemas.query.parse(req.query ?? {});
      }

      return next();
    } catch (err) {
      if (err.name === 'ZodError') return next(err); // formatted by error handler
      return next(ApiError.badRequest('Invalid request'));
    }
  };
}

module.exports = { validate };