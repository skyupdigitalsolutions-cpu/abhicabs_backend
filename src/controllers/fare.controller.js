'use strict';

/**
 * src/controllers/fare.controller.js
 */

const quote = require('../services/quote.service');
const fare = require('../services/fare.service');
const maps = require('../services/maps.service');
const { asyncHandler } = require('../utils/helpers');

/** POST /fares/estimate — one trip, one class, one price. */
exports.estimate = asyncHandler(async (req, res) => {
  const data = await quote.getQuote(req.body);
  res.json({ success: true, data });
});

/** POST /fares/compare — the same trip priced one-way AND round trip. */
exports.compare = asyncHandler(async (req, res) => {
  const data = await quote.compareTripTypes(req.body);
  res.json({ success: true, data });
});

/** POST /fares/options — every vehicle class, cheapest first. */
exports.options = asyncHandler(async (req, res) => {
  const data = await quote.quoteAllClasses(req.body);
  res.json({ success: true, data });
});

/** GET /fares/rental-packages — local-rental packages for the hourly picker. */
exports.rentalPackages = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const packages = await quote.listRentalPackages({
    cityId: q.cityId,
    vehicleClass: q.vehicleClass || null,
  });
  res.json({ success: true, data: { packages } });
});

/** POST /fares/cancellation-fee — what a cancellation would cost right now. */
exports.cancellationFee = asyncHandler(async (req, res) => {
  const { cityId, vehicleClass, tripType, pickupAt, fareTotal } = req.body;
  const config = await quote.getFareConfig(cityId, vehicleClass, tripType);
  const result = fare.computeCancellationFee({ pickupAt, fareTotal, config });
  res.json({ success: true, data: { cancellation: result } });
});

/* ---------------- maps passthroughs ---------------- */

exports.geocode = asyncHandler(async (req, res) => {
  const result = await maps.geocode(req.body.address);
  res.json({ success: true, data: { location: result } });
});

exports.reverseGeocode = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const result = await maps.reverseGeocode(q.lat, q.lng);
  res.json({ success: true, data: { location: result } });
});

exports.autocomplete = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const suggestions = await maps.autocomplete(q.q, {
    lat: q.lat,
    lng: q.lng,
    sessionToken: q.sessionToken,
  });
  res.json({ success: true, data: { suggestions } });
});

exports.distance = asyncHandler(async (req, res) => {
  const origin = await quote.resolveLocation(req.body.origin, 'origin');
  const destination = await quote.resolveLocation(req.body.destination, 'destination');
  const route = await maps.getDistance(origin, destination, { fresh: req.body.fresh });
  res.json({ success: true, data: { origin, destination, route } });
});

/** Road route geometry (the polyline that follows streets) for drawing on a map. */
exports.route = asyncHandler(async (req, res) => {
  const origin = await quote.resolveLocation(req.body.origin, 'origin');
  const destination = await quote.resolveLocation(req.body.destination, 'destination');
  const route = await maps.getRoute(origin, destination, { fresh: req.body.fresh });
  res.json({ success: true, data: { origin, destination, route } });
});

/** Maps cache hit rates and breaker state — useful for watching the bill. */
exports.mapsHealth = asyncHandler(async (req, res) => {
  res.json({ success: true, data: maps.health() });
});