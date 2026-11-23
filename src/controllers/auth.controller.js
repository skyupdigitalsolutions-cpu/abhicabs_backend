'use strict';

/**
 * src/controllers/auth.controller.js   — UPDATED for Day 2
 *
 * Only `me` changed: it now returns the caller's permission list alongside the
 * user, so the admin UI knows which controls to render.
 */

const authService = require('../services/auth.service');
const passwordReset = require('../services/passwordReset.service');
const { asyncHandler } = require('../utils/helpers');
const { isStaffRole } = require('../lib/accountRoles');

const meta = (req) => ({
  userAgent: req.get('user-agent') || '',
  ip: req.ip || '',
});

exports.register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body, meta(req));
  res.status(201).json({ success: true, message: 'Account created', data: result });
});

exports.login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, meta(req));
  res.json({ success: true, message: 'Logged in', data: result });
});

exports.refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body.refreshToken, meta(req));
  res.json({ success: true, message: 'Token refreshed', data: result });
});

exports.logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body?.refreshToken);
  // Always 200 — logging out must never fail from the user's point of view.
  res.json({ success: true, message: 'Logged out' });
});

exports.logoutAll = asyncHandler(async (req, res) => {
  const result = await authService.logoutAll(req.user.id);
  res.json({ success: true, message: 'Logged out from all devices', data: result });
});

/**
 * GET /auth/me
 *
 * `capabilities` is how both apps decide what to render, because users.role no
 * longer answers "is this a rider or a driver" — one account can be both, and
 * the answer lives in the profile rows (see src/lib/accountRoles.js).
 *
 * The rider app shows "Apply to drive" when isDriver is false, and a
 * "Switch to driver" control when it is true. The driver app checks canDrive
 * before offering to go online. Neither should branch on `role` any more.
 *
 * `role` is reported as the STORED value, not the effective one requireAuth
 * computes for query scoping, so existing clients keep seeing what they saw.
 */
exports.me = asyncHandler(async (req, res) => {
  const { baseRole, hasRiderProfile, hasDriverProfile, driverKycStatus, ...user } = req.user;

  res.json({
    success: true,
    data: {
      user: { ...user, role: baseRole || user.role },
      capabilities: {
        // Every self-service account may book. The customers row is created on
        // demand at first booking, so its absence is not a restriction.
        canBookRides: !isStaffRole(baseRole),
        hasRiderProfile: !!hasRiderProfile,
        isDriver: !!hasDriverProfile,
        driverKycStatus: driverKycStatus || null,
        // Dispatchable. Signing up is not approval — an admin still has to
        // verify the licence and activate the vehicle.
        canDrive: !!hasDriverProfile && driverKycStatus === 'VERIFIED',
      },
      // Populated by attachPermissions. For the client's benefit only —
      // never treated as a security boundary.
      permissions: req.permissions || [],
    },
  });
});

exports.changePassword = asyncHandler(async (req, res) => {
  const result = await authService.changePassword(req.user.id, req.body);
  res.json({ success: true, ...result });
});

/* ---------------- password reset ---------------- */

exports.forgotPassword = asyncHandler(async (req, res) => {
  const result = await passwordReset.requestReset(req.body.email);
  // Always 200, always the same message. A different status or body for an
  // unknown address would undo the enumeration protection in the service.
  res.json({ success: true, ...result });
});

exports.verifyResetToken = asyncHandler(async (req, res) => {
  const result = await passwordReset.verifyToken(req.body.token);
  res.json({ success: true, data: result });
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const result = await passwordReset.resetPassword(req.body);
  res.json({ success: true, ...result });
});