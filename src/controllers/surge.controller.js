'use strict';

/**
 * src/controllers/surge.controller.js
 *
 * Admin management of area tiers and the surge percentages they drive.
 */

const { prisma } = require('../config/prisma');
const surge = require('../services/surge.service');
const areaRadius = require('../services/areaRadius.service');
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

/**
 * Suggest a centre and radius for a named place, without creating anything.
 *
 * The admin form calls this as the name field loses focus and pre-fills the
 * rest. Separate from create so the admin sees the number, and the reason for
 * it, BEFORE committing — a radius that silently appeared is one nobody feels
 * able to question.
 */
exports.suggestArea = asyncHandler(async (req, res) => {
  const query = req.validatedQuery || req.query;
  const data = await areaRadius.suggest({ name: query.name, state: query.state });
  res.json({ success: true, data });
});

exports.createArea = asyncHandler(async (req, res) => {
  const existing = await prisma.serviceArea.findUnique({ where: { name: req.body.name } });
  if (existing) {
    throw ApiError.conflict(`An area named "${req.body.name}" already exists`, 'AREA_EXISTS');
  }

  /*
   * Geocode only what was left blank.
   *
   * An admin who typed a centre or a radius meant it — usually because they
   * know something the map does not, like a depot that serves further than the
   * town limits. Overwriting that with a derived figure would quietly undo a
   * deliberate decision.
   */
  const needsMap =
    req.body.centreLat == null || req.body.centreLng == null || req.body.radiusKm == null;

  let derived = null;
  if (needsMap) {
    derived = await areaRadius.suggest({ name: req.body.name, state: req.body.state });
  }

  const data = {
    name: req.body.name,
    tier: req.body.tier,
    centreLat: req.body.centreLat ?? derived.centre.lat,
    centreLng: req.body.centreLng ?? derived.centre.lng,
    radiusKm: req.body.radiusKm ?? derived.radiusKm,
    note: req.body.note ?? (derived ? derived.explanation : null),
    ...(req.body.isActive != null ? { isActive: req.body.isActive } : {}),
  };

  const area = await prisma.serviceArea.create({ data });
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
    data: {
      area: serialiseArea(area),
      // Echoed so the admin can see what the map contributed and why the
      // radius is what it is, rather than discovering it later.
      derived: derived
        ? { radiusKm: derived.derived.radiusKm, source: derived.derived.source,
            widenedFor: derived.widenedFor, explanation: derived.explanation }
        : null,
    },
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

/* ------------------------------------------------------------------ *
 * Route surge
 * ------------------------------------------------------------------ */

/** Decimals serialise as strings; the admin form needs numbers. */
function serialiseRoute(r) {
  return {
    id: r.id,
    name: r.name,
    origin: {
      lat: Number(r.originLat),
      lng: Number(r.originLng),
      radiusKm: r.originRadiusKm,
      label: r.originLabel,
    },
    destination: {
      lat: Number(r.destLat),
      lng: Number(r.destLng),
      radiusKm: r.destRadiusKm,
      label: r.destLabel,
    },
    bidirectional: r.bidirectional,
    pct: Number(r.pct),
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    note: r.note,
    isActive: r.isActive,
    /*
     * Derived, not stored. An admin looking at a list of rules needs to know
     * which ones are actually charging RIGHT NOW — a rule can be active and
     * still be dormant because its window has not opened or has closed, and
     * "is_active: true" on a Dussehra rule in December is honest but
     * misleading. Computed here rather than in the client so the admin panel
     * and any other consumer agree on what "live" means.
     */
    live:
      r.isActive &&
      (!r.startsAt || new Date(r.startsAt) <= new Date()) &&
      (!r.endsAt || new Date(r.endsAt) >= new Date()),
    updatedAt: r.updatedAt,
  };
}

/** Flat body -> the column names. Only keys actually sent are touched. */
function routeData(body) {
  const out = {};
  for (const k of [
    'name', 'originLat', 'originLng', 'originRadiusKm', 'originLabel',
    'destLat', 'destLng', 'destRadiusKm', 'destLabel',
    'bidirectional', 'pct', 'startsAt', 'endsAt', 'note', 'isActive',
  ]) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

exports.listRoutes = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query || {};
  const routes = await prisma.surgeRoute.findMany({
    where: q.includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: 'desc' }, { startsAt: 'asc' }, { name: 'asc' }],
  });
  res.json({
    success: true,
    data: { count: routes.length, routes: routes.map(serialiseRoute) },
  });
});

