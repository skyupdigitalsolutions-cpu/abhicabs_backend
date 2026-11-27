/**
 * tests/cmsSafeLiteral.test.js — the CMS data-file parser must accept data and reject code.
 * Pure unit test: no database needed.
 */
import { describe, it, expect } from 'vitest';
import lit from '../src/utils/safeLiteral.js';

const { parseExportedArray, serializeArray } = lit;

describe('parseExportedArray', () => {
  it('reads what the CMS writes', () => {
    const arr = [{ id: 1, slug: 'a', sections: [{ type: 'p', text: 'Hi "there"\n' }] }];
    expect(parseExportedArray(serializeArray('BLOGS', arr), 'BLOGS')).toEqual(arr);
  });
  it('reads older JS-style literals', () => {
    const src = "// c\nexport const BLOGS = [{ id: 1, slug: 'a', t: `x`, n: -1.5e2, u: undefined, tags: ['a',], },];";
    expect(parseExportedArray(src, 'BLOGS')[0]).toMatchObject({ id: 1, slug: 'a', t: 'x', n: -150, tags: ['a'] });
  });
  it('rejects code', () => {
    for (const src of [
      'export const BLOGS = [alert(1)];',
      'export const BLOGS = [{ a: fetch("x") }];',
      'export const BLOGS = [`${alert(1)}`];',
      'export const BLOGS = [...x];',
      'export const BLOGS = [];\nalert(1);',
      'import x from "y";\nexport const BLOGS = [];',
      'export const BLOGS = [function(){}];',
    ]) expect(() => parseExportedArray(src, 'BLOGS')).toThrow();
  });
  it('never sets an object prototype from data', () => {
    const [o] = parseExportedArray('export const BLOGS = [{ "__proto__": { "polluted": true } }];', 'BLOGS');
    expect(o.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
  });
});
