const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { callTool } = require('../../integrations/ai/tools');
const { logger } = require('../../config/logger');
const env = require('../../config/env');
const { toNumbered, rememberOptions } = require('../numberedMenu');

function cannotCancelText() {
  return `This booking cannot be cancelled here any more (the trip may already be under way).${env.SUPPORT_PHONE ? ` Please call us on ${env.SUPPORT_PHONE}.` : ' Please contact our support team.'}`;
}

async function promptBookingForCancellation(ctx) {
  const { session } = ctx;
  const bookingId = session.activeBookingId;

  if (!bookingId) {
    const { showMyBookings } = require('./myBookings.handler');
    await showMyBookings(ctx);
    return;
  }

  let actions;
  try {
    actions = await callTool('getAvailableActions', bookingId);
  } catch (err) {
    logger.error({ err: err.message }, '[cancellation] actions lookup failed');
    await ctx.send.text('generic_error');
    return;
  }

  if (!actions.includes('CANCEL')) {
    await ctx.send.text('modification_unsupported');
    return;
  }

  let quote;
  try {
    quote = await callTool('getCancellationQuote', bookingId);
  } catch (err) {
    logger.error({ err: err.message }, '[cancellation] quote failed');
    if (err.message === 'BOOKING_NOT_CANCELLABLE') {
      await ctx.send.raw(cannotCancelText());
      return;
    }
    await ctx.send.text('generic_error');
    return;
  }

  session.draft._cancellationQuote = quote;
  await transition(session, STATES.CANCELLATION_REASON);
  await session.save();

  await ctx.send.raw(
    `${t(ctx.language, 'cancellation_summary_title')}\n\n` +
      `Cancellation Fee: ₹${quote.fee}\n` +
      `Estimated Refund: ₹${quote.refundAmount}\n\n` +
      `${t(ctx.language, 'ask_cancellation_reason')}`
  );
}

async function handleCancellationReason(ctx) {
  const { message, session } = ctx;
  const reason = (message.text || message.interactiveTitle || '').trim();

  if (!reason) {
    await ctx.send.text('ask_cancellation_reason');
    return;
  }

  session.draft._cancellationReason = reason;
  await transition(session, STATES.CANCELLATION_CONFIRMATION);
  await session.save();

  const quote = session.draft._cancellationQuote;
  const buttons = [
    { id: 'CANCEL_CONFIRM', number: 1, label: t(ctx.language, 'confirm_cancellation'), maxTitleLength: 20 },
    { id: 'CANCEL_KEEP', number: 2, label: t(ctx.language, 'keep_booking'), maxTitleLength: 20 },
  ];
  const { rows, map } = toNumbered(buttons);

  await ctx.send.buttonsRaw(
    `Are you sure you want to cancel?\n\nFee: ₹${quote.fee}\nRefund: ₹${quote.refundAmount}`,
    rows.map((r) => ({ id: r.id, title: r.title }))
  );
  await rememberOptions(session, map);
}

async function handleCancellationConfirmation(ctx) {
  const { message, session } = ctx;

  if (message.interactiveId !== 'CANCEL_CONFIRM') {
    await ctx.send.text('generic_error'); // "kept" — fall through to menu
    const { renderMainMenu } = require('./mainMenu.handler');
    await transition(session, STATES.MAIN_MENU);
    await renderMainMenu(ctx);
    return;
  }

  const quote = session.draft._cancellationQuote;
  const reason = session.draft._cancellationReason;

  let result;
  try {
    result = await callTool('cancelBooking', session.activeBookingId, {
      reason,
      confirmedFee: quote.fee,
      confirmedRefund: quote.refundAmount,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[cancellation] cancel failed');
    if (err.message === 'BOOKING_NOT_CANCELLABLE') {
      await ctx.send.raw(cannotCancelText());
    } else {
      await ctx.send.text('generic_error');
    }
    return;
  }

  // When the website cancelled it, say the fee and refund it actually applied (they can differ from the quote by a few minutes).
  const c = result && result.cancellation;
  if (c && c.source === 'website') {
    await ctx.send.raw(`${t(ctx.language, 'booking_cancelled')}\n\nCancellation fee: ₹${c.fee}\nRefund: ₹${c.refundAmount}`);
  } else {
    await ctx.send.text('booking_cancelled');
  }
  const { renderMainMenu } = require('./mainMenu.handler');
  await transition(session, STATES.MAIN_MENU);
  await renderMainMenu(ctx);
}

module.exports = {
  promptBookingForCancellation,
  handleCancellationReason,
  handleCancellationConfirmation,
};