exports.createRoute = asyncHandler(async (req, res) => {
  const route = await prisma.surgeRoute.create({ data: routeData(req.body) });
  await surge.invalidate();

  audit.recordAsync({
    actor: req.user,
    action: 'SURGE_ROUTE_CREATED',
    entityType: 'surge_route',
    entityId: route.id,
    after: serialiseRoute(route),
    meta: auditMeta(req),
  });

  res.status(201).json({
    success: true,
    message: `${route.name} added — applies to new quotes, not to bookings already made`,
    data: { route: serialiseRoute(route) },
  });
});

exports.updateRoute = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const before = await prisma.surgeRoute.findUnique({ where: { id } });
  if (!before) throw ApiError.notFound('No such route rule', 'SURGE_ROUTE_NOT_FOUND');

  /*
   * The window order is re-checked against the MERGED row, not the body.
   *
   * A PATCH that sends only `endsAt` passes the validator — which can only see
   * one edge — and would otherwise be able to set an end before the stored
   * start. The database CHECK would catch it, but as a 500 rather than as the
   * sentence an admin can act on.
   */
  const merged = { ...before, ...routeData(req.body) };
  if (merged.startsAt && merged.endsAt && new Date(merged.endsAt) <= new Date(merged.startsAt)) {
    throw ApiError.badRequest(
      'The end of the window must be after its start',
      'SURGE_ROUTE_WINDOW_INVALID',
    );
  }

  const route = await prisma.surgeRoute.update({ where: { id }, data: routeData(req.body) });
  await surge.invalidate();

  audit.recordAsync({
    actor: req.user,
    action: 'SURGE_ROUTE_UPDATED',
    entityType: 'surge_route',
    entityId: route.id,
    before: serialiseRoute(before),
    after: serialiseRoute(route),
    meta: auditMeta(req),
  });

  res.json({
    success: true,
    message: 'Route surge updated — applies to new quotes, not to bookings already made',
    data: { route: serialiseRoute(route) },
  });
});

/**
 * Retires rather than removes, like every other rule in this system.
 *
 * A festival rule is the one an admin is most likely to want back next year,
 * and deleting it throws away the corridor, the radii and the percentage that
 * somebody tuned. Deactivated rules are still listed with includeInactive, so
 * next Dussehra is two clicks rather than a re-survey.
 */
exports.deactivateRoute = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const before = await prisma.surgeRoute.findUnique({ where: { id } });
  if (!before) throw ApiError.notFound('No such route rule', 'SURGE_ROUTE_NOT_FOUND');

  const route = await prisma.surgeRoute.update({ where: { id }, data: { isActive: false } });
  await surge.invalidate();

  audit.recordAsync({
    actor: req.user,
    action: 'SURGE_ROUTE_DEACTIVATED',
    entityType: 'surge_route',
    entityId: route.id,
    before: serialiseRoute(before),
    after: serialiseRoute(route),
    meta: auditMeta(req),
  });

  res.json({
    success: true,
    message: `${route.name} switched off`,
    data: { route: serialiseRoute(route) },
  });
});

/**
 * Would this trip pick up a corridor premium, and which one?
 *
 * The admin counterpart to /areas/classify. Two circles and a date window are
 * hard to hold in your head, and the alternative way to check a new Dussehra
 * rule is to book a test trip — which quotes it, logs it, and still only tells
 * you about the one route you tried.
 */
exports.previewRoute = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const match = await surge.matchRoute({
    pickupPoint: { lat: Number(q.pickupLat), lng: Number(q.pickupLng) },
    dropPoint: { lat: Number(q.dropLat), lng: Number(q.dropLng) },
    pickupAt: q.pickupAt || new Date(),
  });

  res.json({
    success: true,
    data: {
      matched: Boolean(match),
      route: match,
      /*
       * Said explicitly, because "matched: false" has two very different
       * causes and an admin debugging a rule needs to know which: the circles
       * did not contain the trip, or they did and the date fell outside the
       * window.
       */
      pickupAt: q.pickupAt || new Date(),
    },
  });
});