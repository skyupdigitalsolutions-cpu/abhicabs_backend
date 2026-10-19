'use strict';

/**
 * src/services/email.service.js
 *
 * Templates and helpers on top of the email provider. The provider knows how to
 * put a message on the wire; this file knows what the message says.
 */

const { getProvider, isConfigured } = require('./providers/email.provider');
const env = require('../config/env');

const BRAND = env.mail.fromName;

/* ------------------------------------------------------------------ *
 * Masking
 * ------------------------------------------------------------------ */

/**
 * a***@gmail.com
 *
 * The client needs to tell the user WHERE the code went, otherwise they stare
 * at an inbox that was never going to receive anything. Returning the full
 * address instead would hand anyone who knows a phone number the email
 * attached to it — the login form would become an address-harvesting tool.
 */
function maskEmail(email) {
  const value = String(email || '');
  const at = value.lastIndexOf('@');
  if (at < 1) return '';

  const local = value.slice(0, at);
  const domain = value.slice(at);

  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 6))}${local.slice(-1)}${domain}`;
}

/* ------------------------------------------------------------------ *
 * Deliverability
 * ------------------------------------------------------------------ */

/**
 * Phone-first signup generates `phone_<number>@placeholder.local` to satisfy
 * UNIQUE(email). It is a database artefact, not an inbox — mailing it produces
 * a hard bounce, and enough hard bounces get the sending domain throttled or
 * suspended by the provider. Every outbound template must filter it out, so the
 * check lives here rather than being re-implemented at each call site.
 */
function isDeliverableEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return false;
  if (value.endsWith('@placeholder.local')) return false;
  // Cheap sanity check; the provider rejects the rest.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/**
 * "₹12,340.00" — Indian digit grouping (lakh/crore), two decimals.
 *
 * Prisma serialises Decimal columns as strings, so everything arriving here is
 * a string far more often than a number. Number() handles both; a value that
 * cannot be parsed returns null so the caller can omit the row entirely rather
 * than print "₹NaN" on a confirmation.
 */
function formatAmount(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "12 Oct 2026, 5:04 pm" in India time. Workers run in UTC on Railway. */
function formatIst(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const TRIP_TYPE_LABEL = {
  ONE_WAY: 'One way',
  ROUND_TRIP: 'Round trip',
  HOURLY: 'Local rental',
  AIRPORT: 'Airport transfer',
};

/* ------------------------------------------------------------------ *
 * OTP template
 * ------------------------------------------------------------------ */

function otpTemplate({ name, code, ttlSeconds }) {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const greeting = name ? `Hi ${name},` : 'Hi,';

  const text = [
    greeting,
    '',
    `Your ${BRAND} login code is ${code}`,
    '',
    `It expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can only be used once.`,
    '',
    'If you did not try to log in, you can ignore this email — nobody can get in',
    'without this code.',
    '',
    `— ${BRAND}`,
  ].join('\n');

  // Table-based and inline-styled on purpose: email clients strip <style>
  // blocks and have no flexbox worth relying on.
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;">
      <tr>
        <td style="padding:32px;">
          <p style="margin:0 0 20px;font-size:15px;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 20px;font-size:15px;">Use this code to sign in to ${escapeHtml(BRAND)}:</p>
          <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;padding:16px;background:#f4f5f7;border-radius:8px;">${escapeHtml(code)}</p>
          <p style="margin:0 0 20px;font-size:14px;color:#555;">
            It expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can only be used once.
          </p>
          <p style="margin:0;font-size:13px;color:#777;">
            If you did not try to log in, you can ignore this email — nobody can get in without this code.
          </p>
        </td>
      </tr>
    </table>
    <p style="max-width:480px;margin:16px auto 0;font-size:12px;color:#999;text-align:center;">${escapeHtml(BRAND)}</p>
  </body>
</html>`;

  return {
    subject: `${code} is your ${BRAND} login code`,
    text,
    html,
  };
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

/**
 * Deliver a login code. Throws if the provider rejects it — the caller needs to
 * know, because an undelivered code leaves the user waiting for an email that
 * is never coming.
 */
async function sendOtpEmail({ to, name, code, ttlSeconds }) {
  const { subject, text, html } = otpTemplate({ name, code, ttlSeconds });
  const result = await getProvider().send({ to, subject, text, html });

  // Never log the code itself; the masked address is enough to trace a
  // "didn't get it" support ticket.
  console.log(`[mail] login code sent to ${maskEmail(to)} (${result.messageId})`);

  return { ...result, to: maskEmail(to) };
}

/* ------------------------------------------------------------------ *
 * Trip start code
 * ------------------------------------------------------------------ */

