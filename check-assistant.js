/**
 * check-assistant.js
 *
 * Why the help chat answers "I couldn't answer just now", narrowed to one
 * cause.
 *
 * RUN IT ON THE API SERVICE — the one running `src/server.js`. The assistant
 * is called from the request path, not from a worker, so the API's environment
 * is the one that matters. Running it on the worker tells you about an
 * environment no rider ever touches.
 *
 *   node check-assistant.js
 *   node check-assistant.js "How do I cancel my booking?"
 *
 * It does four things, in order, and stops at the first one that fails:
 *
 *   1. Reads the config this process actually has, and masks the key.
 *   2. Opens a TCP connection to api.openai.com, so a blocked egress route is
 *      ruled in or out before anything is blamed on a key.
 *   3. Lists the models the key can see — this is the cheapest call OpenAI
 *      offers and it separates "key is dead" from "model name is wrong".
 *   4. Sends one real question through the service and prints the answer, or
 *      the exact upstream reason it failed.
 */

const net = require('net');
const axios = require('axios');

const question = process.argv[2] || 'How do I cancel my booking?';

function mask(v) {
  const s = String(v || '');
  if (!s) return '(empty)';
  return s.length <= 12 ? `${s.slice(0, 3)}***` : `${s.slice(0, 7)}…${s.slice(-4)}`;
}

function ok(label, value) {
  console.log(`   \x1b[32m✓\x1b[0m ${label.padEnd(38)} ${value ?? ''}`);
}
function bad(label, value) {
  console.log(`   \x1b[31m✗\x1b[0m ${label.padEnd(38)} ${value ?? ''}`);
}
function note(text) {
  console.log(`     \x1b[2m${text}\x1b[0m`);
}

/** Can this box open a socket to OpenAI at all? */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ reachable: true }));
    socket.once('timeout', () => done({ reachable: false, why: 'timed out' }));
    socket.once('error', (e) => done({ reachable: false, why: e.code || e.message }));
    socket.connect(port, host);
  });
}

async function main() {
  console.log('');

  /* 1. Configuration ------------------------------------------------------ */

  console.log('1. Config this process has\n');

  let env;
  try {
    env = require('./src/config/env');
  } catch (e) {
    bad('load src/config/env', e.message);
    note('Run this from the backend repo root, not from src/.');
    process.exit(1);
  }

  const key = env.assistant.apiKey;
  const model = env.assistant.model;

  if (key) {
    ok('OPENAI_API_KEY', mask(key));
    if (!/^sk-/.test(key)) {
      note('Does not start with "sk-" — check for a stray quote or a copied prefix.');
    }
    if (/\s/.test(key)) {
      note('Contains whitespace. A trailing newline in the .env file will 401.');
    }
  } else {
    bad('OPENAI_API_KEY', 'NOT SET');
    note('Every question fails with ASSISTANT_UNAVAILABLE. Add it to the .env this');
    note('service reads, then `pm2 restart abhicabs-web --update-env`. pm2 keeps the');
    note('old environment across a plain restart, which is why editing .env alone');
    note('often looks like it changed nothing.');
    process.exit(1);
  }

  ok('OPENAI_MODEL', model);
  ok('OPENAI_MAX_TOKENS', env.assistant.maxTokens);
  console.log('');

  /* 2. Can we reach OpenAI? ---------------------------------------------- */

  console.log('2. Network path to api.openai.com\n');

  const probe = await tcpProbe('api.openai.com', 443, 8000);
  if (probe.reachable) {
    ok('TCP 443', 'open');
  } else {
    bad('TCP 443', probe.why);
    note('Nothing else below can work. This is a security group / egress rule or a');
    note('DNS problem on the box, not a key problem. From the same shell, compare:');
    note('  curl -sS -o /dev/null -w "%{http_code}\\n" https://api.openai.com/v1/models');
    process.exit(1);
  }
  console.log('');

  /* 3. Is the key live, and does it know this model? --------------------- */

  console.log('3. Key and model, via /v1/models\n');

  try {
    const { data } = await axios.get('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000,
    });

    const ids = (data?.data || []).map((m) => m.id);
    ok('key accepted', `${ids.length} models visible`);

    if (ids.includes(model)) {
      ok(`model "${model}"`, 'available to this key');
    } else {
      bad(`model "${model}"`, 'NOT in the list for this key');
      const near = ids.filter((id) => id.startsWith('gpt-')).sort().slice(0, 8);
      note(`Closest available: ${near.join(', ') || '(none)'}`);
      note('Set OPENAI_MODEL to one of those and restart with --update-env.');
    }
  } catch (e) {
    const status = e?.response?.status;
    const oai = e?.response?.data?.error || {};
    bad('key rejected', `HTTP ${status || 'no response'} ${oai.code || ''}`);
    note(`OpenAI said: ${oai.message || e.message}`);
    if (status === 401) {
      note('The key is wrong, revoked, or belongs to a deleted project. Mint a new');
      note('one at platform.openai.com → API keys.');
    }
    if (status === 429) {
      note('Rate limited or out of credit. Check Billing → Usage. A zero balance');
      note('fails EVERY call instantly, which looks exactly like a broken key.');
    }
    process.exit(1);
  }
  console.log('');

  /* 4. A real question, through the real service ------------------------- */

  console.log('4. One real question through assistant.service\n');
  console.log(`   asking: "${question}"\n`);

  const assistant = require('./src/services/assistant.service');
  const started = Date.now();

  try {
    const result = await assistant.ask({ message: question, history: [], trip: null });
    const ms = Date.now() - started;
    ok('answered', `${ms}ms${result.offTopic ? ' (off-topic filter)' : ''}`);
    console.log('');
    console.log(`   \x1b[36m${result.reply}\x1b[0m`);
    console.log('');
    console.log('   The assistant works from this process. If the app still fails, the');
    console.log('   app is reaching a DIFFERENT backend — check API_BASE_URL in the');
    console.log('   build the phone is running.');
  } catch (e) {
    const ms = Date.now() - started;
    bad('failed', `${e.code || 'unknown'} after ${ms}ms`);
    note(`rider sees: "${e.message}"`);
    if (e.details) {
      note(`upstream:   ${JSON.stringify(e.details)}`);
    } else {
      note('Set ASSISTANT_DEBUG=1 and run again for the upstream reason, or read it');
      note('from the [assistant] line this just printed above.');
    }
  }

  console.log('');
}

main().catch((e) => {
  console.error('\n   check-assistant crashed:', e.message, '\n');
  process.exit(1);
});