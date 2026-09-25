'use strict';

/**
 * src/routes/discount.routes.js
 *
 * Two routers: admin management, and the rider-facing check.
 *
 *   adminRouter  -> /api/v1/admin/discounts   FARE_EDIT
 *   riderRouter  -> /api/v1/discounts         signed-in customer
 *
 * FARE_EDIT because a promo changes what a customer pays, exactly as a rate
 * card does. A separate permission would mean someone who cannot edit a
 * per-km rate could still give away 50% of every fare.
 */

const express = require('express');

const ctrl = require('../controllers/discount.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/discount.schemas');

/* -------------------------------- admin --------------------------------- */

const adminRouter = express.Router();
adminRouter.use(requireAuth);

const PERM = 'FARE_EDIT';

adminRouter.get('/', requirePermission(PERM),
  validate({ query: s.listQuerySchema }), ctrl.list);

adminRouter.post('/', requirePermission(PERM),
  validate({ body: s.createSchema }), ctrl.create);

adminRouter.get('/:id/redemptions', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.redemptions);

adminRouter.patch('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema, body: s.updateSchema }), ctrl.update);

// Disables rather than deletes — a used code must survive for disputes.
adminRouter.delete('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.disable);

/* -------------------------------- rider --------------------------------- */

const riderRouter = express.Router();
riderRouter.use(requireAuth);

/*
 * POST, not GET, and that is deliberate: the fare total is part of the
 * question, codes should not sit in browser history or server logs, and the
 * answer is not cacheable — it depends on who is asking and what they have
 * already redeemed.
 */
riderRouter.post('/check', validate({ body: s.checkSchema }), ctrl.check);

module.exports = { adminRouter, riderRouter };