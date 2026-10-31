const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const env = require('../../config/env');
const { makeSender } = require('../outbound');
const { toNumbered, rememberOptions } = require('../numberedMenu');

// "Select Service": the four options customers see.
const MENU_ITEMS = [
  { id: 'MENU_BOOK_CAB', number: 1, titleKey: 'menu_book_cab' },
  { id: 'MENU_MY_BOOKING', number: 2, titleKey: 'menu_my_booking' },
  { id: 'MENU_HELP', number: 3, titleKey: 'menu_help' },
  { id: 'MENU_CONTACT', number: 4, titleKey: 'menu_contact' },
];

async function renderMainMenu(ctx) {
  const send = ctx.send || makeSender(ctx.session.whatsappNumber, ctx.language);
  const items = MENU_ITEMS.map((m) => ({ id: m.id, number: m.number, label: t(ctx.language, m.titleKey) }));
  const { rows, map } = toNumbered(items);

  await send.listRaw(
    t(ctx.language, 'main_menu_greeting'),
    t(ctx.language, 'btn_select_service'),
    [{ title: 'Services', rows }]
  );
  await rememberOptions(ctx.session, map);
}

/** Help: how booking works, then back to the menu. */
async function showHelp(ctx) {
  await transition(ctx.session, STATES.MAIN_MENU);
  await ctx.send.text('help_text');
  await renderMainMenu(ctx);
}

/** Contact Us: phone number from SUPPORT_PHONE, then back to the menu. */
async function showContact(ctx) {
  await transition(ctx.session, STATES.MAIN_MENU);
  await ctx.send.text('contact_text', { phone: env.SUPPORT_PHONE });
  await renderMainMenu(ctx);
}

async function handleMainMenu(ctx) {
  const { message, session } = ctx;
  const id = message.interactiveId;

  const routes = {
    MENU_BOOK_CAB: async () => {
      const { startBooking } = require('./booking.handler');
      await startBooking(ctx);
    },
    MENU_MY_BOOKING: async () => {
      const { showMyBookings } = require('./myBookings.handler');
      await transition(session, STATES.MY_BOOKINGS);
      await showMyBookings(ctx);
    },
    MENU_HELP: () => showHelp(ctx),
    MENU_CONTACT: () => showContact(ctx),

    // Not shown in the menu any more, but still reachable from buttons in older
    // messages (for example after a booking is confirmed) and from typed requests.
    MENU_FARE_ESTIMATE: async () => {
      const { startBooking } = require('./booking.handler');
      await startBooking(ctx);
    },
    MENU_TRACK_BOOKING: async () => {
      const { promptBookingForTracking } = require('./tracking.handler');
      await promptBookingForTracking(ctx);
    },
    MENU_CANCEL_BOOKING: async () => {
      const { promptBookingForCancellation } = require('./cancellation.handler');
      await promptBookingForCancellation(ctx);
    },
    MENU_INVOICE: async () => {
      const { promptBookingForInvoice } = require('./myBookings.handler');
      await promptBookingForInvoice(ctx);
    },
    MENU_SUPPORT: () => showContact(ctx),
    MENU_CHANGE_LANGUAGE: () => renderMainMenu(ctx),
  };

  if (id && routes[id]) {
    await routes[id]();
    return;
  }

  // Typed instead of tapped.
  const typed = (message.text || '').trim();
  if (/\b(contact|call us|phone number|helpline)\b/i.test(typed)) {
    await showContact(ctx);
    return;
  }

  // Free text fallback — let NLU intent decide.
  await require('./nluRouter').routeFromIntent(ctx);
}

module.exports = { renderMainMenu, handleMainMenu, showHelp, showContact, MENU_ITEMS };
