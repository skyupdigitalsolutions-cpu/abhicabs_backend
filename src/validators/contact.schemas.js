
'use strict';

/**
 * src/validators/contact.schemas.js
 *
 * Validation for the public "contact us" form and the staff inbox that reads it.
 * Field limits mirror the DB column sizes in prisma/schema.prisma so a value that
 * passes here can never overflow the column.
 */

const { z } = require('zod');

const STATUSES = ['NEW', 'READ', 'RESPONDED', 'ARCHIVED'];

const name = z.string().trim().min(2, 'Please enter your name').max(120);
const mobile = z
  .string()
  .trim()
  .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid mobile number');
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(180);
const topic = z.string().trim().min(2, 'Please choose a topic').max(120);
const message = z.string().trim().min(5, 'Message is too short').max(2000);

/** What the website form posts. Unknown keys (e.g. a spoofed status) are stripped. */
const createContactSchema = z.object({ name, mobile, email, topic, message });

/** Admin inbox listing. */
const listContactsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid('Invalid id') });

const updateStatusSchema = z.object({ status: z.enum(STATUSES) });

module.exports = {
  STATUSES,
  createContactSchema,
  listContactsSchema,
  idParamSchema,
  updateStatusSchema,
};