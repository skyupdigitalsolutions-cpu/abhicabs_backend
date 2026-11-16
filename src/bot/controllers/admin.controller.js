const { getPrisma } = require('../config/db');
const { wrapSession } = require('../conversation/sessionRecord');
const { STATES } = require('../conversation/states');
const { inServiceWindow } = require('../conversation/serviceWindow');

/**
 * Bot admin endpoints. Served twice:
 *   /bot-admin/*                 x-admin-key (scripts, monitoring)
 *   /api/v1/admin/whatsapp/*     staff JWT   (the ERP's WhatsApp page — see src/routes/whatsappAdmin.routes.js)
 *
 * Every handler is wrapped so a database error answers 500 instead of leaving
 * the request hanging (Express 4 does not catch rejected async handlers).
 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (typeof next === 'function' && !res.headersSent) return next(err);
  if (!res.headersSent) fail(res, 500, 'INTERNAL', err.message || 'Internal error');
  return undefined;
});

// Same error shape as the rest of the API, so the ERP's apiClient shows the real message.
const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

// The values the `contacts.status` column actually allows (enum ContactStatus).
const TICKET_STATUSES = ['NEW', 'READ', 'RESPONDED', 'ARCHIVED'];

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

async function attachCustomers(prisma, rows) {
  const ids = [...new Set(rows.map((r) => r.customerId).filter(Boolean))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true, email: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const now = Date.now();
  return rows.map((r) => ({
    ...withId(r),
    customer: byId.get(r.customerId) || null,
    // Free text can only be sent while this is true (WhatsApp's 24-hour window).
    canMessage: inServiceWindow(r.lastMessageAt, now),
  }));
}

/** GET stats — high-level monitoring numbers (spec section 50). */
const getStats = wrap(async (req, res) => {
  const prisma = getPrisma();
  const [
    activeConversations,
    totalConversations,
    totalBookings,
    successfulPayments,
    failedPayments,
    abandonedBookings,
    humanHandoffs,
    openSupportTickets,
  ] = await Promise.all([
    prisma.whatsappSession.count({ where: { lastMessageAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } } }),
    prisma.whatsappSession.count(),
    prisma.booking.count({ where: { meta: { path: ['source'], equals: 'whatsapp-bot' } } }),
    prisma.payment.count({ where: { status: 'CAPTURED' } }),
    prisma.payment.count({ where: { status: 'FAILED' } }),
    prisma.whatsappAbandonedBooking.count({ where: { recovered: false } }),
    prisma.whatsappSession.count({ where: { humanHandoff: true } }),
    prisma.contact.count({ where: { status: 'NEW', topic: { startsWith: 'WhatsApp' } } }),
  ]);

  res.json({
    activeConversations,
    totalConversations,
    totalBookings,
    successfulPayments,
    failedPayments,
    abandonedBookings,
    humanHandoffs,
    openSupportTickets,
    provider: process.env.WHATSAPP_PROVIDER || 'msg91',
  });
});

/** GET handoffs — conversations currently waiting for a human. */
const getHandoffs = wrap(async (req, res) => {
  const prisma = getPrisma();
  const rows = await prisma.whatsappSession.findMany({
    where: { humanHandoff: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 50,
  });
  res.json(await attachCustomers(prisma, rows));
});

/**
 * GET conversations — recent WhatsApp chats (not only handoffs).
 *   ?filter=all|active|handoff   (active = last 30 minutes)
 *   ?search=<digits or name>     ?limit=1..200 (default 50)
 */
const getConversations = wrap(async (req, res) => {
  const prisma = getPrisma();
  const filter = String(req.query.filter || 'all');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const search = String(req.query.search || '').trim();

  const where = {};
  if (filter === 'handoff') where.humanHandoff = true;
  if (filter === 'active') where.lastMessageAt = { gte: new Date(Date.now() - 30 * 60 * 1000) };
  if (search) {
    const digits = search.replace(/\D/g, '');
    const users = await prisma.user.findMany({
      where: { name: { contains: search, mode: 'insensitive' } },
      select: { id: true },
      take: 50,
    });
    where.OR = [
      ...(digits ? [{ whatsappNumber: { contains: digits } }] : []),
      ...(users.length ? [{ customerId: { in: users.map((u) => u.id) } }] : []),
    ];
    if (!where.OR.length) return res.json([]);
  }

  const rows = await prisma.whatsappSession.findMany({
    where,
    orderBy: [{ humanHandoff: 'desc' }, { lastMessageAt: 'desc' }],
    take: limit,
  });
  return res.json(await attachCustomers(prisma, rows));
});

/** GET support-tickets — WhatsApp support requests (rows of the website's `contacts` table). */
const getSupportTickets = wrap(async (req, res) => {
  const prisma = getPrisma();
  const status = String(req.query.status || 'NEW').toUpperCase();
  if (status !== 'ALL' && !TICKET_STATUSES.includes(status)) {
    return fail(res, 400, 'VALIDATION_ERROR', `status must be one of ${TICKET_STATUSES.join(', ')} or ALL`);
  }
  const tickets = await prisma.contact.findMany({
    where: { ...(status === 'ALL' ? {} : { status }), topic: { startsWith: 'WhatsApp' } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  // `phone` kept as an alias: the table column is `mobile`.
  return res.json(tickets.map((t) => ({ ...withId(t), phone: t.mobile })));
});

/** PATCH support-tickets/:id — { status } */
const updateSupportTicket = wrap(async (req, res) => {
  const prisma = getPrisma();
  const status = String((req.body && req.body.status) || '').toUpperCase();
  if (!TICKET_STATUSES.includes(status)) {
    return fail(res, 400, 'VALIDATION_ERROR', `status must be one of ${TICKET_STATUSES.join(', ')}`);
  }
  const existing = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'NOT_FOUND', 'Ticket not found');
  const row = await prisma.contact.update({ where: { id: req.params.id }, data: { status } });
  return res.json({ ...withId(row), phone: row.mobile });
});

/** POST handoffs/:sessionId/resolve — staff clears a handoff, returning the bot to MAIN_MENU. */
const resolveHandoff = wrap(async (req, res) => {
  const prisma = getPrisma();
  const row = await prisma.whatsappSession.findUnique({ where: { id: req.params.sessionId } });
  if (!row) return fail(res, 404, 'NOT_FOUND', 'Conversation not found');

  const session = wrapSession(row);
  session.humanHandoff = false;
  session.handoffReason = null;
  session.state = STATES.MAIN_MENU;
  session.resetDraft();
  await session.save();

  return res.json({ ok: true });
});

module.exports = {
  getStats,
  getHandoffs,
  getConversations,
  getSupportTickets,
  updateSupportTicket,
  resolveHandoff,
  TICKET_STATUSES,
};
