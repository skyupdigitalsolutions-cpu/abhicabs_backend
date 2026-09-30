'use strict';

/**
 * src/controllers/review.controller.js
 *
 * Rider-facing review endpoints. The admin list lives in admin routes.
 */

const reviewService = require('../services/review.service');
const { asyncHandler } = require('../utils/helpers');

exports.submit = asyncHandler(async (req, res) => {
  const review = await reviewService.submit(req.params.id, req.user, req.body);
  res.json({ success: true, message: 'Thanks for your feedback', data: { review } });
});

/**
 * The rider's own review, or null.
 *
 * Null rather than 404: "you have not rated this trip" is a normal state the
 * app asks about every time it opens a completed trip, and an error would make
 * the common case look like a failure.
 */
exports.mine = asyncHandler(async (req, res) => {
  const review = await reviewService.forBooking(req.params.id, req.user);
  res.json({ success: true, data: { review } });
});