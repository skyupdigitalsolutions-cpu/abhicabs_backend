'use strict';

/**
 * src/routes/blogAuth.routes.js  ->  /api/v1/blog
 *
 * Separate authentication for the Blog Builder, plus its content:
 * service pages (/pages) and the GitHub-backed blog/redirect files (/github/file).
 * Blog users live in the `blog_users` table — completely independent
 * of the main admin/customer user system.
 */

const express = require('express');
const ctrl = require('../controllers/blogAuth.controller');
const content = require('../controllers/cmsContent.controller');
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

// ── CMS content ───────────────────────────────────────────────────────────
// Service pages: the website reads them (public), the CMS saves them (editors/admins).
router.get('/pages', apiLimiter, content.getPages);
router.put('/pages', apiLimiter, ctrl.requireBlogAuth, content.requireBlogEditor, content.putPages);

// Blog posts / redirects live in the website repo; the server commits them so the
// GitHub token never reaches the browser.
router.get('/github/file', apiLimiter, content.getGithubFile);
router.put('/github/file', apiLimiter, ctrl.requireBlogAuth, content.requireBlogEditor, content.putGithubFile);

module.exports = router;
