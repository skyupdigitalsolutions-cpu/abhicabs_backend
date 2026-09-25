'use strict';

/**
 * src/controllers/surge.controller.js
 *
 * Admin management of area tiers and the surge percentages they drive.
 */

const { prisma } = require('../config/prisma');
const surge = require('../services/surge.service');
const audit = require('../services/audit.service');
const { asyncHandler, ApiError } = require('../utils/helpers');

const auditMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** Decimals serialise as strings; the admin form needs numbers. */
function serialiseRule(r) {
  return {
    tier: r.tier,
    immediateWithinMinutes: r.immediateWithinMinutes,
    immediatePct: Number(r.immediatePct),
    standardPct: Number(r.standardPct),
    isActive: r.isActive,
    updatedAt: r.updatedAt,
  };
}

function serialiseArea(a) {
  return {
    id: a.id,
    name: a.name,
    tier: a.tier,
    centreLat: Number(a.centreLat),
    centreLng: Number(a.centreLng),
    radiusKm: a.radiusKm,
    note: a.note,
    isActive: a.isActive,
  };
}

/* ------------------------------- areas ---------------------------------- */

exports.listAreas = asyncHandler(async (req, res) => {
  const areas = await prisma.serviceArea.findMany({
    orderBy: [{ tier: 'asc' }, { name: 'asc' }],
  });
  res.json({ success: true, data: { count: areas.length, areas: areas.map(serialiseArea) } });
});

exports.createArea = asyncHandler(async (req, res) => {
  const existing = await prisma.serviceArea.findUnique({ where: { name: req.body.name } });
  if (existing) {
    throw ApiError.conflict(`An area named "${req.body.name}" already exists`, 'AREA_EXISTS');
  }

  const area = await prisma.serviceArea.create({ data: req.body });
  await surge.invalidate();

  audit.recordAsync({
    actor: req.user,
    action: 'SURGE_AREA_CREATED',
    entityType: 'service_area',
    entityId: area.id,
    after: serialiseArea(area),
    meta: auditMeta(req),
  });

  res.status(201).json({
    success: true,
    message: `${area.name} added as ${area.tier.toLowerCase()}`,
    data: { area: serialiseArea(area) },
  });
});

exports.updateArea = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const before = await prisma.serviceArea.findUnique({ where: { id } });
  if (!before) throw ApiError.notFound('Area not found', 'AREA_NOT_FOUND');

  const area = await prisma.serviceArea.update({ where: { id }, data: req.body });
  await surge.invalidate();

  audit.recordAsync({
    actor: req.user,
    action: 'SURGE_AREA_UPDATED',
    entityType: 'service_area',
    entityId: id,
    before: serialiseArea(before),
    after: serialiseArea(area),
    meta: auditMeta(req),
  });

  res.json({ success: true, message: 'Area updated', data: { area: serialiseArea(area) } });
});

/**
 * Deactivate, never delete.
 *
 * A removed area changes what past quotes would have cost, and those quotes
 * are frozen on real bookings. Keeping the row means a dispute can still be
 * answered with the rule that applied at the time.
 */
exports.deactivateArea = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const area = await prisma.serviceArea.update({ where: { id }, data: { isActive: false } });
  await surge.invalidate();

  audit.recordAsync({
    actor: req.user,
    action: 'SURGE_AREA_DEACTIVATED',
    entityType: 'service_area',
    entityId: id,
    after: serialiseArea(area),
    meta: auditMeta(req),
  });

  res.json({ success: true, message: `${area.name} retired`, data: { area: serialiseArea(area) } });
});

/* ------------------------------- rules ---------------------------------- */

exports.listRules = asyncHandler(async (_req, res) => {
  const rules = await prisma.surgeRule.findMany({ orderBy: { tier: 'asc' } });
  res.json({ success: true, data: { rules: rules.map(serialiseRule) } });
});

/**
 * Rules are UPDATED, never created or deleted — there is exactly one row per
 * tier and the tiers are an enum. Nothing here can leave a tier without a
 * rule, which the resolver would have to treat as zero surge.
 */
exports.updateRule = asyncHandler(async (req, res) => {
  const tier = req.params.tier;
  const before = await prisma.surgeRule.findUnique({ where: { tier } });
  if (!before) throw ApiError.notFound('No rule for that tier', 'SURGE_RULE_NOT_FOUND');

  const rule = await prisma.surgeRule.update({ where: { tier }, data: req.body });
  await surge.invalidate();

  audit.recordAsync({
    actor: req.user,
    action: 'SURGE_RULE_UPDATED',
    entityType: 'surge_rule',
    entityId: rule.id,
    before: serialiseRule(before),
    after: serialiseRule(rule),
    meta: auditMeta(req),
  });

  res.json({
    success: true,
    // Says what actually happens: quotes already given keep their frozen fare.
    message: 'Surge updated — applies to new quotes, not to bookings already made',
    data: { rule: serialiseRule(rule) },
  });
});

/**
 *Try a coordinate against the configured areas.
 *
 * Exists because a radius is hard to reason about on a map: an admin adding
 * "Ramanagara, 15 km" needs to check it actually catches the pickup points
 * they mean, and that it does not swallow a neighbouring village.
 */
exports.classify = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const result = await surge.classify({ lat: Number(q.lat), lng: Number(q.lng) });
  res.json({ success: true, data: result });
});