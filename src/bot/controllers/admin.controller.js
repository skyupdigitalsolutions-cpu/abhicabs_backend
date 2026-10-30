const { getPrisma } = require('../config/db');
const { wrapSession } = require('../conversation/sessionRecord');
const { STATES } = require('../conversation/states');

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

/** GET /admin/stats — high-level monitoring numbers (spec section 50). */
async function getStats(req, res) {
  const prisma = getPrisma();
  const [
    activeConversations,
    totalConversations,
    totalBookings,
    successfulPayments,
    failedPayments,
    abandonedBookings,
    humanHandoffs,
  ] = await Promise.all([
    prisma.whatsappSession.count({ where: { lastMessageAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } } }),
    prisma.whatsappSession.count(),
    prisma.booking.count({ where: { meta: { path: ['source'], equals: 'whatsapp-bot' } } }),
    prisma.payment.count({ where: { status: 'CAPTURED' } }),
    prisma.payment.count({ where: { status: 'FAILED' } }),
    prisma.whatsappAbandonedBooking.count({ where: { recovered: false } }),
    prisma.whatsappSession.count({ where: { humanHandoff: true } }),
  ]);

  res.json({
    activeConversations,
    totalConversations,
    totalBookings,
    successfulPayments,
    failedPayments,
    abandonedBookings,
    humanHandoffs,
  });
}

/** GET /admin/handoffs — conversations currently waiting for a human. */
async function getHandoffs(req, res) {
  const prisma = getPrisma();
  const rows = await prisma.whatsappSession.findMany({
    where: { humanHandoff: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 50,
  });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.customerId).filter(Boolean) } }, select: { id: true, name: true, phone: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  res.json(rows.map((r) => ({ ...withId(r), customer: byId.get(r.customerId) || null })));
}

/** GET /bot-admin/support-tickets — WhatsApp support requests (rows of the website's `contacts` table). */
async function getSupportTickets(req, res) {
  const prisma = getPrisma();
  const status = req.query.status || 'NEW';
  const tickets = await prisma.contact.findMany({
    where: { status, topic: { startsWith: 'WhatsApp' } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(tickets.map(withId));
}

/** POST /admin/handoffs/:sessionId/resolve — staff clears a handoff, returning the bot to MAIN_MENU. */
async function resolveHandoff(req, res) {
  const prisma = getPrisma();
  const row = await prisma.whatsappSession.findUnique({ where: { id: req.params.sessionId } });
  if (!row) return res.status(404).json({ error: 'Session not found' });

  const session = wrapSession(row);
  session.humanHandoff = false;
  session.handoffReason = null;
  session.state = STATES.MAIN_MENU;
  session.resetDraft();
  await session.save();

  res.json({ ok: true });
}

module.exports = { getStats, getHandoffs, getSupportTickets, resolveHandoff };
