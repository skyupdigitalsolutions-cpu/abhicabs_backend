'use strict';

/**
 * src/services/push.service.js
 *
 * The whole push domain in one module: Firebase Admin init (lazy, from env),
 * FCM/mock provider selection, device-token CRUD, and pushToUser().
 * Credentials come from env so the service-account JSON never enters the repo;
 * unconfigured => logging mock instead of a crash.
 */

const { prisma } = require('../config/prisma');
const env = require('../config/env');

/* -------- Firebase Admin (lazy) -------- */

let fbInit = false;
let messaging = null;

function getMessaging() {
  if (fbInit) return messaging;
  fbInit = true;

  const { serviceAccountBase64, serviceAccountJson, projectId } = env.push.firebase;
  const raw = serviceAccountBase64
    ? Buffer.from(serviceAccountBase64, 'base64').toString('utf8')
    : serviceAccountJson;
  if (!raw) {
    console.warn('[push] no Firebase service account — push disabled (mock)');
    return null;
  }

  try {
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    const admin = require('firebase-admin');
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert(sa),
          projectId: projectId || sa.project_id,
        });
    messaging = admin.messaging(app);
    console.log(`[push] Firebase ready for "${sa.project_id}"`);
  } catch (err) {
    console.error('[push] Firebase init failed — push disabled:', err.message);
    messaging = null;
  }
  return messaging;
}

/* -------- Send (mock | fcm) -------- */

// FCM errors meaning "token is dead, delete it".
const DEAD = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

async function send(tokens, title, body, data) {
  const m = env.push.provider === 'fcm' ? getMessaging() : null;
  if (!m) {
    console.log(`[push:mock] -> ${tokens.length} token(s) [${title}] ${body}`);
    return { successCount: tokens.length, invalidTokens: [] };
  }

  const strData = {};
  for (const [k, v] of Object.entries(data || {})) strData[k] = String(v);

  const res = await m.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: strData,
    android: { priority: 'high', notification: { sound: 'default' } },
    apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
  });

  const invalidTokens = [];
  res.responses.forEach((r, i) => {
    if (!r.success && DEAD.has(r.error?.code)) invalidTokens.push(tokens[i]);
  });
  return { successCount: res.successCount, invalidTokens };
}

/* -------- Device tokens -------- */

const MAX_TOKENS_PER_USER = 20; // bound growth from FCM token rotation

async function registerToken(userId, { token, platform }) {
  const rec = await prisma.deviceToken.upsert({
    where: { token }, // globally unique: re-point a re-used device, never duplicate
    create: { userId, token, platform: platform || 'android', lastSeenAt: new Date() },
    update: { userId, platform: platform || 'android', lastSeenAt: new Date() },
    select: { id: true, platform: true, createdAt: true },
  });

  const rows = await prisma.deviceToken.findMany({
    where: { userId }, orderBy: { lastSeenAt: 'desc' }, select: { id: true },
  });
  if (rows.length > MAX_TOKENS_PER_USER) {
    await prisma.deviceToken.deleteMany({
      where: { id: { in: rows.slice(MAX_TOKENS_PER_USER).map((r) => r.id) } },
    });
  }
  return rec;
}

// deleteMany (not delete): a foreign/absent token is a no-op, never a 500.
async function unregisterToken(userId, token) {
  const { count } = await prisma.deviceToken.deleteMany({ where: { userId, token } });
  return { removed: count };
}

async function listTokens(userId) {
  return prisma.deviceToken.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, platform: true, lastSeenAt: true, createdAt: true },
  });
}

/* -------- Public: send to a user -------- */

async function pushToUser(userId, { title, body, data = {} }) {
  const rows = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
  const tokens = rows.map((r) => r.token);
  if (!tokens.length) return { sent: 0, reason: 'no-tokens' };

  const { successCount, invalidTokens } = await send(tokens, title, body, data);
  if (invalidTokens.length) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } }).catch(() => {});
  }
  return { sent: successCount };
}

module.exports = { pushToUser, registerToken, unregisterToken, listTokens };