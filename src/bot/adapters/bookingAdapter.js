'use strict';
/**
 * Creates / reads bookings through the SAME booking.service the website and
 * the apps call — same fare engine, numbering, validation, start-OTP,
 * allocation and notifications. There is no bot_bookings table.
 */
const { prisma } = require('../../config/prisma');
const bookingService = require('../../services/booking.service');
const { toBotBooking } = require('./bookingMapper');
const { actorForCustomer } = require('./actor');

const MODE = { PAY_LATER: 'ZERO', PARTIAL: 'PARTIAL', FULL: 'FULL' };
const loc = (p) => {
  if (!p) return null;
  const out = {};
  if (Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude))) { out.lat = Number(p.latitude); out.lng = Number(p.longitude); }
  if (p.address && String(p.address).trim().length >= 3) out.address = String(p.address).trim().slice(0, 500);
  return out.lat !== undefined || out.address ? out : null;
};

async function createBooking({ idempotencyKey, customerId, cityId, passenger = {}, tripType, pickup, drop, pickupAt, returnAt, rentalHours, vehicleId, paymentMode = 'PAY_LATER', specialRequests }) {
  const actor = actorForCustomer(customerId);
  const hourly = tripType === 'HOURLY';
  const stops = hourly ? [] : ((drop && drop.stops) || []).map(loc).filter(Boolean);
  const guestPhone = String(passenger.phone || '').replace(/\D/g, '');
  const payload = {
    cityId: Number(cityId) || Number(process.env.BOT_DEFAULT_CITY_ID) || 1,
    vehicleClass: vehicleId,
    tripType,
    pickup: loc(pickup),
    ...(hourly ? {} : { drop: loc(drop) }),
    ...(stops.length ? { stops } : {}),
    pickupAt: new Date(pickupAt).toISOString(),
    scheduled: true,
    paymentMode: MODE[paymentMode] || paymentMode,
    specialRequests: specialRequests ? String(specialRequests).slice(0, 1000) : undefined,
    ...(passenger.name && guestPhone.length >= 10 ? { guestName: String(passenger.name).slice(0, 120), guestPhone: guestPhone.slice(-15) } : {}),
  };
  if (tripType === 'ROUND_TRIP') payload.returnAt = new Date(returnAt).toISOString();
  if (hourly) payload.rentalHours = Math.round(Number(rentalHours));
  if (stops.length && tripType !== 'ROUND_TRIP' && !hourly) payload.dropAt = new Date(pickupAt).toISOString().slice(0, 10);

  // A double tap / webhook retry returns the booking already made for this key (cancelled ones do not count).
  const prior = await prisma.booking.findFirst({
    where: { customerId, status: { notIn: ['CANCELLED', 'EXPIRED'] }, meta: { path: ['botKey'], string_starts_with: idempotencyKey } },
  });
  if (prior) return { booking: await toBotBooking(prior), created: false };

  const created = await bookingService.create(payload, actor, { source: 'whatsapp-bot' });
  const row = await prisma.booking.update({
    where: { id: created.id },
    data: { meta: { source: 'whatsapp-bot', botKey: `${idempotencyKey}#${Date.now()}`, passengerCount: passenger.passengerCount || null, passengerEmail: passenger.email || null } },
  });
  return { booking: await toBotBooking(row), created: true };
}

const getBookingById = async (id) => toBotBooking(await prisma.booking.findUnique({ where: { id } }));
const getBookingByNumber = async (bookingNumber) => toBotBooking(await prisma.booking.findUnique({ where: { bookingNumber } }));
async function getBookingsForCustomer(customerId, { limit = 5 } = {}) {
  const rows = await prisma.booking.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: limit });
  return Promise.all(rows.map((r) => toBotBooking(r)));
}
async function getBookingSummary(bookingId) {
  const row = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!row) return null;
  const booking = await toBotBooking(row);
  const payment = await prisma.payment.findFirst({ where: { bookingId }, orderBy: { createdAt: 'desc' } });
  return { booking, payment: payment ? { ...payment, _id: payment.id } : null, liveLocation: null };
}

module.exports = { createBooking, getBookingById, getBookingByNumber, getBookingsForCustomer, getBookingSummary };
