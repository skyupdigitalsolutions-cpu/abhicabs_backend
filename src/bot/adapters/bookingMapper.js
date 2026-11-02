'use strict';
/**
 * Turns a website `bookings` row into the shape the bot's handlers already
 * read (booking.fare.total, booking.pickup.address, booking.status ...), so
 * the conversation code does not have to change.
 */
const { prisma } = require('../../config/prisma');
const { vehicleInfo } = require('./vehicleInfo');

// website status -> bot status
const STATUS = {
  PENDING: 'PAYMENT_PENDING',        // refined below: unpaid advance vs. waiting for admin
  CONFIRMED: 'CONFIRMED',
  ALLOCATED: 'DRIVER_ASSIGNED',
  EN_ROUTE: 'DRIVER_ASSIGNED',
  REACHED: 'DRIVER_ASSIGNED',
  ARRIVED: 'DRIVER_ASSIGNED',
  ONGOING: 'ONGOING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Active driver + car for a booking (same join the old siteSync used). */
async function driverFor(bookingId) {
  const rows = await prisma.$queryRaw`
    SELECT u.name AS driver_name, u.phone AS driver_phone,
           v.registration_number AS vehicle_number, v.make_model AS vehicle_model
    FROM allocations a
    LEFT JOIN users u ON u.id = a.driver_id
    LEFT JOIN vehicles v ON v.id = a.vehicle_id
    WHERE a.booking_id = ${bookingId}::uuid AND a.status = 'ACTIVE'
    ORDER BY a.created_at DESC LIMIT 1`;
  const r = rows[0];
  if (!r || (!r.driver_name && !r.vehicle_number)) return null;
  return { name: r.driver_name, phone: r.driver_phone, vehicleNumber: r.vehicle_number, vehicleModel: r.vehicle_model };
}

async function toBotBooking(b, { withDriver = true } = {}) {
  if (!b) return null;
  const total = num(b.estimatedFare);
  const paid = num(b.advancePaid) || 0;
  const meta = b.meta || {};
  const user = await prisma.user.findUnique({ where: { id: b.customerId }, select: { name: true, phone: true } });
  const vehicle = await vehicleInfo(b.vehicleClass);
  // Every website booking stays PENDING until staff confirm it. Once the rider has done their part
  // (pay-later chosen, or the advance paid) the bot shows it as received, and says staff will confirm.
  const riderDone = b.status === 'PENDING' && (b.paymentMode === 'ZERO' || paid > 0);
  return {
    id: b.id,
    _id: b.id,
    bookingNumber: b.bookingNumber,
    channel: meta.source === 'whatsapp-bot' ? 'WHATSAPP' : 'WEBSITE',
    customerId: b.customerId,
    passenger: { name: b.guestName || (user && user.name) || null, phone: String(b.guestPhone || (user && user.phone) || '').replace(/\D/g, '') || null, passengerCount: meta.passengerCount || null },
    tripType: b.tripType,
    pickup: { address: b.pickupAddress, latitude: num(b.pickupLat), longitude: num(b.pickupLng) },
    drop: { address: b.dropAddress, latitude: num(b.dropLat), longitude: num(b.dropLng), stops: b.stops || [] },
    pickupAt: b.pickupAt,
    returnAt: b.returnAt,
    rentalHours: b.rentalHours,
    vehicle: { vehicleId: vehicle.vehicleId, name: vehicle.name, category: vehicle.category },
    fare: {
      total,
      amountPaid: paid,
      amountDue: num(b.balanceDue) ?? Math.max(0, total - paid),
      paymentMode: b.paymentMode === 'ZERO' ? 'PAY_LATER' : b.paymentMode,
      currency: 'INR',
      breakdown: b.fareBasis || null,
    },
    status: riderDone ? 'CONFIRMED' : (STATUS[b.status] || b.status),
    awaitingConfirmation: b.status === 'PENDING' && riderDone,
    siteStatus: b.status,
    startOtp: b.startOtp || null,
    driver: withDriver ? await driverFor(b.id) : null,
    cancellation:
      b.status === 'CANCELLED'
        ? { cancelledAt: b.cancelledAt, reason: b.cancellationReason, fee: num(b.cancellationFee), refundAmount: num(b.refundAmount) }
        : null,
    specialRequests: b.specialRequests,
    createdAt: b.createdAt,
  };
}

module.exports = { toBotBooking, STATUS };
