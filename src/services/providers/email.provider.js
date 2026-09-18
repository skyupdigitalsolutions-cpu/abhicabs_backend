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
 * Factory
 * ------------------------------------------------------------------ */

let cached = null;

function getProvider() {
  if (cached) return cached;

  const name = env.mail.provider;
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