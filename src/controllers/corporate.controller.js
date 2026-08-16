'use strict';

/**
 * src/controllers/corporate.controller.js
 */

const corporateService = require('../services/corporate.service');
const audit = require('../services/audit.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });

exports.list = asyncHandler(async (req, res) => {
  const data = await corporateService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  const account = await corporateService.findById(req.params.id);
  res.json({ success: true, data: { account } });
});

exports.create = asyncHandler(async (req, res) => {
  const account = await corporateService.create(req.body, req.user, meta(req));
  res.status(201).json({ success: true, message: 'Corporate account created', data: { account } });
});

exports.update = asyncHandler(async (req, res) => {
  const account = await corporateService.update(req.params.id, req.body, req.user, meta(req));
  res.json({ success: true, message: 'Corporate account updated', data: { account } });
});

exports.activate = asyncHandler(async (req, res) => {
  const account = await corporateService.setActive(req.params.id, true, req.user, meta(req));
  res.json({ success: true, message: 'Account activated', data: { account } });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const account = await corporateService.setActive(req.params.id, false, req.user, meta(req));
  res.json({ success: true, message: 'Account deactivated', data: { account } });
});

/* ---------------- employees ---------------- */

exports.listEmployees = asyncHandler(async (req, res) => {
  const data = await corporateService.listEmployees(req.params.id, req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.attachEmployee = asyncHandler(async (req, res) => {
  const customer = await corporateService.attachEmployee(
    req.params.id,
    req.body.customerId,
    req.user,
    meta(req)
  );
  res.status(201).json({
    success: true,
    message: 'Employee attached — their bookings now bill to this account',
    data: { customer },
  });
});

exports.detachEmployee = asyncHandler(async (req, res) => {
  const customer = await corporateService.detachEmployee(
    req.params.id,
    req.params.customerId,
    req.user,
    meta(req)
  );
  res.json({
    success: true,
    message: 'Employee detached — reverted to RETAIL billing',
    data: { customer },
  });
});

/* ---------------- audit trail ---------------- */

exports.trail = asyncHandler(async (req, res) => {
  const entries = await audit.trailFor(audit.ENTITIES.CORPORATE_ACCOUNT, req.params.id);
  res.json({ success: true, data: { entries } });
});

exports.stats = asyncHandler(async (req, res) => {
  const data = await corporateService.stats();
  res.json({ success: true, data });
});