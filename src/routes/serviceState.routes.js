'use strict';

/**
 * src/routes/serviceState.routes.js  — /admin/service-states
 *
 * The PUBLIC read of this list lives on /service-states, in
 * bookingRequest.routes.js. These are the write endpoints.
 */

const express = require('express');

const ctrl = require('../controllers/serviceState.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/serviceState.schemas');

const router = express.Router();
router.use(requireAuth);

// Opening a state is a commercial decision about where the company operates,
// not a dispatch or booking task — so it sits behind SETTINGS_MANAGE rather
// than being folded into an operational permission.
const PERM = 'SETTINGS_MANAGE';

router.get('/', requirePermission(PERM),
  validate({ query: s.listQuerySchema }), ctrl.list);

router.post('/', requirePermission(PERM),
  validate({ body: s.createSchema }), ctrl.create);

// Populates the table with the built-in four. Idempotent, so it is safe to
// re-run; exposed as an endpoint because the table has to be filled on an
// existing production database, where `prisma db seed` is not casual.
router.post('/seed-defaults', requirePermission(PERM), ctrl.seedDefaults);

router.patch('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema, body: s.updateSchema }), ctrl.update);

// DELETE deactivates rather than removing — see the service for why.
router.delete('/:id', requirePermission(PERM),
  validate({ params: s.idParamSchema }), ctrl.deactivate);

module.exports = router;