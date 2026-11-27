'use strict';

/**
 * src/utils/safeLiteral.js
 *
 * Reads the CMS data files (src/data/blogs.js, src/data/redirects.js) WITHOUT
 * executing them. Those files have the shape
 *
 *     export const BLOGS = [ ...plain data... ];
 *
 * and are committed to the website repo by the Blog Builder. The website used
 * to read them with `new Function(...)`, which runs whatever is in the file, so
 * a bad commit could run code in every visitor's browser and in the site build.
 *
 * This parser accepts plain data only — objects, arrays, strings (including
 * back-tick strings without ${…}), numbers, true/false/null/undefined, comments
 * and trailing commas — and throws on anything else (identifiers, calls,
 * spreads, functions, template interpolation …).
 *
 * A copy of this file lives in the website repo (src/lib/safeLiteral.js); keep
 * the two in sync.
 */

class LiteralError extends Error {}

const MAX_DEPTH = 200;

function parseLiteral(text, start = 0) {
  const src = String(text);
  let i = start;

  const fail = (msg) => { throw new LiteralError(`${msg} at position ${i}`); };

  function skip() {
    for (;;) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF' || c === '\u00A0' || c === '\u2028' || c === '\u2029') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) fail('Unterminated comment');
        i = end + 2; continue;
      }
      return;
    }
  }

  function hex(n) {
    const h = src.slice(i, i + n);
    if (h.length !== n || !/^[0-9a-fA-F]+$/.test(h)) fail('Bad escape');
    i += n;
    return parseInt(h, 16);
  }

  function string() {
    const q = src[i++];
    let out = '';
    for (;;) {
      if (i >= src.length) fail('Unterminated string');
      const c = src[i++];
      if (c === q) return out;
      if (q === '`' && c === '$' && src[i] === '{') fail('Template interpolation is not allowed');
      if (c === '\\') {
        const e = src[i++];
        switch (e) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case '0': out += '\0'; break;
          case 'x': out += String.fromCharCode(hex(2)); break;
          case 'u':
            if (src[i] === '{') {
              const end = src.indexOf('}', i);
              if (end === -1) fail('Bad escape');
              const h = src.slice(i + 1, end);
              if (!/^[0-9a-fA-F]{1,6}$/.test(h)) fail('Bad escape');
              out += String.fromCodePoint(parseInt(h, 16));
              i = end + 1;
            } else out += String.fromCharCode(hex(4));
            break;
          case '\r': if (src[i] === '\n') i++; break; // line continuation
          case '\n': case '\u2028': case '\u2029': break;
          case undefined: fail('Unterminated string'); break;
          default: out += e;
        }
        continue;
      }
      if ((c === '\n' || c === '\r') && q !== '`') fail('Line break in string');
      out += c;
    }
  }

  function number() {
    const m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 400));
    if (!m) fail('Bad number');
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail('Bad number');
    return n;
  }

  function word() {
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200));
    return m ? m[0] : '';
  }

  function key() {
    const c = src[i];
    if (c === '"' || c === "'") return string();
    if (/[0-9.]/.test(c)) return String(number());
    const w = word();
    if (!w) fail('Bad object key');
    i += w.length;
    return w;
  }

  function value(depth) {
    if (depth > MAX_DEPTH) fail('Too deeply nested');
    skip();
    const c = src[i];
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skip();
        if (src[i] === ']') { i++; return arr; }
        if (src[i] === ',') fail('Holes in arrays are not allowed');
        arr.push(value(depth + 1));
        skip();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail('Expected , or ]');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        skip();
        if (src[i] === '}') { i++; return obj; }
        const k = key();
        skip();
        if (src[i] !== ':') fail('Expected :');
        i++;
        const v = value(depth + 1);
        // never let data set an object's prototype
        if (k === '__proto__') Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
        else obj[k] = v;
        skip();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail('Expected , or }');
      }
    }
    if (c === '"' || c === "'" || c === '`') return string();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return number();
    const w = word();
    if (w === 'true') { i += 4; return true; }
    if (w === 'false') { i += 5; return false; }
    if (w === 'null') { i += 4; return null; }
    if (w === 'undefined') { i += 9; return undefined; }
    return fail(w ? `Unexpected identifier "${w}"` : 'Unexpected character');
  }

  const v = value(0);
  skip();
  return { value: v, end: i };
}

/**
 * Data of `export const <name> = [ … ];` from a data file's text.
 * Only the export statement, an optional `;`, whitespace and comments may follow
 * the declaration; anything else (more code) is rejected.
 */
function parseExportedArray(text, name) {
  const src = String(text);
  const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*`).exec(src);
  if (!m) throw new LiteralError(`"export const ${name} = [...]" not found`);
  const before = src.slice(0, m.index).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
  if (before) throw new LiteralError(`Unexpected content before "export const ${name}"`);
  const { value, end } = parseLiteral(src, m.index + m[0].length);
  let rest = src.slice(end);
  if (rest.startsWith(';')) rest = rest.slice(1);
  rest = rest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
  if (rest) throw new LiteralError(`Unexpected content after "${name}"`);
  if (!Array.isArray(value)) throw new LiteralError(`${name} is not an array.`);
  return value;
}

/** The exact layout the Blog Builder has always written (JSON items inside an export). */
function serializeArray(name, arr) {
  return `export const ${name} = [\n${arr.map((r) => '  ' + JSON.stringify(r, null, 2).replace(/\n/g, '\n  ')).join(',\n')}\n];\n`;
}

module.exports = { parseLiteral, parseExportedArray, serializeArray, LiteralError };
