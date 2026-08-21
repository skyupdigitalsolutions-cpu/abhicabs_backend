'use strict';

/**
 * src/routes/report.routes.js   — Day 13
 *   -> /api/v1/admin/reports
 *
 * Reports & analytics. Every route requires REPORT_VIEW (held by ADMIN, OPS,
 * FINANCE, FLEET). Reads are cached; the CSV export is done off the request
 * path via the documents queue.
 */

const express = require('express');

const ctrl = require('../controllers/report.controller');
const { validate } = require('../middlewares/validate');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const s = require('../validators/report.schemas');

const router = express.Router();

router.use(requireAuth, requirePermission('REPORT_VIEW'));

/* ---------------- read reports ---------------- */

router.get('/executive',
  validate({ query: s.rangeQuerySchema }), ctrl.executive);

router.get('/fleet',
  validate({ query: s.rangeQuerySchema }), ctrl.fleet);

router.get('/driver-performance',
  validate({ query: s.rangeQuerySchema }), ctrl.driverPerformance);

router.get('/business-trend',
  validate({ query: s.rangeQuerySchema }), ctrl.businessTrend);

router.get('/gst',
  validate({ query: s.rangeQuerySchema }), ctrl.gst);

/* ---------------- CSV export via the documents queue ---------------- */

// Retrieval must precede /:type/export so "exports" is not captured as a type.
router.get('/exports/:token',
  validate({ params: s.exportTokenParamSchema }), ctrl.fetchExport);

router.post('/:type/export',
  validate({ params: s.typeParamSchema, query: s.rangeQuerySchema }), ctrl.requestExport);

module.exports = router;