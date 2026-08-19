'use strict';

/**
 * src/routes/webhook.routes.js   — Day 7
 *   -> /api/v1/webhooks/:provider
 *
 * PUBLIC. There is no bearer token on a gateway callback — authentication is
 * the HMAC signature over the raw body, checked inside the service.
 *
 * ---------------------------------------------------------------------------
 * MOUNTED SPECIALLY. See app.js: this router is attached with express.raw()
 * BEFORE the global express.json(), so req.body arrives as a Buffer of the
 * exact bytes the gateway signed. If it were parsed and re-serialised first,
 * the recomputed signature would not match and every webhook would be rejected.
 * ---------------------------------------------------------------------------
 */

const express = require('express');

const ctrl = require('../controllers/webhook.controller');
const { validate } = require('../middlewares/validate');
const s = require('../validators/payment.schemas');

const router = express.Router();

router.post('/:provider', validate({ params: s.providerParamSchema }), ctrl.receive);

module.exports = router;