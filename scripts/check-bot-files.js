#!/usr/bin/env node
'use strict';

/**
 * Pre-deploy check: does every local require() in src/ actually resolve?
 *
 * Written after a partial upload of the WhatsApp bot took the whole API down.
 * Twenty-one files under src/bot never made it onto the server. Node only finds
 * out at require time, and because src/app.js requires ./bot at the top level,
 * the failure happened while app.js was being evaluated — so the process died
 * at boot, PM2 gave up after sixteen restarts, and every rider saw a 502.
 *
 * Takes under a second. Run it before `pm2 restart`:
 *
 *   node scripts/check-bot-files.js && pm2 restart ecosystem.config.js
 *
 * Exits 1 if anything is missing, so it works as a gate in a deploy script.
 * Only checks LOCAL requires — npm packages are package.json's job.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const missing = [];

for (const file of jsFiles(SRC)) {
  const source = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = REQUIRE_RE.exec(source)) !== null) {
    const spec = match[1];
    try {
      require.resolve(path.resolve(path.dirname(file), spec));
    } catch (_) {
      missing.push({ from: path.relative(ROOT, file), spec });
    }
  }
}

if (missing.length === 0) {
  console.log('[check] every local require in src/ resolves — safe to restart');
  process.exit(0);
}

// Group by the file that is missing, not by the file doing the requiring —
// one absent module usually shows up as a dozen broken requires.
const byTarget = new Map();
for (const m of missing) {
  const target = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, m.from)), m.spec));
  if (!byTarget.has(target)) byTarget.set(target, []);
  byTarget.get(target).push(m.from);
}

console.error(`[check] ${byTarget.size} file(s) are required but missing from this deploy:\n`);
for (const [target, requiredBy] of [...byTarget].sort()) {
  console.error(`  ${target}`);
  console.error(`      required by ${requiredBy.length}: ${requiredBy.slice(0, 3).join(', ')}${requiredBy.length > 3 ? ', …' : ''}`);
}
console.error('\n[check] DO NOT restart — the process will crash-loop. Upload these files first.');
process.exit(1);