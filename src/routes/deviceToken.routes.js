'use strict';

/**
 * src/routes/deviceToken.routes.js  ->  /api/v1/device-tokens
 * Self-service: any authenticated user (customer or driver) manages their own
 * FCM tokens — POST on login/refresh, DELETE on logout.
 */

const express = require('express');
const { z } = require('zod');

const ctrl = require('../controllers/deviceToken.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');

const token = z.string().trim().min(20, 'Invalid device token').max(512);

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.post('/', validate({ body: z.object({ token, platform: z.enum(['android', 'ios', 'web']).optional() }) }), ctrl.register);
router.delete('/', validate({ body: z.object({ token }) }), ctrl.unregister);

module.exports = router;