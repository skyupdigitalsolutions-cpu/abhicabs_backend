'use strict';

/**
 * src/routes/blogAuth.routes.js  ->  /api/v1/blog
 *
 * Separate authentication for the Blog Builder.
 * Blog users live in the `blog_users` table — completely independent
 * of the main admin/customer user system.
 */

const express = require('express');
const ctrl = require('../controllers/blogAuth.controller');
const { apiLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────
router.post('/auth/login', apiLimiter, ctrl.login);
router.get('/auth/me', ctrl.requireBlogAuth, ctrl.me);

// ── User management (admin only) ─────────────────────────────────────────
router.get('/users', ctrl.requireBlogAuth, ctrl.requireBlogAdmin, ctrl.listUsers);
router.post('/users', ctrl.requireBlogAuth, ctrl.requireBlogAdmin, ctrl.createUser);
router.put('/users/:id', ctrl.requireBlogAuth, ctrl.requireBlogAdmin, ctrl.updateUser);
router.delete('/users/:id', ctrl.requireBlogAuth, ctrl.requireBlogAdmin, ctrl.deleteUser);

module.exports = router;
