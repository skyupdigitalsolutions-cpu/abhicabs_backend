'use strict';

/**
 * src/routes/audit.routes.js   ->  /api/v1/admin/audit
 *
 * Read-only by design. There is no endpoint to edit or delete an entry, and
 * adding one would defeat the purpose — an editable audit log is not evidence.
 */

const express = require('express');

const ctrl = require('../controllers/audit.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/customer.schemas');

const router = express.Router();

router.use(requireAuth, requirePermission('AUDIT_VIEW'));

router.get('/', validate({ query: s.auditQuerySchema }), ctrl.list);
router.get('/actions', ctrl.actions);
router.get('/:entityType/:entityId', ctrl.trail);

module.exports = router;