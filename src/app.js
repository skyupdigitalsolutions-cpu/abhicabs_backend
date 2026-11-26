'use strict';

/**
 * src/app.js   — UPDATED for Day 2
 *
 * Only /health/ready changed: it now reports Redis and cache metrics too.
 */

const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const db = require('./config/prisma');
const redis = require('./config/redis');
const cacheService = require('./services/cache.service');
const loadShed = require('./middlewares/loadShed');
const { notFound, errorHandler } = require('./middlewares/error');

const app = express();

// FIRST — behind Nginx/Cloudflare, req.ip is the proxy unless this is set,
// which would make every rate limit share one bucket across all users.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);            // curl / native app
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-client-source'],
  })
);

/*
 * PUBLIC STATIC ASSETS — the invoice and confirmation logo.
 *
 * Email clients cannot render a base64 data: URI (Gmail strips them outright),
 * so the only way a logo reaches an inbox is as a URL the client can fetch.
 * Gmail proxies and displays remote images by default; Outlook shows them once
 * the reader clicks "show images", and falls back to the alt text until then.
 *
 * Mounted BEFORE the API routers and outside /api/v1 on purpose: it carries no
 * auth, no rate limit and no load shedding, because an email client fetching
 * it is an anonymous request from an address we will never see twice.
 *
 * crossOriginResourcePolicy is relaxed for this path only. helmet() sets it to
 * same-origin globally, which would make Gmail's image proxy refuse the file.
 */
app.use(
  '/static',
  express.static(path.join(__dirname, 'assets'), {
    maxAge: '7d',
    immutable: false,
    setHeaders(res) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  }),
);

app.use(compression());
app.use(cookieParser());

/* ---------------- Gateway webhooks (RAW body) ---------------- */

// MUST come before express.json(). A gateway signs the exact bytes it sends;
// once express.json() parses and re-serialises the body those bytes change and
// the HMAC no longer matches. Mounting the raw parser only on this path keeps
// the raw body available for signature verification while every other route
// still gets parsed JSON. type:()=>true so an odd Content-Type still captures.
app.use(
  '/api/v1/webhooks',
  express.raw({ type: () => true, limit: '1mb' }),
  require('./routes/webhook.routes')
);

// Bounded body — an unbounded body is a DoS vector.
// CMS content saves (all service pages / the whole blogs.js file) exceed 100kb; allow 5mb on those
// two routes only. They run first, so the general 100kb parser below skips the already-parsed body.
app.use(['/api/v1/blog/pages', '/api/v1/blog/github'], express.json({ limit: '5mb' }));
app.use(express.json({
  limit: '100kb',
  // Meta signs the exact bytes it sends (X-Hub-Signature-256). Keep them, for the Meta webhook path only.
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/webhook/meta')) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

/* ---------------- Health ---------------- */

// Liveness: is the process up? Used by PM2/Docker restart policy.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

/**
 * Readiness: should the load balancer route here?
 *
 * Only the DATABASE gates readiness. Redis being down is reported but does not
 * make the instance unready — the app degrades (cache misses, memory-based rate
 * limiting) rather than failing, and marking every instance unready over a
 * cache outage would turn it into a full outage.
 */
app.get('/health/ready', async (req, res) => {
  const reporting = require('./config/reportingPrisma');
  const [dbHealth, redisHealth, reportingHealth] = await Promise.all([
    db.health(),
    redis.health(),
    reporting.health(),
  ]);
  // Only the PRIMARY database gates readiness. The reporting replica being down
  // degrades reports but must not take the whole instance out of rotation.
  const ready = dbHealth.status === 'up';

  res.status(ready ? 200 : 503).json({
    ready,
    db: dbHealth,
    reporting: reportingHealth,
    redis: redisHealth,
    cache: cacheService.health(),
    loadShed: loadShed.stats(),
  });
});

/* ---------------- API ---------------- */

// Day 14 — backpressure. Sits in front of the API routes (but AFTER /health and
// the webhook mount, which loadShed exempts) so that when the event loop is
// saturated, new API work gets a fast 503 instead of piling into a queue that
// makes everything slower. Health checks and webhooks are never shed.
/* ---------------- WhatsApp bot (same backend, same database) ---------------- */
// MSG91 webhook + the small pages the bot links to. Not under /api/v1, so the
// load-shedder and API rate limits do not apply; the bot has its own limiters.
//
// ISOLATED ON PURPOSE. This used to be a bare top-level require, which meant a
// single missing file anywhere in src/bot threw MODULE_NOT_FOUND while app.js
// was still being evaluated — before server.js had even registered its
// uncaughtException handler. The whole API died at boot, PM2 restarted it
// sixteen times and gave up, nginx had no upstream, and every caller saw a 502:
// the rider app showed "Search is unavailable right now" and the website showed
// CORS errors on every endpoint, because a 502 carries no Access-Control-Allow-
// Origin header.
//
// The bot is an auxiliary feature. It must never be able to take bookings,
// fares, auth or place search down with it. If it fails to load we log loudly
// and serve the API without it.
try {
  app.use('/', require('./bot').router());
} catch (err) {
  console.error('[bot] DISABLED — failed to load:', err.message);
  if (err.code === 'MODULE_NOT_FOUND') {
    console.error('[bot] a file under src/bot is missing from this deploy.');
    console.error('[bot] run: node scripts/check-bot-files.js');
  }
  // The webhook must not silently 404 into the API's handler: MSG91 would read
  // that as delivered. 503 tells it to retry once the bot is restored.
  app.use(['/webhook', '/bot-admin', '/calendar', '/route-map', '/place', '/place-map'], (req, res) =>
    res.status(503).json({ success: false, error: { code: 'BOT_UNAVAILABLE' } })
  );
}

app.use('/api/v1', loadShed.middleware);

app.use('/api/v1', require('./routes'));

/* ---------------- 404 + errors (always last) ---------------- */

app.use(notFound);
app.use(errorHandler);

module.exports = app;