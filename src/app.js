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
  const [dbHealth, redisHealth] = await Promise.all([db.health(), redis.health()]);
  const ready = dbHealth.status === 'up';

  res.status(ready ? 200 : 503).json({
    ready,
    db: dbHealth,
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