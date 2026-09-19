'use strict';

/**
 * src/controllers/serviceState.controller.js
 *
 * Admin management of the state allowlist.
 */

const service = require('../services/serviceState.service');
const { asyncHandler } = require('../utils/helpers');

const q = (req) => req.validatedQuery || req.query || {};

exports.list = asyncHandler(async (req, res) => {
  const data = await service.list(q(req));
  res.json({ success: true, data });
});

exports.create = asyncHandler(async (req, res) => {
  const state = await service.create(req.body, req.user);
  res.status(201).json({
    success: true,
    message: `${state.name} added — new quotes will accept it immediately`,
    data: { state },
  });
});

exports.update = asyncHandler(async (req, res) => {
  const state = await service.update(req.params.id, req.body);
  res.json({ success: true, message: 'State updated', data: { state } });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const state = await service.deactivate(req.params.id);
  res.json({
    success: true,
    // Says "deactivated", not "deleted", because that is what happened — the
    // row survives so the requests it produced still explain themselves.
    message: `${state.name} deactivated`,
    data: { state },
  });
});

exports.seedDefaults = asyncHandler(async (req, res) => {
  const result = await service.seedDefaults(req.user);
  res.json({
    success: true,
    message: `${result.created.length} added, ${result.skipped} already present`,
    data: result,
  });
});