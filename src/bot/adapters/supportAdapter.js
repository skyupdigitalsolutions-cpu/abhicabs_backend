'use strict';
/** A WhatsApp support request is a normal row in `contacts` — the same admin inbox as website enquiries. */
const { prisma } = require('../../config/prisma');

async function createSupportTicket({ name, whatsappNumber, bookingId, category, message }) {
  let bookingNumber = null;
  if (bookingId) {
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { bookingNumber: true } });
    bookingNumber = b && b.bookingNumber;
  }
  const digits = String(whatsappNumber).replace(/\D/g, '');
  const row = await prisma.contact.create({
    data: {
      name: String(name || 'WhatsApp customer').slice(0, 120),
      mobile: digits.slice(-15),
      email: `${digits}@whatsapp.invalid`,
      topic: `WhatsApp: ${category || 'Support'}`.slice(0, 120),
      message: `${bookingNumber ? `Booking ${bookingNumber}\n` : ''}${message || ''}`.slice(0, 4000),
    },
  });
  return { ...row, _id: row.id };
}

module.exports = { createSupportTicket };
