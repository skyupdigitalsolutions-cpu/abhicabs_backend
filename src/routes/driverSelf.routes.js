'use strict';

/**
 * src/routes/driverSelf.routes.js   ->  /api/v1/driver/me
 *
 * SELF-SERVICE ONLY, same shape as customer.routes.js: no :id parameter for the
 * driver's own record, so every handler is pinned to req.user.id.
 *
 * Note what is NOT here: no route can set kycStatus, verificationStatus or
 * assignedVehicleId. Those live behind DRIVER_APPROVE / VEHICLE_MANAGE on the
 * admin routers. A driver can submit an application; only an admin can approve
 * one.
 *
 * requireRole('DRIVER') rather than a permission check: the seeded grants give
 * the DRIVER role only TRIP_MANAGE, and these are a driver acting on their own
 * account rather than exercising a staff permission.
 */

const express = require('express');
const { z } = require('zod');

const ctrl = require('../controllers/driverSelf.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requireRole } = require('../middlewares/auth');
const { uploadSingle } = require('../middlewares/upload');
const s = require('../validators/driverSelf.schemas');

const router = express.Router();

router.use(requireAuth, requireRole('DRIVER'));

/* ---------------- profile ---------------- */

router.get('/', ctrl.getMe);
router.patch('/', validate({ body: s.updateSelfSchema }), ctrl.updateMe);

// The driver app polls this to render its onboarding checklist.
router.get('/onboarding', ctrl.getOnboarding);

/* ---------------- own documents ---------------- */

// multipart/form-data: `file` plus a docType text field. multer runs before
// validate so the text fields have landed in req.body by then — same ordering
// as the odometer upload in driverBooking.routes.js.
router.post(
  '/documents',
  uploadSingle('file'),
  validate({ body: s.driverDocSchema }),
  ctrl.uploadDocument,
);

/* ---------------- vehicles ---------------- */

router.get(
  '/vehicles',
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  ctrl.listVehicles,
);

// Register a vehicle the driver owns -> creates the Vehicle (PENDING) and the
// owner claim together.
router.post('/vehicles', validate({ body: s.registerVehicleSchema }), ctrl.registerVehicle);

// Claim an existing fleet vehicle by registration number -> files a request
// only; the Vehicle row is untouched.
router.post('/claims', validate({ body: s.claimVehicleSchema }), ctrl.claimVehicle);

router.patch(
  '/claims/:claimId/withdraw',
  validate({ params: z.object({ claimId: z.string().uuid('Invalid id') }) }),
  ctrl.withdrawClaim,
);

router.post(
  '/vehicles/:vehicleId/documents',
  uploadSingle('file'),
  validate({ params: s.vehicleIdParamSchema, body: s.vehicleDocSchema }),
  ctrl.uploadVehicleDocument,
);

/* ---------------- submit for review ---------------- */

router.post('/submit', ctrl.submit);

module.exports = router;