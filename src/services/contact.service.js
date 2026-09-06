'use strict';

/**
 * src/services/contact.service.js
 *
 * Contact-form submissions. `submit` is called from the PUBLIC endpoint (no
 * auth), so it stores only what the schema allows plus light request metadata
 * (ip / user-agent) for abuse triage. The list/get/updateStatus helpers back the
 * staff inbox.
 */

const { prisma } = require('../config/prisma');
const { ApiError, paginated } = require('../utils/helpers');

/** Store one submission from the website form. Returns only the id + timestamp. */
async function submit(input, meta = {}) {
  return prisma.contact.create({
    data: {
      name: input.name,
      mobile: input.mobile,
      email: input.email,
      topic: input.topic,
      message: input.message,
      ip: (meta.ip || '').slice(0, 45) || null,
      userAgent: (meta.userAgent || '').slice(0, 255) || null,
    },
    select: { id: true, createdAt: true },
  });
}

/** Paginated inbox, newest first, optionally filtered by status or a search term. */
async function list(query) {
  const { page, limit, status, search } = query;

  const where = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { topic: { contains: search, mode: 'insensitive' } },
            { mobile: { contains: search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.contact.count({ where }),
  ]);

  return paginated(items, { page, limit, total });
}

async function getById(id) {
  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) {
    throw ApiError.notFound('Contact submission not found', 'CONTACT_NOT_FOUND');
  }
  return contact;
}

async function updateStatus(id, status) {
  await getById(id); // 404s cleanly if it doesn't exist
  return prisma.contact.update({ where: { id }, data: { status } });
}

module.exports = { submit, list, getById, updateStatus };