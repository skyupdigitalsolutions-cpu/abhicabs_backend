'use strict';

/**
 * src/services/whatsapp.service.js
 *
 * Getting a payment link into a customer's WhatsApp.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A NOTIFICATION PROVIDER
 * ---------------------------------------------------------------------------
 * notify.provider.js is the queue-backed channel for system messages the
 * customer did not ask for: trip confirmations, driver assigned, cancellations.
 * It is fire-and-forget by design, and MSG91's side of it is still waiting on
 * DLT approval.
 *
 * A payment link is a different act. An admin is standing there, has decided
 * to ask a specific person for a specific amount, and needs to know in the
 * response whether it went — not eventually, in a worker log. So this is a
 * synchronous call made from the request, and when it cannot send it says so
 * and hands back something the admin can use by hand.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PATHS
 * ---------------------------------------------------------------------------
 *   DEEP LINK  (always returned)
 *     https://wa.me/91XXXXXXXXXX?text=<urlencoded message>
 *     The admin taps it, WhatsApp opens on the customer's chat with the
 *     message already composed, they press send. It needs no API, no template
 *     approval and no business number, and the customer receives it from a
 *     human they have spoken to.
 *
 *   BOT SEND  (only when WHATSAPP_BOT_URL is configured)
 *     POSTs to our own WhatsApp bot, which sends it without the admin doing
 *     anything. Authenticated with the SAME shared secret the bot already uses
 *     to call us (WHATSAPP_BOT_SERVICE_KEY) — one secret, rotated in one place,
 *     rather than a second credential that will drift out of sync with it.
 *
 * The caller gets both: `whatsappUrl` always, and `sent: true` when the bot
 * actually delivered it. Nothing throws when the bot is down — a failed send
 * must not fail the payment link that was already created at the gateway, and
 * the deep link is a complete answer on its own.
 */

const env = require('../config/env');

/**
 * Any Indian mobile, however it was typed, as digits with country code —
 * "+91 98765 43210", "09876543210", "9876543210" -> "919876543210".
 *
 * Deliberately the same last-10-digits rule as sms.service.indianMobile, so a
 * number that can receive an OTP can receive a payment link. Returns null when
 * what remains is not a valid Indian mobile, and every caller treats null as
 * "no WhatsApp for this one" rather than guessing.
 */
function waNumber(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `${env.whatsapp.countryCode}${digits}`;
}

/** "9876543210" -> "+91 98•••••210". Used in audit entries and logs. */
function maskPhone(raw) {
  const n = waNumber(raw);
  if (!n) return null;
  const last10 = n.slice(-10);
  return `+${env.whatsapp.countryCode} ${last10.slice(0, 2)}${'•'.repeat(5)}${last10.slice(7)}`;
}

/** dd Mmm, h:mm am/pm in IST — the only timezone any of these customers is in. */
function istMoment(date) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(date));
}

/**
 * The message body.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN IT AND WHY
 * ---------------------------------------------------------------------------
 * A payment link arriving on WhatsApp looks exactly like the fraud that has
 * trained everyone in India to ignore payment links on WhatsApp. The three
 * things that separate a real one from that are the amount, what it is for,
 * and the name of the business — so all three are in the body, before the URL,
 * where they are visible in the notification preview.
 *
 * The expiry is included for the same reason it exists: a customer who reads
 * the message tomorrow and taps a dead link calls support. Telling them when
 * it dies is cheaper than the call.
 *
 * A QR gets different wording. The URL is an IMAGE, not a page — "complete
 * your payment here" pointing at a PNG is the kind of thing that makes a
 * careful person stop, which is precisely the wrong instinct to trigger.
 */
function buildMessage({
  payerName,
  amount,
  description,
  shareUrl,
  expiresAt,
  isQr = false,
  bookingNumber = null,
}) {
  const business = env.whatsapp.businessName;
  const lines = [];

  lines.push(payerName ? `Hello ${payerName},` : 'Hello,');
  lines.push('');

  const what = description || (bookingNumber ? `your trip ${bookingNumber}` : `your ${business} booking`);
  lines.push(
    isQr
      ? `Please scan the QR below to pay ₹${amount} towards ${what}.`
      : `Here is your secure ${business} payment link for ₹${amount} towards ${what}.`,
  );
  lines.push('');
  lines.push(shareUrl);

  if (expiresAt) {
    lines.push('');
    lines.push(
      isQr
        ? `This QR is valid until ${istMoment(expiresAt)}.`
        : `This link is valid until ${istMoment(expiresAt)}.`,
    );
  }

  lines.push('');
  lines.push(`— ${business}`);

  return lines.join('\n');
}

/**
 * The tap-to-send URL.
 *
 * wa.me rather than api.whatsapp.com: it is the documented universal link and
 * it resolves correctly from a desktop browser (WhatsApp Web) and a phone
 * alike, which matters because admins run this panel on both.
 */
function buildDeepLink(phone, message) {
  const to = waNumber(phone);
  if (!to) return null;
  return `https://wa.me/${to}?text=${encodeURIComponent(message)}`;
}

/** Is programmatic sending configured at all? */
function canSend() {
  return Boolean(env.whatsapp.botUrl && env.services.whatsappBotKey);
}

/**
 * Hands the message to our bot.
 *
 * NEVER THROWS. The payment link is already live at Razorpay by the time this
 * runs, and a bot that is down or slow must not turn a successful collection
 * into a 500 the admin reads as "it did not work" — they would click again and
 * the customer would get two links. The failure is reported in the return
 * value and the deep link covers the gap.
 */
async function sendViaBot({ phone, message }) {
  const to = waNumber(phone);
  if (!to) return { sent: false, reason: 'INVALID_PHONE' };
  if (!canSend()) return { sent: false, reason: 'BOT_NOT_CONFIGURED' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.whatsapp.timeoutMs);

  try {
    const res = await fetch(`${env.whatsapp.botUrl}${env.whatsapp.sendPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': env.services.whatsappBotKey,
      },
      body: JSON.stringify({ to, message }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[whatsapp] bot send failed (${res.status}): ${detail.slice(0, 300)}`);
      return { sent: false, reason: `BOT_HTTP_${res.status}` };
    }

    const body = await res.json().catch(() => ({}));
    return { sent: true, messageId: body.messageId || body.id || null };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'BOT_TIMEOUT' : 'BOT_UNREACHABLE';
    console.error(`[whatsapp] bot send ${reason}: ${err.message}`);
    return { sent: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call for the whole share: compose, try to send, always return a link.
 *
 * @returns {{ phone:string|null, message:string, whatsappUrl:string|null,
 *             sent:boolean, reason?:string, messageId?:string|null }}
 */
async function sharePaymentLink({
  phone,
  payerName,
  amount,
  description,
  shareUrl,
  expiresAt,
  isQr = false,
  bookingNumber = null,
  send = false,
}) {
  const message = buildMessage({
    payerName, amount, description, shareUrl, expiresAt, isQr, bookingNumber,
  });
  const whatsappUrl = buildDeepLink(phone, message);

  if (!whatsappUrl) {
    return { phone: null, message, whatsappUrl: null, sent: false, reason: 'INVALID_PHONE' };
  }
  if (!send) {
    return { phone: waNumber(phone), message, whatsappUrl, sent: false, reason: 'NOT_REQUESTED' };
  }

  const result = await sendViaBot({ phone, message });
  return { phone: waNumber(phone), message, whatsappUrl, ...result };
}

module.exports = {
  waNumber,
  maskPhone,
  canSend,
  buildMessage,
  buildDeepLink,
  sendViaBot,
  sharePaymentLink,
};