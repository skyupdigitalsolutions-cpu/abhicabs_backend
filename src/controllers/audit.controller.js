'use strict';

/**
 * src/controllers/audit.controller.js
 *
 * Read-only. There is no endpoint to edit or delete an audit entry, and there
 * should never be one — an editable audit log is not an audit log.
 */

const audit = require('../services/audit.service');
const { asyncHandler } = require('../utils/helpers');

exports.list = asyncHandler(async (req, res) => {
  const data = await audit.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.trail = asyncHandler(async (req, res) => {
  const entries = await audit.trailFor(req.params.entityType, req.params.entityId);
  res.json({ success: true, data: { entries } });
});

exports.actions = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      actions: Object.values(audit.ACTIONS).sort(),
      entityTypes: Object.values(audit.ENTITIES).sort(),
    },
  });
});