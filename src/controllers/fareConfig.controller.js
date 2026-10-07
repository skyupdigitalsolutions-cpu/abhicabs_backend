'use strict';

/**
 * src/controllers/fareConfig.controller.js
 *
 * Admin rate-card management. Thin by design — everything that decides
 * anything lives in the service.
 */

const service = require('../services/fareConfig.service');
const { asyncHandler } = require('../utils/helpers');

const q = (req) => req.validatedQuery || req.query || {};
const auditMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** "Karnataka (all cities)" or "Bengaluru" — what the card actually covers. */
const where = (config) => config.scopeLabel || config.city?.name || 'this city';

exports.list = asyncHandler(async (req, res) => {
  const data = await service.list(q(req));
  res.json({ success: true, data });
});

exports.cities = asyncHandler(async (req, res) => {
  const data = await service.listCities(q(req));
  res.json({ success: true, data });
});

/**
 * The states the "All cities in…" option offers.
 *
 * Each carries the cities it would cover, so the form can show "applies to 14
 * cities" before the admin saves rather than after — a statewide card is the
 * one write here whose blast radius is not obvious from the form.
 */
exports.states = asyncHandler(async (req, res) => {
  const data = await service.listStates(q(req));
  res.json({ success: true, data });
});

exports.vehicleClasses = asyncHandler(async (req, res) => {
  const data = await service.listVehicleClasses();
  res.json({ success: true, data });
});

exports.coverage = asyncHandler(async (req, res) => {
  const data = await service.coverage(req.params.cityId);
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  const config = await service.getById(req.params.id);
  res.json({ success: true, data: { config } });
});

exports.create = asyncHandler(async (req, res) => {
  const config = await service.create(req.body, req.user, auditMeta(req));
  res.status(201).json({
    success: true,
    message: `${config.vehicleClass} ${config.tripType} rate card saved for ${where(config)} — new quotes use it immediately`,
    data: { config },
  });
});

exports.update = asyncHandler(async (req, res) => {
  const config = await service.update(req.params.id, req.body, req.user, auditMeta(req));
  res.json({
    success: true,
    // Says what actually happened: trips already quoted keep their frozen price.
    message: `Rate card for ${where(config)} updated — applies to new quotes, not to bookings already made`,
    data: { config },
  });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const config = await service.deactivate(req.params.id, req.user, auditMeta(req));
  res.json({ success: true, message: `Rate card for ${where(config)} retired`, data: { config } });
});

exports.activate = asyncHandler(async (req, res) => {
  const config = await service.activate(req.params.id, req.user, auditMeta(req));
  res.json({ success: true, message: 'Rate card reactivated', data: { config } });
});

/**
 * Removes the row for good — a separate verb from retiring, on a separate path.
 *
 * The 200 carries `unpricedCities`, which is empty on every normal delete and
 * non-empty only when `force` was used. The UI should surface it loudly: it is
 * the list of places that can no longer quote this class.
 */
exports.destroy = asyncHandler(async (req, res) => {
  const { force } = q(req);
  const result = await service.destroy(
    req.params.id,
    { force },
    req.user,
    auditMeta(req),
  );

  const warning = result.unpricedCities.length
    ? ` — ${result.unpricedCities.length} ${result.unpricedCities.length === 1 ? 'city' : 'cities'} can no longer quote ${result.config.vehicleClass} ${result.config.tripType}`
    : '';

  res.json({
    success: true,
    message: `Rate card deleted${warning}`,
    data: result,
  });
});

exports.clone = asyncHandler(async (req, res) => {
  const config = await service.clone(req.params.id, req.body, req.user, auditMeta(req));
  res.status(201).json({
    success: true,
    message: `Copied to ${where(config)} — ${config.vehicleClass} ${config.tripType}, effective ${new Date(config.effectiveFrom).toISOString()}`,
    data: { config },
  });
});