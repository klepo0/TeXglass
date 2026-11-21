'use strict';
// The list of papers saved for offline reading (src/library.js): it merges
// like notes do (src/notes-sync.js), so it can ride along in the notes gist.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/library.js');
const N = require('../src/notes-sync.js');

const t1 = new Date('2026-11-01T10:00:00Z');
const t2 = new Date('2026-11-02T10:00:00Z');
const t3 = new Date('2026-11-03T10:00:00Z');

test('papers go on the list and come off it, most recent first', () => {
  let list = L.addEntry(null, { key: 'arxiv:2401.00001', title: 'First', arxiv: '2401.00001' }, t1);
  list = L.addEntry(list, { key: 'github:o/r/main.tex', title: 'Second', gh: 'https://github.com/o/r/blob/main/main.tex' }, t2);
  assert.deepEqual(L.entries(list).map((e) => e.key), ['github:o/r/main.tex', 'arxiv:2401.00001']);
  assert.equal(L.entries(list)[1].arxiv, '2401.00001');
  assert.equal(L.entries(list)[0].gh, 'https://github.com/o/r/blob/main/main.tex');
  // saving again keeps one entry, and when it was first saved
  list = L.addEntry(list, { key: 'arxiv:2401.00001', title: 'First, revised', arxiv: '2401.00001' }, t3);
  assert.equal(L.entries(list).length, 2);
  assert.equal(L.entries(list).find((e) => e.key === 'arxiv:2401.00001').title, 'First, revised');
  assert.equal(L.entries(list).find((e) => e.key === 'arxiv:2401.00001').saved, t1.toISOString());
  list = L.removeEntry(list, 'arxiv:2401.00001', t3);
  assert.deepEqual(L.entries(list).map((e) => e.key), ['github:o/r/main.tex']);
  assert.ok(list.deleted['arxiv:2401.00001']);
  // nothing to remove: unchanged
  assert.deepEqual(L.removeEntry(list, 'tex:none', t3), list);
});

test('two devices\' lists merge: saved on either is saved, removed after saving is removed', () => {
  const laptop = L.addEntry(L.addEntry(null, { key: 'arxiv:a', title: 'A' }, t1), { key: 'arxiv:b', title: 'B' }, t1);
  let phone = N.merge(L.emptyList(), laptop);
  phone = L.removeEntry(phone, 'arxiv:a', t2);
  phone = L.addEntry(phone, { key: 'arxiv:c', title: 'C' }, t2);
  const merged = N.merge(laptop, phone);
  assert.deepEqual(L.entries(merged).map((e) => e.key).sort(), ['arxiv:b', 'arxiv:c']);
  // saved again later on the laptop (after it synced): back on the list
  const again = N.merge(L.addEntry(merged, { key: 'arxiv:a', title: 'A' }, t3), phone);
  assert.deepEqual(L.entries(again).map((e) => e.key).sort(), ['arxiv:a', 'arxiv:b', 'arxiv:c']);
});

test('the list survives the gist\'s file', () => {
  const list = L.addEntry(null, { key: 'arxiv:2401.00001', title: 'On $L^2$ bounds', arxiv: '2401.00001' }, t1);
  const back = N.parseFile(N.toStore({ [L.LIST_KEY]: list, 'arxiv:x': { notes: [], deleted: {}, progress: {} } }));
  assert.deepEqual(Object.keys(back), [L.LIST_KEY]);
  assert.deepEqual(L.entries(back[L.LIST_KEY]), L.entries(list));
});

test('titles as one line of text, math left alone', () => {
  assert.equal(L.plainTitle('On the \\emph{heat} equation\\\\ on a torus\\thanks{Funded by {X}.}'), 'On the heat equation on a torus');
  assert.equal(L.plainTitle('Bounds for $\\{x_n\\}$ \\& friends'), 'Bounds for $\\{x_n\\}$ & friends');
  assert.equal(L.plainTitle(''), '');
});

test('sizes', () => {
  assert.equal(L.formatSize(500), '500 B');
  assert.equal(L.formatSize(2048), '2 KB');
  assert.equal(L.formatSize(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(L.sizeOf({ source: 'abcd', images: { a: { size: 10 } } }), 14);
});

test('no IndexedDB (Node): no saved papers, no error', async () => {
  assert.equal(await L.open(), null);
});
