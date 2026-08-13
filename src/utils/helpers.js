'use strict';

/**
 * src/utils/helpers.js
 */

/**
 * Wraps an async route handler so a rejected promise reaches the error
 * middleware instead of hanging the request.
 *
 * Express 5 does this automatically, but wrapping keeps the code working on
 * Express 4 as well — and costs nothing.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** A thrown error the client is allowed to see. */
class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }

  static badRequest(message, code = 'BAD_REQUEST') {
    return new ApiError(400, code, message);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to do that', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }
  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }
  static conflict(message, code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }
}

/**
 * Strips the password hash (and anything else sensitive) before a user object
 * is sent to a client. Every response that returns a user must go through this.
 */
function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

/** Consistent pagination envelope for list endpoints. */
function paginated(items, { page, limit, total }) {
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}

module.exports = { asyncHandler, ApiError, publicUser, paginated };