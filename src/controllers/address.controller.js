'use strict';

/**
 * src/controllers/address.controller.js
 *
 * Every handler passes the OWNING customer id into the service, never just the
 * address id. That is what makes the ownership check part of the query rather
 * than an afterthought.
 */

const addressService = require('../services/address.service');
const customerService = require('../services/customer.service');
const { asyncHandler } = require('../utils/helpers');

/** Staff may act on any customer's addresses; a customer only on their own. */
function targetCustomerId(req) {
  if (req.params.customerId && req.user.role !== 'USER') return req.params.customerId;
  return req.user.id;
}

exports.list = asyncHandler(async (req, res) => {
  const addresses = await addressService.listForCustomer(targetCustomerId(req));
  res.json({ success: true, data: { addresses } });
});

exports.getOne = asyncHandler(async (req, res) => {
  const address = await addressService.findForCustomer(req.params.id, targetCustomerId(req));
  res.json({ success: true, data: { address } });
});

exports.create = asyncHandler(async (req, res) => {
  const customerId = targetCustomerId(req);
  await customerService.findOrCreate(customerId);   // materialise if absent
  const address = await addressService.create(customerId, req.body);
  res.status(201).json({ success: true, message: 'Address saved', data: { address } });
});

exports.update = asyncHandler(async (req, res) => {
  const address = await addressService.update(req.params.id, targetCustomerId(req), req.body);
  res.json({ success: true, message: 'Address updated', data: { address } });
});

exports.setDefault = asyncHandler(async (req, res) => {
  const address = await addressService.setDefault(req.params.id, targetCustomerId(req));
  res.json({ success: true, message: 'Default address set', data: { address } });
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await addressService.remove(req.params.id, targetCustomerId(req));
  res.json({ success: true, ...result });
});

exports.setCoordinates = asyncHandler(async (req, res) => {
  const address = await addressService.setCoordinates(
    req.params.id,
    targetCustomerId(req),
    req.body
  );
  res.json({ success: true, message: 'Coordinates saved', data: { address } });
});