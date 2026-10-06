'use strict';

/**
 * src/controllers/city.controller.js
 *
 * Admin management of cities. Thin by design — the service decides everything.
 *
 * The only thing worth noting here is the `warning` field. The service returns
 * a non-null warning when the city's state is not on the service-state
 * allowlist, which means the city is fully configured and will still refuse
 * every pickup. That is the kind of thing a 201 with a cheerful message hides,
 * so it is promoted into the message itself as well as the body.
 */

const service = require('../services/city.service');
const { asyncHandler } = require('../utils/helpers');

const q = (req) => req.validatedQuery || req.query || {};
const auditMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.list = asyncHandler(async (req, res) => {
  const data = await service.list(q(req));
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  const city = await service.getById(req.params.id);
  res.json({ success: true, data: { city } });
});

exports.create = asyncHandler(async (req, res) => {
  const { city, copied, warning } = await service.create(req.body, req.user, auditMeta(req));

  const parts = [`${city.name}, ${city.state} added`];
  if (copied) {
    parts.push(
      `${copied.rateCards} rate card(s) and ${copied.rentalPackages} rental package(s) copied from ${copied.from.name}`,
    );
  } else {
    // Said plainly, because a city with no rate cards quotes nothing and the
    // failure the rider sees is FARE_CONFIG_MISSING, which names no city.
    parts.push('no rate cards yet — it cannot quote until you add them');
  }
  if (warning) parts.push(warning);

  res.status(201).json({
    success: true,
    message: parts.join('. '),
    data: { city, copied, warning },
  });
});

exports.update = asyncHandler(async (req, res) => {
  const { city, warning } = await service.update(
    req.params.id,
    req.body,
    req.user,
    auditMeta(req),
  );
  res.json({
    success: true,
    message: warning ? `City updated. ${warning}` : 'City updated — new quotes use it immediately',
    data: { city, warning },
  });
});

exports.deactivate = asyncHandler(async (req, res) => {
  const city = await service.deactivate(req.params.id, req.user, auditMeta(req));
  res.json({
    // Says "deactivated", not "deleted", because that is what happened — the
    // row survives so the bookings that reference it still explain themselves.
    success: true,
    message: `${city.name} deactivated — no new quotes will use it`,
    data: { city },
  });
});

exports.activate = asyncHandler(async (req, res) => {
  const { city, warning } = await service.activate(req.params.id, req.user, auditMeta(req));
  res.json({
    success: true,
    message: warning ? `${city.name} reactivated. ${warning}` : `${city.name} reactivated`,
    data: { city, warning },
  });
});