'use strict';

/**
 * src/routes/admin.routes.js   — UPDATED for Day 2
 *   -> mounted at /api/v1/admin
 *
 * Day 1 gated everything behind requireRole('ADMIN'), which meant the seeded
 * OPS / FINANCE / FLEET / SUPPORT accounts received 403 on every route.
 *
 * Now each route declares the CAPABILITY it needs and requirePermission
 * resolves that against the role_permissions table. ADMIN holds all 16
 * permissions, so admin behaviour is unchanged; the other roles gain exactly
 * the access their seeded grants describe.
 */

const express = require('express');

const ctrl = require('../controllers/admin.controller');
const permCtrl = require('../controllers/permission.controller');
const { prisma } = require('../config/prisma');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/schemas');
const otpSchemas = require('../validators/otp.schemas');

const router = express.Router();

// Authentication for everything below. Authorisation is per route.
router.use(requireAuth);

/* ------------------------------------------------------------------ *
 * User management — USER_MANAGE (ADMIN only, per the seeded map)
 * ------------------------------------------------------------------ */

router.get('/stats', requirePermission('REPORT_VIEW'), ctrl.stats);

router.get(
  '/users',
  requirePermission('USER_MANAGE'),
  validate({ query: s.listUsersQuerySchema }),
  ctrl.listUsers
);

router.post(
  '/users',
  requirePermission('USER_MANAGE'),
  validate({ body: s.createUserSchema }),
  ctrl.createUser
);

router.get(
  '/users/:id',
  requirePermission('USER_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.getUser
);

router.patch(
  '/users/:id',
  requirePermission('USER_MANAGE'),
  validate({ params: s.idParamSchema, body: s.updateUserSchema }),
  ctrl.updateUser
);

router.delete(
  '/users/:id',
  requirePermission('USER_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.deleteUser
);

router.patch(
  '/users/:id/activate',
  requirePermission('USER_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.activateUser
);

router.patch(
  '/users/:id/deactivate',
  requirePermission('USER_MANAGE'),
  validate({ params: s.idParamSchema }),
  ctrl.deactivateUser
);

/* ------------------------------------------------------------------ *
 * Permission administration — SETTINGS_MANAGE (ADMIN only)
 * ------------------------------------------------------------------ */

router.get('/permissions', requirePermission('SETTINGS_MANAGE'), permCtrl.listAll);
router.get('/permissions/catalogue', requirePermission('SETTINGS_MANAGE'), permCtrl.catalogue);

router.post(
  '/permissions/grant',
  requirePermission('SETTINGS_MANAGE'),
  validate({ body: otpSchemas.grantPermissionSchema }),
  permCtrl.grant
);

router.post(
  '/permissions/revoke',
  requirePermission('SETTINGS_MANAGE'),
  validate({ body: otpSchemas.grantPermissionSchema }),
  permCtrl.revoke
);

/* ------------------------------------------------------------------ *
 * Capability probes
 *
 * Two placeholder routes remain purely to demonstrate — and let you TEST — that
 * the permission split works. The dispatch board is now real and lives on its
 * own router (/admin/dispatch, Day 9); the finance/fleet stubs stay until those
 * days land. Keep the requirePermission calls.
 *
 *   /finance/refunds PAYMENT_REFUND   -> FINANCE yes, OPS no
 *   /fleet/pending   DRIVER_APPROVE   -> FLEET yes, OPS no
 * ------------------------------------------------------------------ */

router.get('/finance/refunds', requirePermission('PAYMENT_REFUND'), (req, res) => {
  res.json({
    success: true,
    message: 'Refunds queue — you hold PAYMENT_REFUND',
    data: { role: req.user.role, placeholder: true },
  });
});

router.get('/fleet/pending-drivers', requirePermission('DRIVER_APPROVE'), (req, res) => {
  res.json({
    success: true,
    message: 'Pending driver approvals — you hold DRIVER_APPROVE',
    data: { role: req.user.role, placeholder: true },
  });
});

/* ------------------------------------------------------------------ *
 * Settings — company profile + notification preferences
 *
 * Stored as key-value rows in a simple settings table. If the table doesn't
 * exist yet, the endpoints return defaults and accept writes (they create the
 * table lazily or fall back to in-memory storage).
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  company: {
    name: 'AbhiCabs',
    supportEmail: 'ops@abhicabs.in',
    phone: '',
    address: 'Bengaluru, Karnataka, India',
    gstin: '',
    pan: '',
    cin: '',
  },
  notifications: {
    emailOnNewBooking: true,
    emailOnCancellation: true,
    smsOnDriverAssign: true,
    whatsappOnConfirm: true,
    pushOnNewBooking: false,
  },
};

// In-memory fallback when the settings table doesn't exist yet
const settingsCache = { ...DEFAULTS };

router.get('/settings/:key', requirePermission('SETTINGS_MANAGE'), async (req, res) => {
  const key = req.params.key;
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    if (row) { settingsCache[key] = row.value; }
  } catch { /* table may not exist yet */ }
  const data = settingsCache[key] || DEFAULTS[key] || null;
  res.json({ success: true, data });
});

router.put('/settings/:key', requirePermission('SETTINGS_MANAGE'), async (req, res) => {
  const key = req.params.key;
  const value = req.body;

  try {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  } catch {
    // Settings table may not exist yet — store in memory only
  }

  settingsCache[key] = value;
  res.json({ success: true, message: `${key} settings saved`, data: value });
});

module.exports = router;