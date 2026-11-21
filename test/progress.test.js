'use strict';
// Reading progress (src/progress.js): what to read next, and the counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/progress.js');

const r = (key, style) => ({ key, name: key, style: style || 'plain' });

test('statuses step round: unread, skimmed, read, understood, unread', () => {
  assert.deepEqual(['unread', 'skimmed', 'read', 'understood'].map(P.nextStatus), ['skimmed', 'read', 'understood', 'unread']);
  assert.equal(P.nextStatus(undefined), 'skimmed');
});

test('read next: unread first, then the result most others rest on, then the earliest', () => {
  const list = [r('a'), r('b'), r('c', 'remark'), r('d'), r('e')];
  const map = { a: { s: 'understood' }, d: { s: 'skimmed' } };
  const deps = { a: 9, b: 1, c: 5, d: 7, e: 3 };
  const ranked = P.rankNext(list, (k) => map[k], (x) => deps[x.key]);
  assert.deepEqual(ranked.map((x) => x.r.key), ['e', 'b', 'c', 'd']);
  assert.equal(ranked[0].count, 3);
  assert.equal(ranked[3].tier, 1);
  // all understood: nothing left
  assert.deepEqual(P.rankNext([r('a')], () => ({ s: 'understood' }), () => 0), []);
});

test('tally counts each status and the ? flags', () => {
  const t = P.tally([r('a'), r('b'), r('c')], (k) => ({ a: { s: 'read', q: true }, b: { s: 'understood' } })[k]);
  assert.deepEqual(t, { unread: 1, skimmed: 0, read: 1, understood: 1, q: 1, total: 3 });
});
