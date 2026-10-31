const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { createSupportTicket } = require('../../adapters/supportAdapter');
const { toNumbered, rememberOptions } = require('../numberedMenu');

const CATEGORIES = [
  { id: 'SUP_BOOKING', value: 'BOOKING_ISSUE', label: 'Booking Issue', number: 1 },
  { id: 'SUP_PAYMENT', value: 'PAYMENT_ISSUE', label: 'Payment Issue', number: 2 },
  { id: 'SUP_DRIVER', value: 'DRIVER_ISSUE', label: 'Driver Issue', number: 3 },
  { id: 'SUP_PICKUP', value: 'PICKUP_ISSUE', label: 'Pickup Issue', number: 4 },
  { id: 'SUP_CANCELLATION', value: 'CANCELLATION_ISSUE', label: 'Cancellation Issue', number: 5 },
  { id: 'SUP_GENERAL', value: 'GENERAL_ENQUIRY', label: 'General Enquiry', number: 6 },
  { id: 'SUP_HUMAN', value: 'HUMAN_REQUEST', label: 'Talk to Human', number: 7 },
];

async function promptSupportCategory(ctx) {
  const { rows, map } = toNumbered(CATEGORIES);
  await ctx.send.list('support_menu_title', 'support_menu_title', [{ title: 'Support', rows }]);
  await rememberOptions(ctx.session, map);
}

async function handleSupportCategory(ctx) {
  const { message, session } = ctx;
  const category = CATEGORIES.find((c) => c.id === message.interactiveId);

  if (!category) {
    await promptSupportCategory(ctx);
    return;
  }

  if (category.value === 'HUMAN_REQUEST') {
    const { escalateToHuman } = require('./handoff.handler');
    await escalateToHuman(ctx, 'CUSTOMER_REQUESTED_HUMAN', { category: category.value });
    return;
  }

  session.draft._supportCategory = category.value;
  await transition(session, STATES.SUPPORT_MESSAGE);
  await session.save();
  await ctx.send.raw('Please describe the issue in a few words.');
}

async function handleSupportMessage(ctx) {
  const { message, session, customer } = ctx;
  const text = (message.text || '').trim();

  if (!text) {
    await ctx.send.raw('Please describe the issue in a few words.');
    return;
  }

  await createSupportTicket({
    customerId: customer._id,
    whatsappNumber: session.whatsappNumber,
    name: customer.name,
    bookingId: session.activeBookingId,
    category: session.draft._supportCategory,
    message: text,
    conversationId: String(session._id),
  });

  await ctx.send.text('support_ticket_created');
  const { renderMainMenu } = require('./mainMenu.handler');
  await transition(session, STATES.MAIN_MENU);
  await renderMainMenu(ctx);
}

module.exports = { promptSupportCategory, handleSupportCategory, handleSupportMessage };
