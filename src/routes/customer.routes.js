'use strict';

/**
 * src/routes/customer.routes.js   ->  /api/v1/customers
 *
 * SELF-SERVICE ONLY. No :id parameter anywhere — every handler acts on
 * req.user.id, so there is nothing for a caller to tamper with. That is a
 * stronger guarantee than an ownership check, because there is no id to check.
 *
 * Staff-facing customer management lives on /admin/customers.
 */

const express = require('express');

const ctrl = require('../controllers/customer.controller');
const addressCtrl = require('../controllers/address.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const s = require('../validators/customer.schemas');

const router = express.Router();

router.use(requireAuth);

/* ---------------- profile ---------------- */

router.get('/me', ctrl.getMyProfile);
router.patch('/me', validate({ body: s.updateCustomerSelfSchema }), ctrl.updateMyProfile);

// "Who is billed for my trips" — shows a corporate employee their company.
router.get('/me/billing', ctrl.getMyBilling);

/* ---------------- own addresses ---------------- */

router.get('/me/addresses', addressCtrl.list);
router.post('/me/addresses', validate({ body: s.createAddressSchema }), addressCtrl.create);

router.get('/me/addresses/:id', validate({ params: s.idParamSchema }), addressCtrl.getOne);
router.patch(
  '/me/addresses/:id',
  validate({ params: s.idParamSchema, body: s.updateAddressSchema }),
  addressCtrl.update
);
router.delete('/me/addresses/:id', validate({ params: s.idParamSchema }), addressCtrl.remove);

router.patch(
  '/me/addresses/:id/default',
  validate({ params: s.idParamSchema }),
  addressCtrl.setDefault
);

// Populated by the Day 4 geocoder so a repeat pickup costs no maps API call.
router.patch(
  '/me/addresses/:id/coordinates',
  validate({ params: s.idParamSchema, body: s.coordinatesSchema }),
  addressCtrl.setCoordinates
);

module.exports = router;