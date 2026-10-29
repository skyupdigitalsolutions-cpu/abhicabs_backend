'use strict';

/**
 * src/routes/gstConfig.routes.js  ->  /api/v1/admin/gst-configs
 *
 * The registrations the business bills under.
 *
 * ---------------------------------------------------------------------------
 * WHY FARE_EDIT AND NOT SETTINGS_MANAGE
 * ---------------------------------------------------------------------------
 * Because these rows change what a customer pays. `is_inclusive` alone is the
 * difference between a corporate fare of Rs 15,546 and Rs 18,344.28 for the
 * identical trip — an 18% price move, made from this screen, with no rate card
 * touched.
 *
 * FARE_EDIT is already the permission for "may change what customers are
 * charged" (rate cards, surge rules, promo codes). Filing tax registrations
 * under general settings would hand that move to whoever is trusted to edit a
 * support phone number.
 */

const express = require('express');

const ctrl = require('../controllers/gstConfig.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/gstConfig.schemas');

const router = express.Router();

router.use(requireAuth);

const PERM = 'FARE_EDIT';

router.get('/', requirePermission(PERM),
  validate({ query: s.listQuerySchema }), ctrl.list);

/*
 * BEFORE '/:id'. Express matches in declaration order and ':id' coerces to a
 * number, so a 'health' request reaching that route first would be rejected
 * by the param validator rather than served.
 */
router.get('/health', requirePermission(PERM), ctrl.health);

router.get('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.getOne);

router.post('/', requirePermission(PERM),
  validate({ body: s.createSchema }), ctrl.create);

router.patch('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema, body: s.updateSchema }), ctrl.update);

// Retires. The row stays so invoices issued under it keep explaining
// themselves — see the service.
router.delete('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.deactivate);

module.exports = router;