'use strict';
const { prisma } = require('../../config/prisma');

/** The customer the booking belongs to, as the "actor" the backend services expect. */
async function actorForBooking(bookingId) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { customerId: true } });
  if (!b) throw new Error('BOOKING_NOT_FOUND');
  return { id: b.customerId, role: 'USER' };
}
const actorForCustomer = (customerId) => ({ id: customerId, role: 'USER' });

module.exports = { actorForBooking, actorForCustomer };
