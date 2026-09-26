'use strict';

/**
 * src/services/sms.service.js
 *
 * SMS through MSG91's OTP API (control.msg91.com/api/v5/otp).
 *
 * ---------------------------------------------------------------------------
 * WE GENERATE AND VERIFY THE CODE — MSG91 ONLY DELIVERS IT
 * ---------------------------------------------------------------------------
 * MSG91 can mint and verify codes itself. We pass our own via `otp=` instead,
 * so the security properties stay where they are already built and tested:
 * otp.service's hashed Redis storage, attempt counter, resend cooldown and
 * daily cap. Swapping
 * SMS providers later changes this file and nothing else.
 *
 * ---------------------------------------------------------------------------
 * DLT
 * ---------------------------------------------------------------------------
 * Every commercial SMS in India must match a DLT-registered template, word for
 * word. The template ids here are MSG91's ids for templates already approved
 * on DLT and linked in the MSG91 panel; the text lives THERE, not in code, and
 * must contain the ##OTP## variable. An unapproved or mismatched template is
 * the usual reason a correctly-formed request "succeeds" and nothing arrives.
 *
 * ---------------------------------------------------------------------------
 * A 200 IS NOT SUCCESS
 * ---------------------------------------------------------------------------
 * MSG91 answers most failures — bad key, bad template, invalid number — with
 * HTTP 200 and { "type": "error" } in the body. Checking only the status code
 * would report "sent" for messages that never left. The body's `type` decides.
 */

const env = require('../config/env');

const OTP_API = 'https://control.msg91.com/api/v5/otp';

/** Which templates are usable. */
const TEMPLATES = {
  LOGIN: () => env.msg91.templateId,
  // The trip start code is NOT sent by SMS — it is shown in the rider's app
  // only (tripOtp.issue). Add a kind here if another SMS is ever needed.
};

/**
 * The env vars still missing for an SMS kind — [] when it is ready. Used to
 * say exactly what is wrong in the log, instead of silently skipping SMS.
 */
function missingConfig(kind = 'LOGIN') {
  const missing = [];
  if (!env.msg91.authKey) missing.push('MSG91_AUTH_KEY');
  if (kind === 'LOGIN' && !env.msg91.templateId) missing.push('MSG91_OTP_TEMPLATE_ID');
  return missing;
}

/** True when an SMS of this kind can actually be sent. */
function isConfigured(kind = 'LOGIN') {
  const template = TEMPLATES[kind] ? TEMPLATES[kind]() : '';
  return Boolean(env.msg91.authKey && template);
}

/**
 * Any Indian mobile, however it was typed or stored, as its 10 digits —
 * "+91 98765 43210", "09876543210", "919876543210" -> "9876543210".
 * Null when what remains is not a valid Indian mobile (6-9 then nine digits).
 */
function indianMobile(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** "9876543210" -> "+91 98•••••210". Never log or return a full number. */
function maskPhone(raw) {
  const m = indianMobile(raw);
  if (!m) return null;
  return `+${env.msg91.countryCode} ${m.slice(0, 2)}${'•'.repeat(5)}${m.slice(7)}`;
}

/**
 * Send one code by SMS.
 *
 * @param {object} p
 * @param {'LOGIN'} p.kind              selects the DLT template
 * @param {string} p.phone               any format; normalised here
 * @param {string} p.code                the code WE generated
 * @param {number} [p.expiryMinutes]     shown/used by MSG91; we enforce our own
 * @param {object} [p.vars]              extra template variables, if the
 *                                       approved text has any besides ##OTP##
 * @returns {Promise<{ to: string, requestId: string|null }>}
 * @throws on any failure — callers decide whether that is fatal
 */
async function sendOtp({ kind = 'LOGIN', phone, code, expiryMinutes, vars } = {}) {
  if (!isConfigured(kind)) {
    throw new Error(`MSG91 ${kind} SMS is not configured`);
  }
  const mobile = indianMobile(phone);
  if (!mobile) throw new Error('Not a valid Indian mobile number');

  const params = new URLSearchParams({
    template_id: TEMPLATES[kind](),
    mobile: `${env.msg91.countryCode}${mobile}`,
    otp: String(code),
  });
  if (expiryMinutes) params.set('otp_expiry', String(Math.max(1, Math.round(expiryMinutes))));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.msg91.timeoutMs);

  let res;
  let body;
  try {
    res = await fetch(`${OTP_API}?${params.toString()}`, {
      method: 'POST',
      headers: {
        // In a header, not the query string: a URL ends up in proxy and
        // access logs, and this key can send SMS billed to the account.
        authkey: env.msg91.authKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(vars || {}),
      signal: controller.signal,
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    throw new Error(
      err.name === 'AbortError' ? `MSG91 timed out after ${env.msg91.timeoutMs} ms` : `MSG91 unreachable: ${err.message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || body.type !== 'success') {
    // body.message is MSG91's reason ("Invalid authkey", "Template not
    // approved", ...) — the single most useful line when SMS stops arriving.
    throw new Error(`MSG91 rejected the SMS (HTTP ${res.status}): ${body.message || JSON.stringify(body)}`);
  }

  // Logged on SUCCESS too. "Accepted" here only means MSG91 queued it; the
  // operator can still drop it afterwards (a DLT template or sender-id
  // mismatch is the usual reason), and that failure never comes back to this
  // server. The request_id is what to search for in MSG91 -> Reports to see
  // what actually happened to the message.
  console.log(
    `[sms] MSG91 accepted ${kind} SMS to ${maskPhone(mobile)} ` +
      `(request_id ${body.request_id || 'none returned'})`,
  );

  return { to: maskPhone(mobile), requestId: body.request_id || null, raw: body };
}

module.exports = { sendOtp, isConfigured, missingConfig, indianMobile, maskPhone };