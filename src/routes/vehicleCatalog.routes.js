'use strict';

/**
 * src/routes/vehicleCatalog.routes.js
 *
 * Two routers from one file, because the same resource is read by everyone and
 * written by almost nobody:
 *
 *   publicRouter  ->  /api/v1/vehicles          browse. NO AUTH.
 *   adminRouter   ->  /api/v1/admin/vehicles    manage. VEHICLE_MANAGE.
 *
 * The read side is deliberately unauthenticated, unlike /fares. A fare quote
 * costs a billable maps call and is worth protecting; the catalogue is six
 * cached rows of marketing copy, and requiring a token means the app cannot
 * show its own fleet to someone who has not signed up yet — which is exactly
 * the person most likely to be browsing it.
 */

const express = require('express');

const ctrl = require('../controllers/vehicleCatalog.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const { uploadSingle } = require('../middlewares/upload');
const s = require('../validators/vehicleCatalog.schemas');

/* ------------------------------- public ---------------------------------- */

const publicRouter = express.Router();

publicRouter.get('/', validate({ query: s.listQuerySchema }), ctrl.list);
publicRouter.get('/:key', validate({ params: s.keyParamSchema }), ctrl.getOne);

/* -------------------------------- admin ---------------------------------- */

const adminRouter = express.Router();

adminRouter.use(requireAuth);

const PERM = 'VEHICLE_MANAGE';

adminRouter.get('/', requirePermission(PERM),
  validate({ query: s.listQuerySchema }), ctrl.list);

adminRouter.post('/', requirePermission(PERM),
  validate({ body: s.createSchema }), ctrl.create);

adminRouter.get('/:key', requirePermission(PERM),
  validate({ params: s.keyParamSchema }), ctrl.getOne);

adminRouter.patch('/:key', requirePermission(PERM),
  validate({ params: s.keyParamSchema, body: s.updateSchema }), ctrl.update);

adminRouter.patch('/:key/activate', requirePermission(PERM),
  validate({ params: s.keyParamSchema }), ctrl.activate);

// DELETE retires rather than removes — see the service for why.
adminRouter.delete('/:key', requirePermission(PERM),
  validate({ params: s.keyParamSchema }), ctrl.deactivate);

/*
 * Images. multer runs BEFORE validate, because the body does not exist as
 * parsed fields until it has consumed the multipart stream.
 */
adminRouter.post('/:key/images', requirePermission(PERM),
  uploadSingle('file'),
  validate({ params: s.keyParamSchema, body: s.imageBodySchema }),
  ctrl.addImage);

/*
 * A Cloudinary public id contains slashes ("abhicabs/vehicle-catalog/suv/ab12").
 * A normal ':publicId' segment would stop at the first one, so the rest of the
 * path is captured as a wildcard and reassembled in the controller.
 */
adminRouter.delete('/:key/images/*', requirePermission(PERM),
  validate({ params: s.keyParamSchema }),
  ctrl.removeImage);

module.exports = { publicRouter, adminRouter };