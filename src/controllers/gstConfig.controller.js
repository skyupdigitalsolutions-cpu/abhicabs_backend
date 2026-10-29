'use strict';

/**
 * src/controllers/gstConfig.controller.js
 */

const gst = require('../services/gst.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });
const q = (req) => req.validatedQuery || req.query || {};

/** GET /admin/gst-configs */
exports.list = asyncHandler(async (req, res) => {
  const { includeInactive = true } = q(req);
  const configs = await gst.listConfigs({ includeInactive });
  res.json({ success: true, data: { count: configs.length, configs } });
});

/**
 * GET /admin/gst-configs/health
 *
 * Answers "is GST actually working?" — which is the question that was asked
 * and that nobody could answer from the table, because a placeholder GSTIN is
 * in the correct format and looks real at a glance. Flags every row where the
 * number is still a placeholder or its state code disagrees with the state.
 *
 * Declared BEFORE '/:id' so 'health' is not parsed as an id.
 */
exports.health = asyncHandler(async (req, res) => {
  const registrations = await gst.health();

  const problems = registrations.filter(
    (r) => r.isActive && (r.placeholderGstin || !r.stateCodeMatches),
  );

  res.json({
    success: true,
    data: {
      registrations,
      /*
       * A state with no active registration raises no tax and issues a bill
       * of supply instead of a tax invoice — silently. This is the list to
       * look at when someone reports "GST is not applying".
       */
      activeStates: registrations.filter((r) => r.isActive).map((r) => r.state),
      problems,
      ok: problems.length === 0,
    },
  });
});

/** GET /admin/gst-configs/:id */
exports.getOne = asyncHandler(async (req, res) => {
  const config = await gst.getConfig(req.params.id);
  res.json({ success: true, data: { config } });
});

/** POST /admin/gst-configs */
exports.create = asyncHandler(async (req, res) => {
  const config = await gst.createConfig(req.body, req.user, meta(req));
  res.status(201).json({
    success: true,
    message: `GST registration added for ${config.state}`,
    data: { config },
  });
});

/** PATCH /admin/gst-configs/:id */
exports.update = asyncHandler(async (req, res) => {
  const config = await gst.updateConfig(req.params.id, req.body, req.user, meta(req));
  res.json({ success: true, message: 'GST registration updated', data: { config } });
});

/** DELETE /admin/gst-configs/:id — retires, never removes. */
exports.deactivate = asyncHandler(async (req, res) => {
  const config = await gst.deactivateConfig(req.params.id, req.user, meta(req));
  res.json({
    success: true,
    message: `${config.state} registration retired. Invoices already issued under it are unchanged.`,
    data: { config },
  });
});