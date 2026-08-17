'use strict';

/**
 * src/middlewares/idempotency.js
 *
 * Wraps a route so a repeated request with the same Idempotency-Key returns the
 * ORIGINAL response instead of doing the work twice.
 *
 * Usage:
 *   router.post('/bookings', requireAuth, idempotent('POST /bookings'), validate(...), ctrl.create)
 *
 * ---------------------------------------------------------------------------
 * HOW THE RESPONSE IS CAPTURED
 * ---------------------------------------------------------------------------
 * res.json is wrapped so the middleware sees the body the controller sent
 * without the controller knowing anything about idempotency. On a 2xx the key
 * is marked COMPLETED with that body; on anything else it is marked FAILED so a
 * retry is allowed to try again.
 *
 * Note the record happens AFTER the response is sent. Making the customer wait
 * for bookkeeping would add latency to the critical path, and if the record
 * fails the booking is still valid — the worst case is that a retry does the
 * work again rather than replaying.
 */

const idempotencyService = require('../services/idempotency.service');
const { ApiError } = require('../utils/helpers');

const HEADER = 'idempotency-key';

/**
 * @param {string}  endpoint          label stored on the key row
 * @param {boolean} required          reject requests without the header
 */
function idempotent(endpoint, { required = false } = {}) {
  return async function idempotencyGate(req, res, next) {
    const key = (req.get(HEADER) || '').trim();

    if (!key) {
      if (required) {
        return next(
          ApiError.badRequest(
            'This endpoint requires an Idempotency-Key header',
            'IDEMPOTENCY_KEY_REQUIRED'
          )
        );
      }
      // Without a key there is nothing to deduplicate against. Allowed for now
      // so existing clients keep working, but mobile clients should always send
      // one — a dropped connection mid-booking is routine, not exceptional.
      return next();
    }

    if (key.length > 120) {
      return next(ApiError.badRequest('Idempotency-Key is too long', 'IDEMPOTENCY_KEY_INVALID'));
    }

    let claim;
    try {
      claim = await idempotencyService.claim({
        key,
        userId: req.user?.id,
        endpoint,
        requestBody: req.body,
      });
    } catch (err) {
      return next(err);
    }

    if (claim.outcome === 'REPLAY') {
      // The original answer, byte for byte. The client cannot tell this apart
      // from the first response — which is exactly the point.
      res.set('Idempotency-Replayed', 'true');
      return res.status(claim.statusCode).json(claim.body);
    }

    if (claim.outcome === 'IN_FLIGHT') {
      // A duplicate arrived while the first is still running. 409 with
      // Retry-After tells a well-behaved client to wait rather than hammer.
      res.set('Retry-After', '2');
      return next(
        ApiError.conflict(
          'An identical request is already being processed',
          'REQUEST_IN_FLIGHT'
        )
      );
    }

    // CLAIMED — this request does the work. Capture whatever it responds with.
    req.idempotencyKey = key;

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const result = originalJson(body);
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      // Fire and forget: the response is already on its way.
      if (ok) idempotencyService.complete(key, res.statusCode, body);
      else idempotencyService.fail(key);
      return result;
    };

    return next();
  };
}

module.exports = { idempotent, HEADER };