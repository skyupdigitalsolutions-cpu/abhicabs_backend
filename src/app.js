'use strict';

/**
 * src/app.js   — UPDATED for Day 2
 *
 * Only /health/ready changed: it now reports Redis and cache metrics too.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const db = require('./config/prisma');
const redis = require('./config/redis');
const cacheService = require('./services/cache.service');
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
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  })
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
app.use(express.json({ limit: '100kb' }));
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
  });
});

/* ---------------- API ---------------- */

app.use('/api/v1', require('./routes'));

/* ---------------- 404 + errors (always last) ---------------- */

app.use(notFound);
app.use(errorHandler);

module.exports = app;