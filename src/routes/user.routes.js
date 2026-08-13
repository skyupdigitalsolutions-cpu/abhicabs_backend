'use strict';

const express = require('express');
const ctrl = require('../controllers/user.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const s = require('../validators/schemas');

const router = express.Router();

router.use(requireAuth); // everything below requires a valid access token

router.get('/profile', ctrl.getProfile);
router.patch('/profile', validate({ body: s.updateProfileSchema }), ctrl.updateProfile);
router.delete('/account', ctrl.deleteAccount);

module.exports = router;