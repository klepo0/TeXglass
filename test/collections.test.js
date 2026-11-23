'use strict';
// Collections (src/collections.js): pins gathered from several papers, kept in
// one list that merges like notes through the gist.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/collections.js');
const NotesSync = require('../src/notes-sync.js');

const T1 = new Date('2026-11-23T10:00:00Z');
const T2 = new Date('2026-11-23T11:00:00Z');
const A = { paper: 'arxiv:2601.00001', title: 'Paper A', arxiv: '2601.00001' };
const B = { paper: 'tex:abc', title: 'Paper B' };

test('add keeps order, updates in place, and lists by collection', () => {
  let l = C.add(C.emptyList(), 'Talk', [Object.assign({ key: 'label:thm', name: 'Theorem 1' }, A), Object.assign({ key: 'eq:(2)', name: 'Equation (2)' }, A)], T1);
  l = C.add(l, 'Talk', [Object.assign({ key: 'label:main', name: 'Theorem 3.1', note: 'the key step' }, B)], T1);
  l = C.add(l, 'Review', [Object.assign({ key: 'label:main', name: 'Theorem 3.1' }, B)], T1);
  assert.deepEqual(C.items(l, 'Talk').map((x) => x.name), ['Theorem 1', 'Equation (2)', 'Theorem 3.1']);
  assert.deepEqual(C.names(l), [{ name: 'Review', size: 1, papers: 1 }, { name: 'Talk', size: 3, papers: 2 }]);
  assert.equal(C.items(l, 'Talk')[2].note, 'the key step');
  assert.equal(C.items(l, 'Talk')[0].arxiv, '2601.00001');
  // again: the same place, the name brought up to date
  l = C.add(l, 'Talk', [Object.assign({ key: 'label:thm', name: 'Theorem 1.1' }, A)], T2);
  assert.deepEqual(C.items(l, 'Talk').map((x) => x.name), ['Theorem 1.1', 'Equation (2)', 'Theorem 3.1']);
  const id = C.idOf('Talk', A.paper, 'eq:(2)');
  assert.equal(C.byId(l, id).name, 'Equation (2)');
  l = C.remove(l, [id], T2);
  assert.equal(C.items(l, 'Talk').length, 2);
  assert.ok(l.deleted[id]);
  l = C.removeCollection(l, 'Review', T2);
  assert.deepEqual(C.names(l).map((x) => x.name), ['Talk']);
});

test('two devices merge like notes', () => {
  const base = C.add(C.emptyList(), 'Talk', [Object.assign({ key: 'label:thm', name: 'Theorem 1' }, A)], T1);
  const one = C.add(base, 'Talk', [Object.assign({ key: 'label:main', name: 'Theorem 3.1' }, B)], T2);
  const two = C.remove(base, [C.idOf('Talk', A.paper, 'label:thm')], T2);
  const m = NotesSync.merge(one, two);
  assert.deepEqual(C.items(m, 'Talk').map((x) => x.name), ['Theorem 3.1']);
});
