'use strict';

/**
 * src/routes/admin.routes.js   ->  mounted at /api/v1/admin
 *
 * Full CRUD over users. Guarded at the router level so a new route added here
 * can never accidentally be left public.
 */

const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requireRole } = require('../middlewares/auth');
const s = require('../validators/schemas');

const router = express.Router();

router.use(requireAuth, requireRole('ADMIN'));

router.get('/stats', ctrl.stats);

router.get('/users', validate({ query: s.listUsersQuerySchema }), ctrl.listUsers);
router.post('/users', validate({ body: s.createUserSchema }), ctrl.createUser);

router.get('/users/:id', validate({ params: s.idParamSchema }), ctrl.getUser);
router.patch('/users/:id', validate({ params: s.idParamSchema, body: s.updateUserSchema }), ctrl.updateUser);
router.delete('/users/:id', validate({ params: s.idParamSchema }), ctrl.deleteUser);

router.patch('/users/:id/activate', validate({ params: s.idParamSchema }), ctrl.activateUser);
router.patch('/users/:id/deactivate', validate({ params: s.idParamSchema }), ctrl.deactivateUser);

module.exports = router;