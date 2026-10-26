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

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/prisma');
const { asyncHandler } = require('../utils/helpers');

const BCRYPT_ROUNDS = 12;
const JWT_SECRET = process.env.BLOG_JWT_SECRET || process.env.JWT_SECRET || 'blog-builder-secret-change-me';
const JWT_EXPIRES = '7d';

// Default seed admin — created on first login if no blog users exist
const SEED_EMAIL = process.env.BLOG_ADMIN_EMAIL || 'blog@abhicabs.in';
const SEED_PASSWORD = process.env.BLOG_ADMIN_PASSWORD || 'AbhiBlog@2025';
const SEED_NAME = 'Blog Admin';

/* ── Helpers ────────────────────────────────────────────────────────────── */

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES },
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

  const hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);
  await prisma.blogUser.create({
    data: {
      name: SEED_NAME,
      email: SEED_EMAIL,
      password: hash,
      role: 'admin',
    },
  });
  console.log(`[blog] Seeded default blog admin: ${SEED_EMAIL}`);
}

/* ── Middleware: Blog JWT auth ──────────────────────────────────────────── */

exports.requireBlogAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.blogUser = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token expired or invalid' });
  }
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
