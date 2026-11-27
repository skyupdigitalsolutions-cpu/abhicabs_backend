'use strict';

/**
 * src/controllers/cmsContent.controller.js
 *
 * Blog Builder content endpoints (mounted under /api/v1/blog):
 *
 *   GET  /pages          public   — every CMS page, { data: { <pageKey>: <page object> }, versions: { <pageKey>: <ISO time> } }
 *   POST /pages/sync     editor+  — create / update / delete only the pages that changed, each checked
 *                                   against the version the editor loaded (409 if someone else changed it)
 *   PUT  /pages          editor+  — legacy: replace the full set of CMS pages (kept for older CMS builds)
 *   GET  /site-settings  public   — header & footer overrides, { data: { header, footer } }
 *   PUT  /site-settings  editor+  — save header & footer overrides
 *   GET  /github/file    public for src/data/blogs.js (published posts only), CMS login for the other allowed files
 *   PUT  /github/file    editor+ for blogs.js, admin for redirects.js — commit to the website repo
 */

const { prisma } = require('../config/prisma');
const { asyncHandler } = require('../utils/helpers');
const { authenticateBlogUser } = require('./blogAuth.controller');
const github = require('../services/githubContent.service');
const siteDeploy = require('../services/siteDeploy.service');

const PAGE_KEY = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const MAX_PAGES = 500;
const SITE_SETTINGS_KEY = 'cms_site_settings';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const versionOf = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

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
  const rows = await prisma.cmsPage.findMany({ select: { id: true, content: true, updatedAt: true } });
  const data = {};
  const versions = {};
  for (const r of rows) { data[r.id] = r.content; versions[r.id] = versionOf(r.updatedAt); }
  // The website reads this on every page build/visit; a short shared cache is plenty fresh for CMS edits.
  // The CMS itself sends a login, and must always see the latest versions.
  res.set('Cache-Control', req.headers.authorization ? 'private, no-store' : 'public, max-age=30');
  return res.json({ success: true, data, versions });
});

class PageConflict extends Error {
  constructor(ids) { super('conflict'); this.ids = ids; }
}

/**
 * POST /pages/sync  { upsert: { <id>: page }, remove: [<id>], base: { <id>: <version> | null } }
 *
 * Only the pages listed are touched. Each is written only if it is still at the
 * version the editor loaded (`base`; null = "did not exist"), so two editors can
 * never silently overwrite or delete each other's work, and an editor whose page
 * list failed to load can't wipe pages they never saw.
 */
exports.syncPages = asyncHandler(async (req, res) => {
  const body = req.body;
  if (!isPlainObject(body)) return res.status(400).json({ success: false, message: 'Body must be an object' });
  const upsert = body.upsert === undefined ? {} : body.upsert;
  const remove = body.remove === undefined ? [] : body.remove;
  const base = body.base === undefined ? {} : body.base;
  if (!isPlainObject(upsert) || !Array.isArray(remove) || !isPlainObject(base)) {
    return res.status(400).json({ success: false, message: 'upsert must be an object, remove an array, base an object' });
  }
  const upsertIds = Object.keys(upsert);
  const removeIds = [...new Set(remove.map(String))];
  if (upsertIds.length + removeIds.length === 0) return res.json({ success: true, message: 'Nothing to save', data: { versions: {}, removed: [] } });
  if (upsertIds.length + removeIds.length > MAX_PAGES) {
    return res.status(400).json({ success: false, message: `Too many pages (max ${MAX_PAGES})` });
  }
  for (const id of [...upsertIds, ...removeIds]) {
    if (!PAGE_KEY.test(id)) return res.status(400).json({ success: false, message: `Invalid page key: ${id}` });
  }
  for (const id of upsertIds) {
    if (!isPlainObject(upsert[id])) return res.status(400).json({ success: false, message: `Page "${id}" must be an object` });
    if (removeIds.includes(id)) return res.status(400).json({ success: false, message: `Page "${id}" is both saved and deleted` });
  }
  for (const id of Object.keys(base)) {
    const b = base[id];
    if (b !== null && (typeof b !== 'string' || Number.isNaN(Date.parse(b)))) {
      return res.status(400).json({ success: false, message: `Invalid version for "${id}"` });
    }
  }

  const by = req.blogUser?.email || null;
  const baseOf = (id) => (base[id] === undefined || base[id] === null ? null : new Date(base[id]));

  let versions;
  try {
    versions = await prisma.$transaction(async (tx) => {
      const touched = [...upsertIds, ...removeIds];
      const rows = await tx.cmsPage.findMany({ where: { id: { in: touched } }, select: { id: true, updatedAt: true } });
      const current = new Map(rows.map((r) => [r.id, new Date(r.updatedAt)]));

      const conflicts = [];
      for (const id of upsertIds) {
        const b = baseOf(id);
        const cur = current.get(id);
        if (b === null ? !!cur : (!cur || cur.getTime() !== b.getTime())) conflicts.push(id);
      }
      for (const id of removeIds) {
        const b = baseOf(id);
        const cur = current.get(id);
        if (cur && (b === null || cur.getTime() !== b.getTime())) conflicts.push(id);
      }
      if (conflicts.length) throw new PageConflict(conflicts);

      const creates = upsertIds.filter((id) => !current.has(id));
      if (creates.length) {
        const total = await tx.cmsPage.count();
        const removing = removeIds.filter((id) => current.has(id)).length;
        if (total - removing + creates.length > MAX_PAGES) {
          const err = new Error(`Too many pages (max ${MAX_PAGES})`);
          err.statusCode = 400;
          throw err;
        }
      }

      const now = new Date();
      for (const id of removeIds) {
        if (!current.has(id)) continue; // already gone
        const out = await tx.cmsPage.deleteMany({ where: { id, updatedAt: current.get(id) } });
        if (out.count !== 1) throw new PageConflict([id]);
      }
      for (const id of upsertIds) {
        const content = upsert[id];
        if (current.has(id)) {
          const out = await tx.cmsPage.updateMany({
            where: { id, updatedAt: current.get(id) },
            data: { content, updatedBy: by, updatedAt: now },
          });
          if (out.count !== 1) throw new PageConflict([id]);
        } else {
          try {
            await tx.cmsPage.create({ data: { id, content, updatedBy: by, updatedAt: now } });
          } catch (err) {
            if (err?.code === 'P2002') throw new PageConflict([id]); // created by someone else meanwhile
            throw err;
          }
        }
      }

      const after = upsertIds.length
        ? await tx.cmsPage.findMany({ where: { id: { in: upsertIds } }, select: { id: true, updatedAt: true } })
        : [];
      const v = {};
      for (const r of after) v[r.id] = versionOf(r.updatedAt);
      return v;
    }, { timeout: 30000, maxWait: 10000 });
  } catch (err) {
    if (err instanceof PageConflict || err?.code === 'P2034') {
      const ids = err.ids || [];
      const rows = await prisma.cmsPage.findMany({ where: { id: { in: [...upsertIds, ...removeIds] } }, select: { id: true, updatedAt: true } });
      const current = {};
      for (const r of rows) current[r.id] = versionOf(r.updatedAt);
      return res.status(409).json({
        success: false,
        message: ids.length
          ? `Someone else changed ${ids.length === 1 ? 'this page' : 'these pages'} since you opened the CMS: ${ids.join(', ')}. Reload to get the latest version.`
          : 'Someone else saved at the same moment. Please try again.',
        conflicts: ids,
        versions: current,
      });
    }
    if (err?.statusCode === 400) return res.status(400).json({ success: false, message: err.message });
    throw err;
  }

  siteDeploy.requestRebuild('cms pages saved');
  return res.json({ success: true, message: 'Saved', data: { versions, removed: removeIds } });
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

  siteDeploy.requestRebuild('cms pages saved');
  return res.json({ success: true, message: 'Saved', data: { count: keys.length } });
});

