const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { createSupportTicket } = require('../../adapters/supportAdapter');

/**
 * Flips the session into HUMAN_HANDOFF. Once set, the webhook
 * controller must stop sending automated replies for this number
 * (spec section 29) until a staff member (via the admin panel/API)
 * clears humanHandoff — this file only sets the flag and notifies the
 * customer; it does not attempt to keep chatting.
 */
async function escalateToHuman(ctx, reason, extra = {}) {
  const { session, customer } = ctx;

  session.humanHandoff = true;
  session.handoffReason = reason;
  await transition(session, STATES.HUMAN_HANDOFF);

  await createSupportTicket({
    customerId: customer._id,
    whatsappNumber: session.whatsappNumber,
    name: customer.name,
    bookingId: extra.bookingId || session.activeBookingId,
    category: extra.category || 'HUMAN_REQUEST',
    message: extra.message || `Escalated automatically: ${reason}`,
    conversationId: String(session._id),
  });

  await ctx.send.text('human_handoff_message');
}

module.exports = { escalateToHuman };
