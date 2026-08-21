'use strict';

/**
 * src/controllers/report.controller.js   — Day 13
 *
 * The HTTP edge of reporting. Read endpoints return the cached report JSON;
 * export enqueues a DOCUMENTS-queue job and returns a token to poll, so CSV
 * generation never blocks the request (or times out on a big period).
 */

const crypto = require('crypto');

const reportService = require('../services/report.service');
const reportProvider = require('../services/providers/report.provider');
const { QUEUE, enqueue } = require('../queues');
const { asyncHandler, ApiError } = require('../utils/helpers');

const q = (req) => req.validatedQuery || req.query || {};
const range = (req) => {
  const { from, to } = q(req);
  return { from, to };
};

/* ---------------- read endpoints ---------------- */

exports.executive = asyncHandler(async (req, res) => {
  const data = await reportService.executiveReport(range(req));
  res.json({ success: true, data });
});

exports.fleet = asyncHandler(async (req, res) => {
  const data = await reportService.fleetReport(range(req));
  res.json({ success: true, data });
});

exports.driverPerformance = asyncHandler(async (req, res) => {
  const data = await reportService.driverPerformanceReport(range(req));
  res.json({ success: true, data });
});

exports.businessTrend = asyncHandler(async (req, res) => {
  const data = await reportService.businessTrendReport(range(req));
  res.json({ success: true, data });
});

exports.gst = asyncHandler(async (req, res) => {
  const data = await reportService.gstReport(range(req));
  res.json({ success: true, data });
});

/* ---------------- CSV export (through the documents queue) ---------------- */

/**
 * Deterministic export token from report type + window. Same request => same
 * token => the export job's runOnce dedupes and the client can re-poll the same
 * URL instead of piling up duplicate files.
 */
function exportToken(type, r) {
  const basis = JSON.stringify({ type, from: r.from || '', to: r.to || '' });
  const hash = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24);
  return `${type}-${hash}`;
}

/**
 * POST /admin/reports/:type/export
 * Enqueues generation on the DOCUMENTS queue and returns 202 with a token +
 * the URL to fetch the file once it is ready.
 */
exports.requestExport = asyncHandler(async (req, res) => {
  const { type } = req.params;
  if (!reportService.isValidReport(type)) {
    throw ApiError.badRequest(`Unknown report type "${type}"`, 'UNKNOWN_REPORT');
  }
  const r = range(req);
  const token = exportToken(type, r);

  await enqueue(QUEUE.DOCUMENTS, 'report-csv', { token, type, range: r });

  res.status(202).json({
    success: true,
    message: 'Export queued',
    data: {
      token,
      status: 'processing',
      url: `/api/v1/admin/reports/exports/${token}`,
      hint: 'Poll the url; it returns 425 until ready, then the CSV file.',
    },
  });
});

/**
 * GET /admin/reports/exports/:token
 * Streams the generated CSV once the job has stored it. 425 (Too Early) while
 * it is still being built or has expired.
 */
exports.fetchExport = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const file = await reportProvider.getProvider().fetch(token);

  if (!file) {
    // Not ready yet (or expired). 425 tells the client to keep polling.
    return res.status(425).json({
      success: false,
      code: 'EXPORT_NOT_READY',
      message: 'Export is still processing or has expired. Try again shortly.',
    });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  return res.send(file.csv);
});