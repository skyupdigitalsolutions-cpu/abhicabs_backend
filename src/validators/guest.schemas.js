'use strict';

const { z } = require('zod');

/**
 * Starting a guest checkout. EVERY FIELD IS OPTIONAL — an empty body is valid.
 *
 * The session exists to get a token so a visitor can see prices, not to
 * collect contact details. Demanding a name and a phone here put a form in
 * front of browsing: the visitor had to identify themselves before finding out
 * what a trip costs, which is the friction guest checkout was meant to remove.
 *
 * The contact details the driver and the invoice actually need travel with the
 * BOOKING instead, as guestName / guestPhone / guestEmail — the website
 * already collects them on its own form, so nothing is asked twice.
 *
 * Passing them here is still allowed and still useful: it names the account,
 * which is what an admin sees in the customers list instead of "Guest".
 */
const startSessionSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().min(10).max(20).optional(),
  email: z.string().trim().email().max(180).optional(),
});

/**
 * Looking a booking up afterwards.
 *
 * BOTH are required. The booking number alone is an enumeration oracle —
 * ABH-2026-001027 is one away from someone else's trip — and the phone alone
 * lists every booking a number ever made.
 */
const findBookingSchema = z.object({
  bookingNumber: z.string().trim().min(6).max(20),
  phone: z.string().trim().min(10).max(20),
});

module.exports = { startSessionSchema, findBookingSchema };