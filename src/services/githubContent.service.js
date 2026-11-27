'use strict';

/**
 * src/services/githubContent.service.js
 *
 * Reads and commits the website's CMS data files on GitHub, on behalf of the
 * Blog Builder. The GitHub token lives ONLY here, on the server
 * (env GH_TOKEN). Previously the website carried it as VITE_GH_TOKEN, which
 * put a repo-write token inside the public JavaScript.
 *
 * Only the files in ALLOWED_FILES can be read or written, so the endpoint
 * cannot be used to change anything else in the repository.
 *
 * Env:
 *   GH_TOKEN   token with "Contents: read & write" on the website repo (required)
 *   GH_REPO    "owner/repo"  (default: abhicabs/abhicabs-customers-website)
 *   GH_BRANCH  branch to read/commit (default: main)
 *   GH_API_URL GitHub API base (default: https://api.github.com; only changed for tests / GitHub Enterprise)
 */

const axios = require('axios');
const { parseExportedArray, serializeArray, LiteralError } = require('../utils/safeLiteral');

const ALLOWED_FILES = new Set(['src/data/blogs.js', 'src/data/redirects.js']);
const PUBLIC_READ_FILES = new Set(['src/data/blogs.js']); // readable without a CMS login (the public blog uses it)
const ADMIN_WRITE_FILES = new Set(['src/data/redirects.js']); // the CMS only lets admins manage redirects
// The name of the array each data file exports.
const EXPORT_NAMES = { 'src/data/blogs.js': 'BLOGS', 'src/data/redirects.js': 'REDIRECTS' };

const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_REPO || 'abhicabs/abhicabs-customers-website';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_API_URL = (process.env.GH_API_URL || 'https://api.github.com').replace(/\/+$/, '');

const gh = axios.create({
  baseURL: `${GH_API_URL}/repos/${GH_REPO}/contents/`,
  timeout: 15000,
  headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'abhicabs-cms' },
  validateStatus: () => true, // we map GitHub's status ourselves
});

class GithubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function assertConfigured() {
  if (!GH_TOKEN) throw new GithubError(503, 'Publishing is not configured on the server (GH_TOKEN is not set).');
}

function assertAllowed(path) {
  if (!ALLOWED_FILES.has(path)) throw new GithubError(400, `File not allowed: ${path}`);
}

const isPublicReadable = (path) => PUBLIC_READ_FILES.has(path);
const requiresAdminToWrite = (path) => ADMIN_WRITE_FILES.has(path);

const decodeB64 = (b64) => Buffer.from(String(b64 || '').replace(/\s+/g, ''), 'base64').toString('utf8');
const encodeB64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * The committed file must be plain data: `export const <NAME> = [ {…}, … ];`.
 * It is parsed WITHOUT executing it and written back in the CMS's own layout, so
 * nothing but data can ever reach the repo (the file is imported by the site
 * build and read by every visitor's browser).
 */
function normalizeDataFile(path, base64) {
  const name = EXPORT_NAMES[path];
  let arr;
  try {
    arr = parseExportedArray(decodeB64(base64), name);
  } catch (err) {
    if (err instanceof LiteralError) throw new GithubError(400, `${path} must contain only data (${err.message}).`);
    throw err;
  }
  const bad = arr.findIndex((item) => !item || typeof item !== 'object' || Array.isArray(item));
  if (bad !== -1) throw new GithubError(400, `${path}: entry ${bad + 1} is not an object.`);
  return encodeB64(serializeArray(name, arr));
}

/** Same test the website uses before showing a post. */
const isPublishedBlog = (b) => b && b.slug && !b.draft && (!b.status || String(b.status).toLowerCase() === 'published');

/**
 * blogs.js for anonymous readers: unpublished posts removed. If the file can't be
 * parsed it's returned unchanged (the website then behaves exactly as before).
 */
function publicView(path, body) {
  if (path !== 'src/data/blogs.js') return body;
  try {
    const arr = parseExportedArray(decodeB64(body.content), 'BLOGS');
    const published = arr.filter(isPublishedBlog);
    if (published.length === arr.length) return body;
    return { ...body, content: encodeB64(serializeArray('BLOGS', published)) };
  } catch {
    return body;
  }
}

// Short cache for reads: the public blog page asks on every visit, GitHub allows 5,000 requests/hour per token.
const cache = new Map(); // path -> { at, body }
const CACHE_MS = 30 * 1000;

/** GitHub's own "get contents" JSON ({ content (base64), sha, ... }) for an allowed file. */
async function getFile(path, { fresh = false } = {}) {
  assertAllowed(path);
  assertConfigured();
  const hit = cache.get(path);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.body;

  const res = await gh.get(encodeURI(path), {
    params: { ref: GH_BRANCH, t: Date.now() },
    headers: { Authorization: `token ${GH_TOKEN}` },
  });
  if (res.status === 401) throw new GithubError(502, 'GitHub rejected the server token (401). Check GH_TOKEN.');
  if (res.status === 404) throw new GithubError(404, `Not found on GitHub: ${GH_REPO}@${GH_BRANCH}/${path}`);
  if (res.status >= 400) throw new GithubError(502, `GitHub error ${res.status}`);

  const body = { content: res.data.content, sha: res.data.sha, encoding: res.data.encoding, path: res.data.path };
  cache.set(path, { at: Date.now(), body });
  return body;
}

/**
 * Commit new content to an allowed file. `content` is base64 (what the CMS already sends to GitHub);
 * `sha` is the file's current sha (GitHub rejects the commit with 409 if someone changed it meanwhile).
 */
async function putFile(path, { content, sha, message }) {
  assertAllowed(path);
  assertConfigured();
  if (typeof content !== 'string' || !content) throw new GithubError(400, 'content (base64) is required');
  if (typeof message !== 'string' || !message.trim()) throw new GithubError(400, 'message is required');
  const safeContent = normalizeDataFile(path, content);

  const res = await gh.put(encodeURI(path), {
    message: message.slice(0, 300),
    content: safeContent,
    ...(sha ? { sha } : {}),
    branch: GH_BRANCH,
  }, { headers: { Authorization: `token ${GH_TOKEN}`, 'Content-Type': 'application/json' } });

  if (res.status === 409) throw new GithubError(409, 'The file changed on GitHub since it was loaded. Reload and try again.');
  if (res.status === 401) throw new GithubError(502, 'GitHub rejected the server token (401). Check GH_TOKEN.');
  if (res.status >= 400) throw new GithubError(502, res.data?.message || `GitHub error ${res.status}`);

  cache.delete(path);
  return { content: { sha: res.data?.content?.sha, path: res.data?.content?.path }, commit: { sha: res.data?.commit?.sha } };
}

module.exports = {
  getFile, putFile, isPublicReadable, requiresAdminToWrite, publicView, normalizeDataFile, GithubError, ALLOWED_FILES,
};
