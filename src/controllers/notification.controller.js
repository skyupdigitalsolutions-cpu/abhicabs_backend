'use strict';

/**
 * src/controllers/notification.controller.js
 *
 * In-app notification feed for staff.
 */

const { prisma } = require('../config/prisma');
const { asyncHandler, paginated } = require('../utils/helpers');

/** GET /admin/notifications */
exports.list = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const where = { userId };

  const [total, items] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  res.json({ success: true, data: paginated(items, { page, limit, total }) });
});

/** GET /admin/notifications/unread-count */
exports.unreadCount = asyncHandler(async (req, res) => {
  const count = await prisma.notification.count({
    where: { userId: req.user.id, read: false },
  });
  res.json({ success: true, data: { unreadCount: count } });
});

/** PATCH /admin/notifications/:id/read */
exports.markRead = asyncHandler(async (req, res) => {
  const notification = await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user.id },
    data: { read: true },
  });
  res.json({ success: true, data: { updated: notification.count } });
});

/** POST /admin/notifications/read-all */
exports.markAllRead = asyncHandler(async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user.id, read: false },
    data: { read: true },
  });
  res.json({ success: true, data: { updated: result.count } });
});
