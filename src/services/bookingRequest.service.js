'use strict';

/**
 * src/services/bookingRequest.service.js
 *
 * Enquiries for trips OUTSIDE the states the fleet operates in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A BOOKING
 * ---------------------------------------------------------------------------
 * A Booking is a commitment. It holds a vehicle against an exclusion
 * constraint, carries a frozen fare that an invoice is later reconciled
 * against, and enters the dispatch board as work someone is expected to do.
 *
 * None of that can be honoured for a route with no rate card and no permit.
 * Writing one anyway would put a row on the dispatch board that no driver can
 * be assigned to, and hand the rider a booking number implying a car is coming.
 *
 * So a request is a separate object with its own lifecycle: it commits nothing,
 * prices nothing, and waits for a human.
 *
 * ---------------------------------------------------------------------------
 * NO FARE, DELIBERATELY
 * ---------------------------------------------------------------------------
 * There is no estimate here and no nullable fare column. Pricing one of these
 * means an admin quoting it by hand, out of band. A number in the response —
 * even labelled "indicative" — becomes the number the customer remembers and
 * argues from.
 */

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const { checkPlace, allowedStateNames } = require('../lib/serviceArea');
const { emit, EVENTS } = require('../lib/events');

/* ------------------------------------------------------------------ *
 * Reference number
 * ------------------------------------------------------------------ */

/**
 * REQ-YYMMDD-XXXX. Visibly NOT a booking number, because a customer reading it
 * over the phone should not be mistaken for someone with a confirmed trip.
 */
function requestNumber() {
  const d = new Date();
  const ymd =
    String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `REQ-${ymd}-${rand}`;
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

/**
 * Records an enquiry. Accepts ANY location, including serviceable ones.
 *
 * It does not re-check the states and refuse in-area requests. A rider whose
 * pickup is in Karnataka but whose drop is in Kerala still belongs here, and so
 * does one submitting from a stale app build. Turning a submitted enquiry away
 * because it looks bookable helps nobody: an admin can convert it in one step,
 * whereas a rejection sends the rider back to a form they already filled in.
 */
async function create(input, actor, meta = {}) {
  const customerId = input.customerId || actor.id;

  const customer = await prisma.user.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, phone: true, email: true, isActive: true },
  });
  if (!customer) throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');
  if (!customer.isActive) {
    throw ApiError.forbidden('Your account has been deactivated', 'ACCOUNT_INACTIVE');
  }

  const pickupCheck = await checkPlace({
    state: input.pickupState,
    formattedAddress: input.pickupAddress,
  });
  const dropCheck = await checkPlace({
    state: input.dropState,
    formattedAddress: input.dropAddress,
  });

  // Recorded at submission so the request still explains ITSELF later. A reason
  // recomputed at read time would change meaning the day a new state opens, and
  // an admin reviewing a three-week-old enquiry would see it contradict the
  // decision that created it.
  const outside = [
    !pickupCheck.ok ? `pickup (${pickupCheck.state || 'unknown state'})` : null,
    !dropCheck.ok ? `drop (${dropCheck.state || 'unknown state'})` : null,
  ].filter(Boolean);

  const reason = outside.length
    ? `Outside service area: ${outside.join(' and ')}. Serving ${(await allowedStateNames()).join(', ')}.`
    : 'Submitted as a request by the customer.';

  const request = await prisma.bookingRequest.create({
    data: {
      requestNumber: requestNumber(),
      customerId,
      tripType: input.tripType,
      vehicleClass: input.vehicleClass || null,

      pickupAddress: input.pickupAddress,
      pickupLat: input.pickupLat ?? null,
      pickupLng: input.pickupLng ?? null,
      pickupState: pickupCheck.state || input.pickupState || null,

      dropAddress: input.dropAddress,
      dropLat: input.dropLat ?? null,
      dropLng: input.dropLng ?? null,
      dropState: dropCheck.state || input.dropState || null,

      pickupAt: new Date(input.pickupAt),
      returnAt: input.returnAt ? new Date(input.returnAt) : null,

      passengers: input.passengers ?? null,
      note: input.note || null,

      // Snapshotted, not joined at read time. These enquiries are worked days
      // later by phone, and a customer who changes their number in the
      // meantime should not become unreachable on an open request.
      contactName: input.contactName || customer.name || null,
      contactPhone: input.contactPhone || customer.phone || null,
      contactEmail: input.contactEmail || customer.email || null,

      reason,
      status: 'NEW',
    },
  });

  emit(EVENTS.BOOKING_REQUEST_CREATED, {
    requestId: request.id,
    requestNumber: request.requestNumber,
    customerId,
    pickupState: request.pickupState,
    dropState: request.dropState,
    ip: meta.ip || null,
  });

  return request;
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/** The customer's own requests, newest first. */
async function listMine(customerId, { take = 20, skip = 0 } = {}) {
  const [rows, total] = await Promise.all([
    prisma.bookingRequest.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 50),
      skip,
    }),
    prisma.bookingRequest.count({ where: { customerId } }),
  ]);
  return { requests: rows, total };
}

/** The ops queue. Defaults to what still needs a human. */
async function list({ status, take = 25, skip = 0 } = {}) {
  const where = status ? { status } : { status: { in: ['NEW', 'REVIEWING', 'QUOTED'] } };

  const [rows, total] = await Promise.all([
    prisma.bookingRequest.findMany({
      where,
      orderBy: { createdAt: 'asc' }, // oldest first: a queue, not a feed
      take: Math.min(take, 100),
      skip,
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
      },
    }),
    prisma.bookingRequest.count({ where }),
  ]);
  return { requests: rows, total };
}

async function getById(id) {
  const request = await prisma.bookingRequest.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, phone: true, email: true } },
      handledBy: { select: { id: true, name: true } },
    },
  });
  if (!request) throw ApiError.notFound('Booking request not found', 'REQUEST_NOT_FOUND');
  return request;
}

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

/** Terminal states. Reopening one would lose who decided what, and when. */
const CLOSED = new Set(['ACCEPTED', 'DECLINED', 'CANCELLED']);

async function updateStatus(id, { status, adminNote, convertedBookingId }, actor) {
  const existing = await prisma.bookingRequest.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!existing) throw ApiError.notFound('Booking request not found', 'REQUEST_NOT_FOUND');

  if (CLOSED.has(existing.status)) {
    throw ApiError.badRequest(
      `This request is already ${existing.status.toLowerCase()} and cannot be changed`,
      'REQUEST_CLOSED',
    );
  }

  return prisma.bookingRequest.update({
    where: { id },
    data: {
      ...(status ? { status } : {}),
      ...(adminNote !== undefined ? { adminNote } : {}),
      ...(convertedBookingId !== undefined ? { convertedBookingId } : {}),
      handledById: actor.id,
      handledAt: new Date(),
    },
  });
}

/** The customer withdrawing their own enquiry. */
async function cancelMine(id, customerId) {
  const existing = await prisma.bookingRequest.findUnique({
    where: { id },
    select: { id: true, customerId: true, status: true },
  });
  if (!existing || existing.customerId !== customerId) {
    // Same error whether it does not exist or belongs to someone else, so the
    // endpoint cannot be used to discover other people's request ids.
    throw ApiError.notFound('Booking request not found', 'REQUEST_NOT_FOUND');
  }
  if (CLOSED.has(existing.status)) {
    throw ApiError.badRequest(
      `This request is already ${existing.status.toLowerCase()}`,
      'REQUEST_CLOSED',
    );
  }

  return prisma.bookingRequest.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });
}

module.exports = { create, list, listMine, getById, updateStatus, cancelMine };