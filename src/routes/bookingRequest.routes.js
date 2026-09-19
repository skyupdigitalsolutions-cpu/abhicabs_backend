'use strict';

/**
 * src/routes/bookingRequest.routes.js
 *
 * Three routers, because these endpoints have three different audiences:
 *
 *   pub       unauthenticated — which states are served
 *   customer  /booking-requests — raise and track your own
 *   ops       /admin/booking-requests — the queue
 */

const express = require('express');

const ctrl = require('../controllers/bookingRequest.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/bookingRequest.schemas');

/* ---------------- public ---------------- */

const pub = express.Router();

// Deliberately open. "Do you cover my city" is a question someone should be
// able to ask before signing up, and the answer is public information.
pub.get('/service-states', ctrl.serviceStates);

/* ---------------- customer: /booking-requests ---------------- */

const customer = express.Router();
customer.use(requireAuth);

customer.post('/', validate({ body: s.createSchema }), ctrl.create);

customer.get('/', validate({ query: s.listQuerySchema }), ctrl.listMine);

customer.post('/:id/cancel', validate({ params: s.idParamSchema }), ctrl.cancelMine);

/* ---------------- ops: /admin/booking-requests ---------------- */

const ops = express.Router();
ops.use(requireAuth);

// Reuses BOOKING_MANAGE rather than inventing a permission: whoever services
// these is the person who would turn one into a booking, and a separate grant
// would only be one more thing to forget when onboarding a dispatcher.
ops.get('/', requirePermission('BOOKING_MANAGE'),
  validate({ query: s.listQuerySchema }), ctrl.list);

ops.get('/:id', requirePermission('BOOKING_MANAGE'),
  validate({ params: s.idParamSchema }), ctrl.getById);

ops.patch('/:id', requirePermission('BOOKING_MANAGE'),
  validate({ params: s.idParamSchema, body: s.updateStatusSchema }), ctrl.updateStatus);

module.exports = { pub, customer, ops };