'use strict';

/**
 * src/services/review.service.js
 *
 * A rider's rating of one completed trip, and the driver average it feeds.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');

/**
 * Submit or update a review.
 *
 * ONLY FOR A COMPLETED TRIP. Rating a journey that has not happened is not a
 * review of anything, and allowing it would let a rider rate a driver they
 * have not met — which is how ratings get used as leverage during a trip.
 *
 * UPSERT, not insert. A rider who rates three stars and then wants to change
 * it to five after the driver sorted something out should be able to. The
 * earlier value is not kept: a rating that can be produced as a history is one
 * that gets argued over rather than acted on.
 */
async function submit(bookingId, actor, { rating, comment }) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      customerId: true,
      allocations: {
        // Any allocation, not just ACTIVE: allocations are released when the
        // trip ends, so by review time the ACTIVE one is gone. Newest first,
        // which is the driver who finished the trip.
        orderBy: { createdAt: 'desc' },
        select: { driverId: true },
        take: 1,
      },
    },
  });

  if (!booking) throw ApiError.notFound('Booking not found');

  // Ownership before anything else, so a probe cannot learn a booking's status
  // from the error it gets back.
  if (booking.customerId !== actor.id) {
    throw ApiError.forbidden('This is not your trip', 'NOT_YOUR_BOOKING');
  }

  if (booking.status !== 'COMPLETED') {
    throw ApiError.badRequest(
      'You can rate a trip once it is completed.',
      'TRIP_NOT_COMPLETED'
    );
  }

  const driverId = booking.allocations?.[0]?.driverId ?? null;
  const text = typeof comment === 'string' && comment.trim() ? comment.trim() : null;

  const review = await prisma.tripReview.upsert({
    where: { bookingId },
    create: { bookingId, customerId: booking.customerId, driverId, rating, comment: text },
    update: {
      rating,
      comment: text,
      /*
       * Back to NEW on an edit. A review ops already marked REVIEWED, which the
       * rider then changed from five stars to one, must come back into the
       * queue — leaving it REVIEWED would bury the complaint that matters.
       */
      status: 'NEW',
    },
  });

  // Recomputed after the write so it includes this review, and so an edited
  // rating does not leave the average reflecting the old value.
  if (driverId) await recomputeDriverRating(driverId);

  return review;
}

/**
 * Recalculate a driver's average from the reviews themselves.
 *
 * A running average kept by incrementing would drift the first time a rating
 * was edited or a review deleted, and there would be no way to tell it had.
 * Recomputing is one indexed aggregate over a small set.
 *
 * Deliberately not wrapped in the review's transaction: a failure here must not
 * lose the rider's review. The average is derived data and can be rebuilt.
 */
async function recomputeDriverRating(driverId) {
  try {
    const agg = await prisma.tripReview.aggregate({
      where: { driverId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await prisma.driver.update({
      where: { id: driverId },
      data: {
        // Falls back to the 5.00 default when every review is withdrawn, which
        // matches how a driver with no reviews at all reads.
        ratingAvg: (agg._avg.rating ?? 5).toFixed(2),
        ratingCount: agg._count.rating ?? 0,
      },
    });
  } catch (err) {
    console.warn('[review] could not recompute driver rating', driverId, err?.message);
  }
}

/** The rider's own review of a trip, or null. */
async function forBooking(bookingId, actor) {
  const review = await prisma.tripReview.findUnique({ where: { bookingId } });
  if (!review) return null;
  if (review.customerId !== actor.id && actor.role === 'USER') {
    throw ApiError.forbidden('This is not your review', 'NOT_YOUR_REVIEW');
  }
  return review;
}

/**
 * The admin list. Newest first, filterable by rating and workflow status.
 *
 * Joins the booking and customer so the list is readable without a second
 * request per row — an ops screen showing "3 stars" with no idea which trip or
 * who wrote it is not usable.
 */
async function list({ page = 1, limit = 20, status, maxRating } = {}) {
  const where = {
    ...(status ? { status } : {}),
    // "Show me the problems": everything at or below N stars.
    ...(maxRating ? { rating: { lte: Number(maxRating) } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.tripReview.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        booking: {
          select: {
            bookingNumber: true,
            tripType: true,
            pickupAddress: true,
            dropAddress: true,
            pickupAt: true,
            vehicleClass: true,
            customer: { select: { user: { select: { name: true, phone: true } } } },
          },
        },
      },
    }),
    prisma.tripReview.count({ where }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
}

/** Ops marking a review handled, with an optional note. */
async function setStatus(bookingId, { status, adminNote }) {
  if (!['NEW', 'REVIEWED', 'ACTIONED'].includes(status)) {
    throw ApiError.badRequest('Unknown review status', 'BAD_STATUS');
  }
  return prisma.tripReview.update({
    where: { bookingId },
    data: { status, ...(adminNote !== undefined ? { adminNote } : {}) },
  });
}

module.exports = { submit, forBooking, list, setStatus, recomputeDriverRating };