'use strict';

/**
 * src/services/providers/email.provider.js
 *
 * Email delivery behind an interface, same shape as the notify / payment /
 * maps providers: pick the implementation from env, fall back to a harmless
 * console mock when credentials are missing so a misconfigured box degrades
 * instead of failing to boot.
 *
 * Contract:
 *   send({ to, subject, text, html }) -> { messageId, channel }
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO REAL PROVIDERS
 * ---------------------------------------------------------------------------
 * 'smtp' is the classic path and works fine locally. It does NOT work on
 * Railway's Free/Trial/Hobby plans, which block outbound ports 25/465/587/2525
 * at the network level — nodemailer then hangs until timeoutMs and every OTP
 * fails with a connection timeout, which looks like a credentials problem but
 * is not. 'brevo' talks to api.brevo.com over ordinary HTTPS on 443 and is
 * unaffected. Both satisfy the same contract, so nothing upstream changes.
 *
 * ---------------------------------------------------------------------------
 * WHY NODEMAILER IS REQUIRED LAZILY
 * ---------------------------------------------------------------------------
 * The require() sits inside the factory, not at the top of the file. If the
 * dependency has not been installed yet (fresh clone, forgotten `npm i`) the
 * app still starts and OTPs still print to the console — it just logs a
 * warning. A missing mailer should not take the whole API down.
 */

const env = require('../../config/env');

/* ------------------------------------------------------------------ *
 * Console fallback
 * ------------------------------------------------------------------ */

const consoleProvider = {
  name: 'console',
  configured: false,
  async send({ to, subject, text }) {
    const messageId = `mail_console_${Math.random().toString(36).slice(2, 11)}`;
    console.log(`[mail:console] -> ${to} | ${subject}\n${text}\n(${messageId})`);
    return { messageId, channel: 'console' };
  },
  async verify() {
    return false;
  },
};

/* ------------------------------------------------------------------ *
 * SMTP
 * ------------------------------------------------------------------ */

function buildSmtp() {
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');

  const transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    // Port 465 speaks TLS from the first byte; 587 starts plaintext and
    // upgrades via STARTTLS. Getting this backwards is the single most common
    // cause of a hung connection, so it is derived from the port unless the
    // operator overrides it explicitly.
    secure: env.mail.secure,
    auth: { user: env.mail.user, pass: env.mail.pass },
    tls: { rejectUnauthorized: env.mail.tlsRejectUnauthorized },
    // A mail server that stops responding must not hold an HTTP request open.
    connectionTimeout: env.mail.timeoutMs,
    greetingTimeout: env.mail.timeoutMs,
    socketTimeout: env.mail.timeoutMs,
    // One pooled connection is plenty at OTP volume and avoids a fresh TLS
    // handshake on every login.
    pool: true,
    maxConnections: 2,
  });

  return {
    name: 'smtp',
    configured: true,
    async send({ to, subject, text, html }) {
      const info = await transporter.sendMail({
        from: env.mail.from,
        to,
        subject,
        text,
        html,
        ...(env.mail.replyTo ? { replyTo: env.mail.replyTo } : {}),
      });
      return { messageId: info.messageId, channel: 'email' };
    },
    /** Optional health check — handy from a script, not called at boot. */
    async verify() {
      await transporter.verify();
      return true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Brevo (HTTPS)
 * ------------------------------------------------------------------ */

/**
 * Brevo wants the sender as a structured object, but env.mail.from is an
 * RFC-5322 string ("AbhiCabs <abhicabs2026@gmail.com>") because that is what
 * nodemailer takes. Split it here rather than adding a second from-config that
 * can drift out of sync with the SMTP path.
 */
function splitFrom(value) {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(value || '');
  if (match) return { name: match[1] || env.mail.fromName, email: match[2] };
  return { name: env.mail.fromName, email: (value || '').trim() };
}

function buildBrevo() {
  const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
  const sender = splitFrom(env.mail.from);

  return {
    name: 'brevo',
    configured: true,
    async send({ to, subject, text, html }) {
      // Node 20 ships global fetch, so there is nothing extra to install. The
      // abort timer mirrors the SMTP timeouts — a stalled mail API must not
      // hold an OTP request open.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.mail.timeoutMs);

      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'api-key': env.mail.brevoApiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            sender,
            to: [{ email: to }],
            subject,
            textContent: text,
            ...(html ? { htmlContent: html } : {}),
            ...(env.mail.replyTo ? { replyTo: { email: env.mail.replyTo } } : {}),
          }),
          signal: controller.signal,
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          // Brevo returns { code, message }. An unverified sender and a bad key
          // are the two you will actually hit, and they are indistinguishable
          // from the caller unless the reason is surfaced.
          throw new Error(body?.message || `brevo responded ${res.status}`);
        }

        return { messageId: body.messageId, channel: 'email' };
      } finally {
        clearTimeout(timer);
      }
    },
    /** Optional health check — the key's shape is all that can be checked offline. */
    async verify() {
      return Boolean(env.mail.brevoApiKey);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

let cached = null;

function getProvider() {
  if (cached) return cached;

  const name = env.mail.provider;

  if (name === 'brevo') {
    if (env.mail.brevoApiKey) {
      cached = buildBrevo();
      console.log(`[mail] brevo ready from ${env.mail.from}`);
    } else {
      console.warn('[mail] brevo selected but BREVO_API_KEY missing — using console');
      cached = consoleProvider;
    }
    return cached;
  }

  const hasCreds = Boolean(env.mail.host && env.mail.user && env.mail.pass);

  if (name === 'smtp' && hasCreds) {
    try {
      cached = buildSmtp();
      console.log(`[mail] smtp ready (${env.mail.host}:${env.mail.port}) from ${env.mail.from}`);
    } catch (err) {
      console.warn(`[mail] smtp selected but nodemailer failed to load — using console. ${err.message}`);
      cached = consoleProvider;
    }
  } else {
    if (name === 'smtp') {
      console.warn('[mail] smtp selected but MAIL_HOST / MAIL_USER / MAIL_PASS incomplete — using console');
    }
    cached = consoleProvider;
  }

  return cached;
}

/** True when mail can actually leave the building. */
function isConfigured() {
  return getProvider().configured === true;
}

module.exports = { getProvider, isConfigured };