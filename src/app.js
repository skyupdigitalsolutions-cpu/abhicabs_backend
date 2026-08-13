'use strict';

/**
 * src/app.js
 *
 * Express application. Middleware ORDER matters — each block sits where it
 * does for a reason noted in the comments.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const db = require('./config/prisma');
const { notFound, errorHandler } = require('./middlewares/error');

const app = express();

// FIRST — behind Nginx/Cloudflare, req.ip is the proxy unless this is set,
// which would make every rate limit apply to your whole userbase at once.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);            // curl / mobile app
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(compression());
app.use(cookieParser());

// Bounded body size — an unbounded body is a denial-of-service vector.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

/* ---------------- Health ---------------- */

// Liveness: is the process up? (used by PM2/Docker restarts)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// Readiness: should this instance receive traffic? Checks dependencies too.
app.get('/health/ready', async (req, res) => {
  const dbHealth = await db.health();
  const ready = dbHealth.status === 'up';
  res.status(ready ? 200 : 503).json({ ready, db: dbHealth });
});

/* ---------------- API ---------------- */

app.use('/api/v1', require('./routes'));

/* ---------------- 404 + errors (always last) ---------------- */

app.use(notFound);
app.use(errorHandler);

module.exports = app;