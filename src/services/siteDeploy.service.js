'use strict';

/**
 * src/services/siteDeploy.service.js
 *
 * Rebuilds the public website after CMS content changes that are baked into the
 * static build (service pages, page overrides, site settings). Blog posts and
 * redirects don't need this: they are committed to GitHub, which already
 * triggers a build.
 *
 * Env (optional — when unset this does nothing and behaviour is unchanged):
 *   SITE_DEPLOY_HOOK_URL       build-hook URL(s), comma-separated
 *                              (Netlify "Build hook" and/or Cloudflare "Deploy hook")
 *   SITE_DEPLOY_DEBOUNCE_MS    wait this long after the last save before building (default 60000),
 *                              so a burst of saves causes one build, not many
 */

const axios = require('axios');

const HOOKS = String(process.env.SITE_DEPLOY_HOOK_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^https:\/\//i.test(s));
const DEBOUNCE_MS = Math.max(0, Number(process.env.SITE_DEPLOY_DEBOUNCE_MS) || 60 * 1000);

let timer = null;

async function fire(reason) {
  await Promise.all(HOOKS.map(async (url) => {
    try {
      const res = await axios.post(url, {}, { timeout: 15000, validateStatus: () => true });
      if (res.status >= 400) console.warn(`[cms] Site rebuild hook answered ${res.status} (${reason})`);
      else console.log(`[cms] Site rebuild requested (${reason})`);
    } catch (err) {
      console.warn(`[cms] Site rebuild hook failed (${reason}): ${err.message}`);
    }
  }));
}

/** Ask for a rebuild soon. Never throws and never delays the caller. */
function requestRebuild(reason = 'cms update') {
  if (!HOOKS.length) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; fire(reason); }, DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { requestRebuild, isConfigured: () => HOOKS.length > 0 };
