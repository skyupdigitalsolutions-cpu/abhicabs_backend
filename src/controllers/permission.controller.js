'use strict';

/**
 * src/controllers/permission.controller.js
 */

const permissionService = require('../services/permission.service');
const { asyncHandler, ApiError } = require('../utils/helpers');

exports.listAll = asyncHandler(async (req, res) => {
  const map = await permissionService.getAllRolePermissions();
  res.json({ success: true, data: { roles: map } });
});

exports.catalogue = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: { permissions: Object.values(permissionService.PERMISSIONS).sort() },
  });
});

exports.grant = asyncHandler(async (req, res) => {
  const { role, permission } = req.body;
  if (!permissionService.PERMISSION_VALUES.has(permission)) {
    throw ApiError.badRequest(`Unknown permission: ${permission}`, 'UNKNOWN_PERMISSION');
  }
  await permissionService.grant(role, permission);
  res.json({ success: true, message: `Granted ${permission} to ${role}` });
});

exports.revoke = asyncHandler(async (req, res) => {
  const { role, permission } = req.body;

  // Removing SETTINGS_MANAGE from ADMIN would make permission administration
  // unreachable, with no route back short of direct SQL.
  if (role === 'ADMIN' && permission === 'SETTINGS_MANAGE') {
    throw ApiError.badRequest(
      'Cannot revoke SETTINGS_MANAGE from ADMIN — permission administration would become unreachable',
      'LAST_SETTINGS_ADMIN'
    );
  }

  await permissionService.revoke(role, permission);
  res.json({ success: true, message: `Revoked ${permission} from ${role}` });
});