'use strict';

/**
 * src/controllers/blogAuth.controller.js
 *
 * Blog Builder auth — separate from the main admin auth.
 * Uses the `blog_users` table and issues its own JWTs.
 *
 * On first login attempt, if no blog users exist, a default admin
 * is seeded automatically so the builder is usable out of the box.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/prisma');
const { asyncHandler } = require('../utils/helpers');

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES = '7d';
const JWT_ALG = 'HS256';
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Signing secret for Blog Builder tokens. There is NO hard-coded fallback: a
 * secret that is written in the source code lets anyone mint an admin token.
 *   1. BLOG_JWT_SECRET, if set (recommended)
 *   2. JWT_SECRET, if set and at least 32 characters (kept so existing sessions stay valid)
 *   3. otherwise derived from the main JWT_ACCESS_SECRET (required by src/config/env.js),
 *      under a separate label so blog tokens and main-app tokens never verify as each other.
 */
function resolveSecret() {
  if (process.env.BLOG_JWT_SECRET) return process.env.BLOG_JWT_SECRET;
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  const base = process.env.JWT_ACCESS_SECRET || require('../config/env').accessSecret;
  if (!base) throw new Error('[blog] No secret available to sign Blog Builder tokens (set BLOG_JWT_SECRET).');
  return crypto.createHmac('sha256', base).update('abhicabs-blog-builder-jwt-v1').digest('hex');
}
const JWT_SECRET = resolveSecret();

// Default seed admin — created on first login only if NO blog users exist.
const SEED_EMAIL = process.env.BLOG_ADMIN_EMAIL || 'blog@abhicabs.in';
const SEED_NAME = 'Blog Admin';
// The password must not be one that is published in the code. In production, when
// BLOG_ADMIN_PASSWORD is not set, a random one is generated and printed once in the
// server log. Local development keeps the old default so nothing changes there.
const LEGACY_DEV_PASSWORD = 'AbhiBlog@2025';
function seedPassword() {
  if (process.env.BLOG_ADMIN_PASSWORD) return { password: process.env.BLOG_ADMIN_PASSWORD, generated: false };
  if (!IS_PROD) return { password: LEGACY_DEV_PASSWORD, generated: false };
  return { password: crypto.randomBytes(12).toString('base64url'), generated: true };
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES, algorithm: JWT_ALG },
  );
}

function publicUser(u) {
  if (!u) return null;
  const { password, ...safe } = u;
  return safe;
}

async function ensureSeedAdmin() {
  const count = await prisma.blogUser.count();
  if (count > 0) return;

  const { password, generated } = seedPassword();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    await prisma.blogUser.create({
      data: {
        name: SEED_NAME,
        email: SEED_EMAIL,
        password: hash,
        role: 'admin',
      },
    });
  } catch (err) {
    if (err?.code === 'P2002') return; // another request seeded it at the same moment
    throw err;
  }
  console.log(`[blog] Seeded default blog admin: ${SEED_EMAIL}`);
  if (generated) {
    console.warn(`[blog] BLOG_ADMIN_PASSWORD is not set — generated password for ${SEED_EMAIL}: ${password}`);
    console.warn('[blog] Log in and change it in Blog Builder → Users, or set BLOG_ADMIN_PASSWORD.');
  }
}

/* ── Middleware: Blog JWT auth ──────────────────────────────────────────── */

/**
 * Who is calling: verifies the token AND re-reads the user, so a deactivated or
 * deleted account loses access at once and a role change applies at once
 * (the token only proves identity; the role always comes from the database).
 * → { user } or { status, message }
 */
async function authenticate(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return { status: 401, message: 'Not authenticated' };
  let decoded;
  try {
    decoded = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: [JWT_ALG] });
  } catch {
    return { status: 401, message: 'Token expired or invalid' };
  }
  // ids are UUIDs; anything else would make the database query itself fail
  if (!decoded?.id || !/^[0-9a-f-]{36}$/i.test(String(decoded.id))) return { status: 401, message: 'Token expired or invalid' };
  const user = await prisma.blogUser.findUnique({
    where: { id: String(decoded.id) },
    select: { id: true, email: true, role: true, isActive: true },
  });
  if (!user || !user.isActive) return { status: 401, message: 'Account not found or inactive' };
  return { user: { id: user.id, email: user.email, role: user.role } };
}
exports.authenticateBlogUser = authenticate;

exports.requireBlogAuth = (req, res, next) => {
  authenticate(req)
    .then((out) => {
      if (!out.user) return res.status(out.status).json({ success: false, message: out.message });
      req.blogUser = out.user;
      return next();
    })
    .catch(next);
};

exports.requireBlogAdmin = (req, res, next) => {
  if (req.blogUser?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
};

/* ── Login ──────────────────────────────────────────────────────────────── */

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  // Auto-seed on first use
  await ensureSeedAdmin();

  const user = await prisma.blogUser.findUnique({ where: { email: email.trim().toLowerCase() } });

  const hashToCompare = user?.password || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(password, hashToCompare);

  if (!user || !ok) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  if (!user.isActive) {
    return res.status(403).json({ success: false, message: 'Account is deactivated' });
  }

  const token = signToken(user);
  res.json({
    success: true,
    message: 'Logged in',
    user: publicUser(user),
    token,
  });
});

/* ── Me ────────────────────────────────────────────────────────────────── */

exports.me = asyncHandler(async (req, res) => {
  const user = await prisma.blogUser.findUnique({ where: { id: req.blogUser.id } });
  if (!user || !user.isActive) {
    return res.status(401).json({ success: false, message: 'Account not found or inactive' });
  }
  res.json({ success: true, user: publicUser(user) });
});

/* ── User CRUD (admin only) ────────────────────────────────────────────── */

exports.listUsers = asyncHandler(async (req, res) => {
  const users = await prisma.blogUser.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  });
  res.json({ success: true, users });
});

exports.createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role = 'editor' } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password?.trim()) {
    return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
  }

  const existing = await prisma.blogUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (existing) {
    return res.status(409).json({ success: false, message: 'Email already exists' });
  }

  const hash = await bcrypt.hash(password.trim(), BCRYPT_ROUNDS);
  const user = await prisma.blogUser.create({
    data: {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password: hash,
      role: ['admin', 'editor', 'viewer'].includes(role) ? role : 'editor',
    },
  });

  res.status(201).json({ success: true, user: publicUser(user) });
});

exports.updateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, password, role } = req.body || {};

  const data = {};
  if (name?.trim()) data.name = name.trim();
  if (email?.trim()) data.email = email.trim().toLowerCase();
  if (role && ['admin', 'editor', 'viewer'].includes(role)) data.role = role;
  if (password?.trim()) data.password = await bcrypt.hash(password.trim(), BCRYPT_ROUNDS);

  try {
    const user = await prisma.blogUser.update({ where: { id }, data });
    res.json({ success: true, user: publicUser(user) });
  } catch {
    res.status(404).json({ success: false, message: 'User not found' });
  }
});

exports.deleteUser = asyncHandler(async (req, res) => {
  try {
    await prisma.blogUser.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'User removed' });
  } catch {
    res.status(404).json({ success: false, message: 'User not found' });
  }
});
