const { INTENTS, ruleBasedIntent } = require('../../integrations/ai/intentExtractor');
const { STATES } = require('../states');
const { transition } = require('../sessionManager');

/**
 * Used both at MAIN_MENU (customer typed instead of tapping a button)
 * and mid-flow (spec section 40 — "interruption handling"). Each
 * branch hands off to the right handler/state rather than trying to
 * resolve everything inline here.
 */
async function routeFromIntent(ctx) {
  const { message, session } = ctx;
  const text = message.text || message.interactiveTitle || '';
  const intent = ruleBasedIntent(text);

  switch (intent) {
    case INTENTS.GREETING: {
      const { renderMainMenu } = require('./mainMenu.handler');
      await renderMainMenu(ctx);
      return;
    }
    case INTENTS.BOOK_CAB:
    case INTENTS.FARE_ENQUIRY: {
      // Fares are shown in the Cab Type step, so a fare question simply starts a booking.
      const { startBooking } = require('./booking.handler');
      await startBooking(ctx);
      return;
    }
    case INTENTS.MY_BOOKINGS: {
      const { showMyBookings } = require('./myBookings.handler');
      await transition(session, STATES.MY_BOOKINGS);
      await showMyBookings(ctx);
      return;
    }
    case INTENTS.TRACK_BOOKING: {
      const { promptBookingForTracking } = require('./tracking.handler');
      await promptBookingForTracking(ctx);
      return;
    }
    case INTENTS.CANCEL_BOOKING: {
      const { promptBookingForCancellation } = require('./cancellation.handler');
      await promptBookingForCancellation(ctx);
      return;
    }
    case INTENTS.INVOICE_REQUEST: {
      const { promptBookingForInvoice } = require('./myBookings.handler');
      await promptBookingForInvoice(ctx);
      return;
    }
    case INTENTS.PAYMENT_STATUS_QUERY: {
      const { handlePaymentStatusQuery } = require('./payment.handler');
      await handlePaymentStatusQuery(ctx);
      return;
    }
    case INTENTS.SUPPORT_REQUEST: {
      const { showHelp } = require('./mainMenu.handler');
      await showHelp(ctx);
      return;
    }
    case INTENTS.HUMAN_REQUEST: {
      const { escalateToHuman } = require('./handoff.handler');
      await escalateToHuman(ctx, 'CUSTOMER_REQUESTED_HUMAN');
      return;
    }
    default: {
      const { renderMainMenu } = require('./mainMenu.handler');
      if (/^(menu|main menu|home)$/i.test(text.trim())) {
        // "menu" works from any step: drop the half-finished booking and show the services.
        session.resetDraft();
        await transition(session, STATES.MAIN_MENU);
        await renderMainMenu(ctx);
        return;
      }
      await ctx.send.text('didnt_understand');
      await renderMainMenu(ctx);
    }
  }
}

module.exports = { routeFromIntent };
