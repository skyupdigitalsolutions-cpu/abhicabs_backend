'use strict';

/**
 * src/routes/contact.routes.js
 *
 * Two routers, mounted separately in routes/index.js:
 *   publicRoutes -> /api/v1/contact          the website form posts here (no auth)
 *   adminRoutes  -> /api/v1/admin/contacts    staff read + triage the inbox
 */

const express = require('express');

const ctrl = require('../controllers/contact.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requireRole } = require('../middlewares/auth');
const s = require('../validators/contact.schemas');

/* -------------------------------- Public ---------------------------------- */

const publicRoutes = express.Router();

// POST /api/v1/contact  — submit the contact form.
publicRoutes.post('/', validate({ body: s.createContactSchema }), ctrl.submit);

/* --------------------------------- Admin ---------------------------------- */

const adminRoutes = express.Router();

// Coarse role gate (no new permission to seed). ADMIN/OPS/SUPPORT can read the inbox.
adminRoutes.use(requireAuth, requireRole('ADMIN', 'OPS', 'SUPPORT'));

adminRoutes.get('/', validate({ query: s.listContactsSchema }), ctrl.list);
adminRoutes.get('/:id', validate({ params: s.idParamSchema }), ctrl.getOne);
adminRoutes.patch(
  '/:id/status',
  validate({ params: s.idParamSchema, body: s.updateStatusSchema }),
  ctrl.updateStatus,
);

module.exports = { publicRoutes, adminRoutes };