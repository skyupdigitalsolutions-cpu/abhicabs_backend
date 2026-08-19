'use strict';

/**
 * src/controllers/webhook.controller.js
 *
 * The HTTP edge of webhook handling. Mounted with express.raw(), so req.body is
 * a Buffer of the exact bytes the gateway sent — which is what signature
 * verification needs. Do NOT read req.body as an object here.
 */

const webhookService = require('../services/webhook.service');
const { asyncHandler } = require('../utils/helpers');

/**
 * Signature header names differ by gateway. Check the ones we support.
 */
function signatureFrom(req) {
  return (
    req.get('x-razorpay-signature') ||
    req.get('x-webhook-signature') ||
    req.get('x-signature') ||
    ''
  );
}

exports.receive = asyncHandler(async (req, res) => {
  const result = await webhookService.ingest({
    provider: req.params.provider,
    rawBody: req.body, // Buffer, thanks to express.raw()
    signature: signatureFrom(req),
    headers: {
      'x-razorpay-event-id': req.get('x-razorpay-event-id') || undefined,
    },
  });

  // Always 200 once the event is safely recorded — a duplicate is a success,
  // not an error, and a 4xx/5xx would make the gateway retry needlessly.
  res.status(200).json({ success: true, data: result });
});