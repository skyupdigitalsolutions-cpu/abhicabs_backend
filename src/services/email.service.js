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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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
  if (!to) {
    // A phone-first signup has a placeholder address. Nothing to do, and not
    // an error — it is the normal state for a large share of riders.
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
  sendInvoiceEmail,
  maskEmail,
  isConfigured,
};