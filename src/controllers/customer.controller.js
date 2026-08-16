'use strict';

/**
 * src/controllers/customer.controller.js
 */

const customerService = require('../services/customer.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });

/* ---------------- self-service ---------------- */

exports.getMyProfile = asyncHandler(async (req, res) => {
  const customer = await customerService.findOrCreate(req.user.id);
  res.json({ success: true, data: { customer } });
});

exports.updateMyProfile = asyncHandler(async (req, res) => {
  // Note: req.user.id, never a URL parameter. There is nothing to tamper with.
  const customer = await customerService.updateSelf(req.user.id, req.body);
  res.json({ success: true, message: 'Profile updated', data: { customer } });
});

/**
 * Shows the customer who their trips are billed to. Useful in the app so a
 * corporate employee can see "billed to Acme Ltd" before confirming.
 */
exports.getMyBilling = asyncHandler(async (req, res) => {
  const billing = await customerService.resolveBillingEntity(req.user.id);
  res.json({ success: true, data: { billing } });
});

/* ---------------- staff ---------------- */

exports.listCustomers = asyncHandler(async (req, res) => {
  const data = await customerService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.getCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.findById(req.params.id);
  res.json({ success: true, data: { customer } });
});

exports.updateCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.updateByAdmin(
    req.params.id,
    req.body,
    req.user,
    meta(req)
  );
  res.json({ success: true, message: 'Customer updated', data: { customer } });
});

/**
 * The Day 3 acceptance endpoint: confirms an employee's bookings resolve to
 * the corporate billing entity.
 */
exports.getCustomerBilling = asyncHandler(async (req, res) => {
  const billing = await customerService.resolveBillingEntity(req.params.id);
  res.json({ success: true, data: { billing } });
});

exports.stats = asyncHandler(async (req, res) => {
  const data = await customerService.stats();
  res.json({ success: true, data });
});