/**
 * The code the rider reads out to the driver at pickup.
 *
 * Worded very differently from the login code on purpose. A login code is a
 * secret to be typed and never shared; this one is MEANT to be said out loud,
 * to one specific person, at one specific moment. Reusing the "never share
 * this" language would teach the rider to refuse the thing the trip depends on.
 */
async function sendTripStartOtpEmail({ to, name, code, bookingNumber, pickupAt }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const when = pickupAt
    ? new Date(pickupAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const text = [
    greeting,
    '',
    `Your trip start code is ${code}`,
    '',
    `Booking ${bookingNumber}${when ? `, pickup ${when}` : ''}.`,
    '',
    'Give this code to your driver when they arrive. The trip cannot start',
    'without it, so please do not share it before you are in the car.',
    '',
    `— ${BRAND}`,
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:32px;">
        <p style="margin:0 0 20px;font-size:15px;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 20px;font-size:15px;">Give this code to your driver when they arrive:</p>
        <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;padding:16px;background:#f4f5f7;border-radius:8px;">${escapeHtml(code)}</p>
        <p style="margin:0 0 20px;font-size:14px;color:#555;">
          Booking ${escapeHtml(bookingNumber)}${when ? `, pickup ${escapeHtml(when)}` : ''}.
        </p>
        <p style="margin:0;font-size:13px;color:#777;">
          The trip cannot start without it, so please do not share it before you are in the car.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  const result = await getProvider().send({
    to,
    subject: `${code} is your ${BRAND} trip start code`,
    text,
    html,
  });

  console.log(`[mail] trip start code sent to ${maskEmail(to)} for ${bookingNumber}`);
  return { ...result, to: maskEmail(to) };
}

/* ------------------------------------------------------------------ *
 * Password reset
 * ------------------------------------------------------------------ */

/**
 * The reset link.
 *
 * WHY THIS ONE THROWS
 * -------------------
 * Booking confirmations and invoices swallow send failures, because the thing
 * they describe has already happened — the trip is booked, the money has
 * moved, and failing the request would roll back something real over a mail
 * outage. A reset email is the opposite: the email IS the feature. If it does
 * not go out there is nothing else for the user to fall back on, so the caller
 * has to know, and does — it deletes the token it just issued rather than
 * leaving a live credential nobody can use.
 *
 * WHY THE TOKEN IS NEVER IN THE SUBJECT OR A QUERY STRING WE LOG
 * --------------------------------------------------------------
 * It is a bearer credential for 30 minutes. It belongs in the body of one
 * email and in no log line, which is why the console messages below print the
 * masked address and nothing else.
 */
function passwordResetTemplate({ name, resetUrl, ttlSeconds }) {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const greeting = name ? `Hi ${name},` : 'Hi,';

  const text = [
    greeting,
    '',
    `Someone asked to reset the password on your ${BRAND} account.`,
    '',
    'Open this link to choose a new one:',
    resetUrl,
    '',
    `The link works once and expires in ${minutes} minutes.`,
    '',
    'If this was not you, ignore this email. Your password has not changed and',
    'nobody can change it without this link.',
    '',
    `— ${BRAND}`,
  ].join('\n');

  // Both a button and the bare URL: a fair number of clients strip or rewrite
  // anchors, and a user who cannot click still has something to copy.
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:32px;">
        <p style="margin:0 0 8px;font-size:15px;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;font-size:20px;font-weight:700;">Reset your password</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">
          Someone asked to reset the password on your ${escapeHtml(BRAND)} account.
          Choose a new one here:
        </p>
        <p style="margin:0 0 24px;text-align:center;">
          <a href="${escapeHtml(resetUrl)}"
             style="display:inline-block;padding:14px 28px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">
            Set a new password
          </a>
        </p>
        <p style="margin:0 0 24px;font-size:13px;color:#777;line-height:1.5;word-break:break-all;">
          Or paste this into your browser:<br>${escapeHtml(resetUrl)}
        </p>
        <p style="margin:0 0 16px;font-size:14px;color:#555;">
          The link works once and expires in ${minutes} minutes.
        </p>
        <p style="margin:0;font-size:13px;color:#777;line-height:1.5;">
          If this was not you, ignore this email — your password has not changed,
          and nobody can change it without this link.
        </p>
      </td></tr>
    </table>
    <p style="max-width:480px;margin:16px auto 0;font-size:12px;color:#999;text-align:center;">${escapeHtml(BRAND)}</p>
  </body>
</html>`;

  return {
    subject: `Reset your ${BRAND} password`,
    text,
    html,
  };
}

/**
 * Send a reset link. Throws on any failure — see the note above.
 */
async function sendPasswordResetEmail({ to, name, resetUrl, ttlSeconds }) {
  if (!isDeliverableEmail(to)) {
    // A phone-first account's @placeholder.local address. The caller should
    // already have filtered this out; refusing here stops a hard bounce from
    // reaching the sending domain's reputation if it ever slips through.
    throw new Error(`not a deliverable address: ${maskEmail(to)}`);
  }

  if (!resetUrl) {
    throw new Error('no reset URL configured (set APP_WEB_URL)');
  }

  const { subject, text, html } = passwordResetTemplate({ name, resetUrl, ttlSeconds });
  const result = await getProvider().send({ to, subject, text, html });

  console.log(`[mail] password reset link sent to ${maskEmail(to)} (${result.messageId})`);
  return { ...result, to: maskEmail(to) };
}

/* ------------------------------------------------------------------ *
 * Booking confirmation
 * ------------------------------------------------------------------ */

/**
 * "Your booking is confirmed, and here is what it costs."
 *
 * WHY THE AMOUNT IS THE POINT OF THIS EMAIL
 * -----------------------------------------
 * The push notification can only carry a line of text, and the rider dismisses
 * it. The fare was last seen on a quote screen before an admin had confirmed
 * anything, so after confirmation there is no durable record of the number the
 * rider agreed to until the invoice arrives at the END of the trip. This email
 * is that record: total, what has already been paid, and what is still owed.
 *
 * WHY "estimated"
 * ---------------
 * At CONFIRMED there is no finalFare — the trip has not run, so distance-based
 * and allowance components are not settled. Printing the quoted total as if it
 * were final sets up a dispute at the end of an outstation run. The copy says
 * estimated, names the extras that can move it, and the invoice email at
 * COMPLETED carries the real figure.
 *
 * Never throws. A mail provider being down must not fail a notification job,
 * which would have BullMQ retry a push the rider already received.
 */
async function sendBookingConfirmedEmail({ to, name, booking = {} }) {
  if (!isDeliverableEmail(to)) {
    // Phone-first account with a placeholder address. Normal, not an error.
    return { skipped: true, reason: 'NO_EMAIL' };
  }

  try {
    const greeting = name ? `Hi ${name},` : 'Hi,';

    const bookingNumber = booking.bookingNumber ?? '';
    const tripType = TRIP_TYPE_LABEL[booking.tripType] || booking.tripType || null;
    const pickupAt = formatIst(booking.pickupAt);
    const returnAt = formatIst(booking.returnAt);

    // finalFare only exists once the trip is settled; at confirmation it is the
    // frozen quote on estimatedFare that the rider agreed to.
    const isFinal = booking.finalFare != null;
    const total = formatAmount(booking.finalFare ?? booking.estimatedFare);
    const advance = formatAmount(booking.advancePaid);
    const balance = formatAmount(booking.balanceDue);

    // `advancePaid` is 0 on a pay-later booking; a "₹0.00 paid" row is noise.
    const showAdvance = Number(booking.advancePaid ?? 0) > 0;
    const payLater = booking.paymentMode === 'ZERO';

    // fareBasis.discount is written at create time and is NET of the total
    // above — see booking.service. Showing it answers "why is this less than
    // the quote I screenshotted".
    const discount = booking.fareBasis?.discount || null;
    const discountAmount = discount ? formatAmount(discount.amount) : null;

    /* ---------------- plain text ---------------- */

    const rows = [
      ['Booking', bookingNumber],
      tripType ? ['Trip type', tripType] : null,
      pickupAt ? ['Pickup', pickupAt] : null,
      booking.pickupAddress ? ['From', booking.pickupAddress] : null,
      booking.dropAddress ? ['To', booking.dropAddress] : null,
      returnAt ? ['Return', returnAt] : null,
      booking.distanceKm != null ? ['Distance', `${booking.distanceKm} km`] : null,
    ].filter(Boolean);

    const moneyRows = [
      discountAmount ? [`Discount${discount.code ? ` (${discount.code})` : ''}`, `− ${discountAmount}`] : null,
      total ? [isFinal ? 'Total fare' : 'Estimated fare', total] : null,
      showAdvance && advance ? ['Paid in advance', advance] : null,
      balance ? [payLater ? 'Payable to the driver' : 'Balance due', balance] : null,
    ].filter(Boolean);

    const text = [
      greeting,
      '',
      `Your booking ${bookingNumber} is confirmed.`,
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      '',
      ...moneyRows.map(([k, v]) => `${k}: ${v}`),
      '',
      isFinal
        ? ''
        : 'This is the fare quoted at booking. Tolls, parking, state permits and any\nextra distance or hours beyond the booked package are billed at the end of\nthe trip, and your invoice will show the final amount.',
      '',
      'You can see this booking any time in the app.',
      '',
      `— ${BRAND}`,
    ].filter((line) => line !== undefined).join('\n');

    /* ---------------- html ---------------- */

    const detailHtml = rows
      .map(
        ([k, v]) => `<tr>
          <td style="padding:6px 0;font-size:14px;color:#777;vertical-align:top;width:40%;">${escapeHtml(k)}</td>
          <td style="padding:6px 0;font-size:14px;color:#1a1a1a;vertical-align:top;">${escapeHtml(v)}</td>
        </tr>`,
      )
      .join('');

    const moneyHtml = moneyRows
      .map(([k, v], i) => {
        const strong = i === moneyRows.length - 1;
        return `<tr>
          <td style="padding:8px 0;font-size:${strong ? '15' : '14'}px;color:${strong ? '#1a1a1a' : '#777'};font-weight:${strong ? '600' : '400'};">${escapeHtml(k)}</td>
          <td style="padding:8px 0;font-size:${strong ? '16' : '14'}px;color:#1a1a1a;font-weight:${strong ? '700' : '500'};text-align:right;white-space:nowrap;">${escapeHtml(v)}</td>
        </tr>`;
      })
      .join('');

    const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:32px;">
        <p style="margin:0 0 8px;font-size:15px;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;font-size:20px;font-weight:700;">Your booking is confirmed</p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailHtml}</table>

        <div style="height:1px;background:#e9eaee;margin:20px 0;"></div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${moneyHtml}</table>

        ${
          isFinal
            ? ''
            : `<p style="margin:20px 0 0;font-size:13px;color:#777;line-height:1.5;">
                 This is the fare quoted at booking. Tolls, parking, state permits and any extra
                 distance or hours beyond the booked package are billed at the end of the trip —
                 your invoice will show the final amount.
               </p>`
        }
        ${
          payLater
            ? `<p style="margin:12px 0 0;font-size:13px;color:#777;">Please pay the driver at the end of your trip.</p>`
            : ''
        }

        <p style="margin:24px 0 0;font-size:13px;color:#777;">
          You can see this booking any time in the ${escapeHtml(BRAND)} app.
        </p>
      </td></tr>
    </table>
    <p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#999;text-align:center;">${escapeHtml(BRAND)}</p>
  </body>
</html>`;

    const result = await getProvider().send({
      to,
      subject: total
        ? `Booking ${bookingNumber} confirmed — ${total}`
        : `Booking ${bookingNumber} confirmed`,
      text,
      html,
    });

    console.log(`[mail] booking ${bookingNumber} confirmation sent to ${maskEmail(to)} (${result.messageId})`);
    return { ...result, to: maskEmail(to) };
  } catch (err) {
    console.error('[mail] booking confirmation send failed:', err.message);
    return { failed: true, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Invoice
 * ------------------------------------------------------------------ */

/**
 * Email a completed trip's invoice.
 *
 * THE INVOICE IS THE EMAIL BODY, not an attachment.
 *
 * A PDF attachment is the obvious choice and the worse one: many clients block
 * attachments from unknown senders by default, most mobile clients will not
 * preview one inline, and generating it would mean running a headless browser
 * on the API container. Inline HTML renders in the inbox, on a phone, without a
 * download — and the app still produces a real PDF locally from the same markup
 * when the rider asks to download it.
 *
 * Never throws. This is called after a payment has already settled and a trip
 * has already completed; a mail provider being down must not roll back money or
 * fail a request. A failure is logged and the rider can still download the
 * invoice in the app.
 */
async function sendInvoiceEmail({ to, name, invoice, booking, customer, seller }) {
  // Was `if (!to)`. A phone-first account does have an address — a generated
  // @placeholder.local one — so the old check passed it straight to the
  // provider and every such invoice hard-bounced.
  if (!isDeliverableEmail(to)) {
    return { skipped: true, reason: 'NO_EMAIL' };
  }

  try {
    const { buildInvoiceHtml, buildInvoiceText } = require('./invoiceTemplate');

    const html = buildInvoiceHtml({ invoice, booking, customer, seller });
    const text = buildInvoiceText({ invoice, booking });

    const isTax = invoice?.type === 'TAX';
    const subject = `${isTax ? 'Tax invoice' : 'Invoice'} ${invoice?.invoiceNumber ?? ''} — ${BRAND}`.trim();

    const result = await getProvider().send({ to, subject, text, html });

    console.log(`[mail] invoice ${invoice?.invoiceNumber} sent to ${maskEmail(to)} (${result.messageId})`);
    return { ...result, to: maskEmail(to) };
  } catch (err) {
    console.error('[mail] invoice send failed:', err.message);
    return { failed: true, error: err.message };
  }
}

module.exports = {
  sendOtpEmail,
  sendTripStartOtpEmail,
  sendPasswordResetEmail,
  sendBookingConfirmedEmail,
  sendInvoiceEmail,
  maskEmail,
  isDeliverableEmail,
  formatAmount,
  isConfigured,
};