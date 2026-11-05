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

/* ----------------------- the booking switch ------------------------------ *
 *
 * DECLARED BEFORE EVERY '/:key' ROUTE, and that ordering is load-bearing
 * rather than tidy. Express matches in declaration order, so with these
 * below, 'PATCH /booking/all' would be matched by 'PATCH /:key' with
 * key='booking' — which passes the slug validator cleanly and then 404s with
 * "Vehicle not found", for a route that exists. Same trap for
 * 'GET /booking/status' against 'GET /:key'.
 *
 * Mounted under a '/booking' prefix rather than at '/disable-all' for the
 * same reason: one reserved segment is easier to keep clear of the key space
 * than several scattered verbs.
 * ------------------------------------------------------------------------- */

adminRouter.get('/booking/status', requirePermission(PERM), ctrl.bookingStatus);

adminRouter.patch('/booking/all', requirePermission(PERM),
  validate({ body: s.bookingToggleAllSchema }), ctrl.setBookingAll);

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

/*
 * Switch booking on or off for ONE class, leaving its catalogue entry, its
 * photos and its rate cards exactly where they are. This is the route an
 * admin on/off toggle should call — NOT the DELETE below, which retires the
 * class and refuses while live rate cards still price it.
 */
adminRouter.patch('/:key/booking', requirePermission(PERM),
  validate({ params: s.keyParamSchema, body: s.bookingToggleSchema }), ctrl.setBooking);

// DELETE retires rather than removes — see the service for why.
adminRouter.delete('/:key', requirePermission(PERM),
  validate({ params: s.keyParamSchema }), ctrl.deactivate);

/*
 * PERMANENT delete, for a class created by mistake.
 *
 * Declared BEFORE the image routes below only for readability — it sits with
 * the other lifecycle verbs. Express distinguishes it from '/:key' by the
 * extra segment, and from '/:key/images/*' by the literal.
 */
adminRouter.delete('/:key/permanent', requirePermission(PERM),
  validate({ params: s.keyParamSchema }), ctrl.destroy);

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