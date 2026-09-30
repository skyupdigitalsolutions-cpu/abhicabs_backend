'use strict';

/**
 * src/controllers/assistant.controller.js
 */

const assistant = require('../services/assistant.service');
const { prisma } = require('../config/prisma');
const { asyncHandler } = require('../utils/helpers');

/**
 * The rider's live trip, if any — injected so the bot answers "where is my
 * driver" from data rather than inventing an answer.
 *
 * Read here rather than taken from the request: a client that could name its
 * own booking could read someone else's trip through the bot.
 */
async function activeTripFor(userId) {
  return prisma.booking.findFirst({
    where: {
      customerId: userId,
      status: { in: ['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE', 'REACHED', 'ONGOING', 'ARRIVED'] },
    },
    orderBy: { pickupAt: 'asc' },
    select: {
      bookingNumber: true, status: true, tripType: true, vehicleClass: true,
      pickupAddress: true, dropAddress: true, estimatedFare: true, balanceDue: true,
    },
  });
}

exports.ask = asyncHandler(async (req, res) => {
  const trip = await activeTripFor(req.user.id).catch(() => null);
  const result = await assistant.ask({
    message: req.body.message,
    history: req.body.history || [],
    trip,
  });
  res.json({ success: true, data: result });
});