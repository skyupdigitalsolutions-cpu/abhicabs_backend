'use strict';

const service = require('../services/guest.service');
const { asyncHandler } = require('../utils/helpers');

exports.startSession = asyncHandler(async (req, res) => {
  const data = await service.startSession(req.body);
  res.status(201).json({ success: true, data });
});

exports.findBooking = asyncHandler(async (req, res) => {
  const booking = await service.findBooking(req.body);
  res.json({ success: true, data: { booking } });
});