/* ── Site settings (header & footer) ───────────────────────────────────── */

const MAX_SETTINGS_BYTES = 64 * 1024;
const UNSAFE_URL = /^\s*(javascript|vbscript|data):/i;

/** Plain JSON only, sensible sizes, and no script URLs anywhere (they end up in href attributes). */
function checkSettingsValue(v, path, depth = 0) {
  if (depth > 6) return `${path}: too deeply nested`;
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return null;
  if (typeof v === 'string') {
    if (v.length > 2000) return `${path}: text is too long`;
    if (UNSAFE_URL.test(v)) return `${path}: this kind of link is not allowed`;
    return null;
  }
  if (Array.isArray(v)) {
    if (v.length > 200) return `${path}: too many items`;
    for (let i = 0; i < v.length; i++) { const e = checkSettingsValue(v[i], `${path}[${i}]`, depth + 1); if (e) return e; }
    return null;
  }
  if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) { const e = checkSettingsValue(x, `${path}.${k}`, depth + 1); if (e) return e; }
    return null;
  }
  return `${path}: unsupported value`;
}

exports.getSiteSettings = asyncHandler(async (req, res) => {
  const row = await prisma.setting.findUnique({ where: { key: SITE_SETTINGS_KEY } });
  const value = isPlainObject(row?.value) ? row.value : {};
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({ success: true, data: { header: value.header || {}, footer: value.footer || {} } });
});

exports.putSiteSettings = asyncHandler(async (req, res) => {
  const body = req.body;
  if (!isPlainObject(body)) return res.status(400).json({ success: false, message: 'Body must be an object' });
  const value = {
    header: isPlainObject(body.header) ? body.header : {},
    footer: isPlainObject(body.footer) ? body.footer : {},
  };
  const problem = checkSettingsValue(value, 'settings');
  if (problem) return res.status(400).json({ success: false, message: problem });
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SETTINGS_BYTES) {
    return res.status(400).json({ success: false, message: 'Settings are too large' });
  }
  await prisma.setting.upsert({
    where: { key: SITE_SETTINGS_KEY },
    update: { value },
    create: { key: SITE_SETTINGS_KEY, value },
  });
  return res.json({ success: true, message: 'Saved', data: value });
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
    const out = await authenticateBlogUser(req);
    if (!out.user) return res.status(out.status).json({ success: false, message: out.message });
    req.blogUser = out.user;
  }
  try {
    const file = await github.getFile(path, { fresh: req.query.fresh === '1' && !!req.blogUser });
    res.set('Cache-Control', 'no-store');
    // same shape as GitHub's own response: { content (base64), sha, ... }
    // Anonymous readers only get published posts; CMS users get the whole file.
    return res.json(req.blogUser ? file : github.publicView(path, file));
  } catch (err) { return sendGithubError(res, err); }
});

exports.putGithubFile = asyncHandler(async (req, res) => {
  const { path, content, sha, message } = req.body || {};
  const filePath = String(path || '');
  if (github.requiresAdminToWrite(filePath) && req.blogUser?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  try {
    const out = await github.putFile(filePath, {
      content,
      sha,
      message: `${message || 'CMS update'} (by ${req.blogUser?.email || 'cms'})`,
    });
    return res.json(out); // { content: { sha }, commit: { sha } } — like GitHub's own response
  } catch (err) { return sendGithubError(res, err); }
});
