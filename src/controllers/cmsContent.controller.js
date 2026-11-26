'use strict';

/**
 * src/controllers/cmsContent.controller.js
 *
 * Blog Builder content endpoints (mounted under /api/v1/blog):
 *
 *   GET  /pages          public   — every CMS page, { data: { <pageKey>: <page object> } }
 *   PUT  /pages          editor+  — replace the full set of CMS pages (the CMS always sends all of them)
 *   GET  /github/file    public for src/data/blogs.js, CMS login for the other allowed files
 *   PUT  /github/file    editor+  — commit an allowed file (blogs.js, redirects.js) to the website repo
 */

const { prisma } = require('../config/prisma');
const { asyncHandler } = require('../utils/helpers');
const { requireBlogAuth } = require('./blogAuth.controller');
const github = require('../services/githubContent.service');

const PAGE_KEY = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const MAX_PAGES = 500;

/* ── Roles ─────────────────────────────────────────────────────────────── */

/** After requireBlogAuth: editors and admins may change content; viewers may not. */
exports.requireBlogEditor = (req, res, next) => {
  const role = req.blogUser?.role;
  if (role !== 'admin' && role !== 'editor') {
    return res.status(403).json({ success: false, message: 'Editor or admin access required' });
  }
  return next();
};

/* ── Pages ─────────────────────────────────────────────────────────────── */

exports.getPages = asyncHandler(async (req, res) => {
  const rows = await prisma.cmsPage.findMany({ select: { id: true, content: true } });
  const data = {};
  for (const r of rows) data[r.id] = r.content;
  // The website reads this on every page build/visit; a short shared cache is plenty fresh for CMS edits.
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({ success: true, data });
});

exports.putPages = asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ success: false, message: 'Body must be an object of pages' });
  }
  const entries = Object.entries(body);
  // Refuse an empty save: with replace semantics it would wipe every page.
  if (entries.length === 0) {
    return res.status(400).json({ success: false, message: 'Refusing to save an empty page set' });
  }
  if (entries.length > MAX_PAGES) {
    return res.status(400).json({ success: false, message: `Too many pages (max ${MAX_PAGES})` });
  }
  for (const [key, page] of entries) {
    if (!PAGE_KEY.test(key)) return res.status(400).json({ success: false, message: `Invalid page key: ${key}` });
    if (!page || typeof page !== 'object' || Array.isArray(page)) {
      return res.status(400).json({ success: false, message: `Page "${key}" must be an object` });
    }
  }

  const keys = entries.map(([k]) => k);
  const by = req.blogUser?.email || null;
  await prisma.$transaction([
    // Pages the CMS no longer sends were deleted there.
    prisma.cmsPage.deleteMany({ where: { id: { notIn: keys } } }),
    ...entries.map(([id, content]) => prisma.cmsPage.upsert({
      where: { id },
      create: { id, content, updatedBy: by },
      update: { content, updatedBy: by },
    })),
  ]);

  return res.json({ success: true, message: 'Saved', data: { count: keys.length } });
});

/* ── GitHub relay (blogs.js / redirects.js) ────────────────────────────── */

function sendGithubError(res, err) {
  if (err instanceof github.GithubError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  throw err;
}

exports.getGithubFile = asyncHandler(async (req, res) => {
  const path = String(req.query.path || '');
  // blogs.js is public (the website's blog reads it); other files need a CMS login.
  // A signed-in user is recognised either way so ?fresh=1 (skip the cache) works in the CMS.
  if (!github.isPublicReadable(path) || req.headers.authorization) {
    let authed = false;
    requireBlogAuth(req, res, () => { authed = true; }); // synchronous; sends 401 itself on failure
    if (!authed) return undefined;
  }
  try {
    const file = await github.getFile(path, { fresh: req.query.fresh === '1' && !!req.blogUser });
    res.set('Cache-Control', 'no-store');
    return res.json(file); // same shape as GitHub's own response: { content (base64), sha, ... }
  } catch (err) { return sendGithubError(res, err); }
});

exports.putGithubFile = asyncHandler(async (req, res) => {
  const { path, content, sha, message } = req.body || {};
  try {
    const out = await github.putFile(String(path || ''), {
      content,
      sha,
      message: `${message || 'CMS update'} (by ${req.blogUser?.email || 'cms'})`,
    });
    return res.json(out); // { content: { sha }, commit: { sha } } — like GitHub's own response
  } catch (err) { return sendGithubError(res, err); }
});
