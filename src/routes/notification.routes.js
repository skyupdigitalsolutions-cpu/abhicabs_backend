'use strict';

/**
 * src/routes/notification.routes.js  ->  /api/v1/admin/notifications
 *
 * In-app notification feed for admin/ops staff. Notifications are created by
 * event handlers (booking created, payment received, driver alert etc.) and
 * read/dismissed here.
 *
 * Every authenticated staff user can read their own notifications; no extra
 * permission is needed (the feed is personal, not shared).
 */

const express = require('express');

const ctrl = require('../controllers/notification.controller');
const { requireAuth } = require('../middlewares/auth');

const router = express.Router();

router.use(requireAuth);

/** GET /admin/notifications — paginated, newest first. */
router.get('/', ctrl.list);

/** GET /admin/notifications/unread-count — badge number. */
router.get('/unread-count', ctrl.unreadCount);

/** PATCH /admin/notifications/:id/read — mark one as read. */
router.patch('/:id/read', ctrl.markRead);

/** POST /admin/notifications/read-all — mark every notification as read. */
router.post('/read-all', ctrl.markAllRead);

module.exports = router;
