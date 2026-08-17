'use strict';

/**
 * src/models/booking.model.js
 *
 * Select shapes and constants for bookings. Allowlists, so a newly added
 * sensitive column is excluded by default rather than accidentally exposed.
 */

const BOOKING_SELECT = {
  id: true,
  bookingNumber: true,
  customerId: true,
  corporateAccountId: true,
  cityId: true,
  tripType: true,
  status: true,
  vehicleClass: true,
  pickupAddress: true,
  pickupLat: true,
  pickupLng: true,
  dropAddress: true,
  dropLat: true,
  dropLng: true,
  stops: true,
  pickupAt: true,
  returnAt: true,
  distanceKm: true,
  durationMinutes: true,
  estimatedFare: true,
  finalFare: true,
  advancePaid: true,
  balanceDue: true,
  cancellationFee: true,
  refundAmount: true,
  paymentMode: true,
  paymentMethod: true,
  fareBasis: true,
  surgeMultiplier: true,
  driverSharePct: true,
  cancelledAt: true,
  cancelledByType: true,
  cancellationReason: true,
  specialRequests: true,
  confirmedAt: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  customer: {
    select: {
      userId: true,
      accountType: true,
      user: { select: { id: true, name: true, phone: true, email: true } },
    },
  },
  corporate: { select: { id: true, companyName: true, gstin: true, billingCycle: true } },
  city: { select: { id: true, name: true, state: true } },
};

/**
 * List shape omits fareBasis deliberately — it is a large JSON blob, and
 * returning it for fifty rows would make a list response many times bigger than
 * it needs to be.
 */
const BOOKING_LIST_SELECT = {
  id: true,
  bookingNumber: true,
  customerId: true,
  tripType: true,
  status: true,
  vehicleClass: true,
  pickupAddress: true,
  dropAddress: true,
  pickupAt: true,
  returnAt: true,
  distanceKm: true,
  estimatedFare: true,
  finalFare: true,
  paymentMode: true,
  createdAt: true,
  customer: { select: { userId: true, user: { select: { name: true, phone: true } } } },
  corporate: { select: { id: true, companyName: true } },
};

/**
 * The lifecycle is FORWARD-ONLY. Each status lists what may follow it.
 * Day 6 enforces these transitions; defining them here keeps the rule in one
 * place rather than scattered through controllers.
 */
const STATUS_FLOW = Object.freeze({
  PENDING:   ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['ALLOCATED', 'CANCELLED'],
  ALLOCATED: ['EN_ROUTE', 'CANCELLED'],
  EN_ROUTE:  ['ONGOING', 'CANCELLED'],
  ONGOING:   ['COMPLETED'],          // a trip in progress cannot be cancelled
  COMPLETED: [],                     // terminal
  CANCELLED: [],                     // terminal
  EXPIRED:   [],                     // terminal
});

/** Statuses that still occupy a vehicle or await action. */
const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE', 'ONGOING'];

const SORTABLE = ['createdAt', 'pickupAt', 'estimatedFare', 'status'];

module.exports = {
  BOOKING_SELECT,
  BOOKING_LIST_SELECT,
  STATUS_FLOW,
  ACTIVE_STATUSES,
  SORTABLE,
};