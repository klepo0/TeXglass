'use strict';
// The reader's notes as a portable file, merged by note id, and synced
// through a private gist (src/notes-sync.js). The gist is played by a fake
// api.github.com here; no request leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/notes-sync.js');

const note = (id, extra) => Object.assign({ id, anchor: { quote: id, prefix: '', suffix: '' }, created: '2026-01-01T00:00:00.000Z' }, extra);
const at = (iso) => new Date(iso);

test('a paper has the same key on every device', () => {
  assert.equal(S.paperKey({ name: 'arXiv-2301.00001v3.tex' }), 'arxiv:2301.00001');
  assert.equal(S.paperKey({ arxiv: '2301.00001' }), 'arxiv:2301.00001');
  assert.equal(S.paperKey({ name: 'arXiv-math-0501001v1.tex' }), 'arxiv:math-0501001');
  assert.equal(S.paperKey({ github: 'me/thesis/ch1/main.tex', name: 'main.tex' }), 'github:me/thesis/ch1/main.tex');
  const src = '\\documentclass{article}\n\\title{On   a\n  Bound}% draft\n\\begin{document}x\\end{document}';
  const k = S.paperKey({ name: 'C:\\papers\\main.tex', source: src });
  assert.match(k, /^tex:main\.tex#[0-9a-f]{8}$/);
  // the same title, laid out differently, in a file of the same name elsewhere
  assert.equal(S.paperKey({ name: 'main.tex', source: '\\title{On a Bound}' }), k);
  assert.notEqual(S.paperKey({ name: 'main.tex', source: '\\title{Another}' }), k);
  assert.equal(S.paperKey({ name: 'notes.tex', source: 'no title' }), 'tex:notes.tex');
  assert.equal(S.paperKey({ name: 'welcome.tex' }), null);
  assert.equal(S.paperKey({}), null);
  assert.equal(S.titleOf('\\title[Short]{A {nested} title}'), 'A {nested} title');
});

test('track stamps changed notes and remembers deleted ones', () => {
  let r = S.empty('arxiv:1');
  r = S.track(r, [note('a'), note('b')], at('2026-02-01T00:00:00Z'));
  assert.deepEqual(r.notes.map((n) => n.updated), ['2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
  // b is edited, a is not; then a is deleted
  r = S.track(r, [note('a'), note('b', { note: 'why?' })], at('2026-02-02T00:00:00Z'));
  assert.deepEqual(r.notes.map((n) => n.updated), ['2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z']);
  r = S.track(r, [r.notes[1]], at('2026-02-03T00:00:00Z'));
  assert.deepEqual(r.notes.map((n) => n.id), ['b']);
  assert.deepEqual(r.deleted, { a: '2026-02-03T00:00:00.000Z' });
});

test('two devices editing at once: merged by id, later edits win, deletions stick', () => {
  const now = at('2026-03-01T00:00:00Z');
  const base = S.track(S.empty('k'), [note('a'), note('b'), note('c')], at('2026-02-01T00:00:00Z'));
  // laptop: edits a, deletes b, adds d
  const laptop = S.track(base, [note('a', { note: 'laptop' }), note('c'), note('d')], at('2026-02-10T00:00:00Z'));
  // phone: edits a later, edits c, adds e
  const phone = S.track(base, [note('a', { note: 'phone' }), note('b'), note('c', { color: 'pink' }), note('e')], at('2026-02-11T00:00:00Z'));
  const m1 = S.merge(laptop, phone, now);
  const m2 = S.merge(phone, laptop, now);
  const ids = (r) => r.notes.map((n) => n.id).sort();
  assert.deepEqual(ids(m1), ['a', 'c', 'd', 'e']);
  assert.deepEqual(ids(m2), ids(m1));
  assert.ok(S.equal(m1, m2));
  assert.equal(m1.notes.find((n) => n.id === 'a').note, 'phone');
  assert.equal(m1.notes.find((n) => n.id === 'c').color, 'pink');
  assert.ok(m1.deleted.b);
  // a note changed after another device deleted it comes back
  const revived = S.track(base, [note('b', { note: 'still needed' })], at('2026-02-20T00:00:00Z'));
  const m3 = S.merge(m1, revived, now);
  assert.ok(m3.notes.some((n) => n.id === 'b'));
  assert.equal(m3.deleted.b, undefined);
  // old deletions are forgotten
  assert.deepEqual(S.merge({ notes: [], deleted: { z: '2025-01-01T00:00:00Z' } }, null, now).deleted, {});
});

test('the file: one paper, a bare list, or many papers', () => {
  const r = S.track(S.empty('arxiv:2301.00001', 'A title'), [note('a')], at('2026-02-01T00:00:00Z'));
  const back = S.parseFile(S.toFile(r));
  assert.deepEqual(Object.keys(back), ['arxiv:2301.00001']);
  assert.equal(back['arxiv:2301.00001'].title, 'A title');
  assert.equal(back['arxiv:2301.00001'].notes[0].id, 'a');
  // VS Code's older paper.texglass.json had no key: the caller's is used
  const old = JSON.stringify({ version: 1, notes: [note('x'), { bad: true }] });
  assert.deepEqual(Object.keys(S.parseFile(old, 'tex:p.tex')), ['tex:p.tex']);
  assert.equal(S.parseFile(old, 'tex:p.tex')['tex:p.tex'].notes.length, 1);
  assert.equal(S.parseFile(JSON.stringify([note('y')]), 'k').k.notes[0].id, 'y');
  const store = S.parseFile(S.toStore({ p1: r, p2: S.empty('p2') }));
  assert.deepEqual(Object.keys(store), ['p1']); // empty papers are left out
  assert.throws(() => S.parseFile('{"hello": 1}'), /not a TeXglass notes file/);
  assert.throws(() => S.parseFile('nope'), SyntaxError);
});

/** A fake api.github.com with one account's gists. */
function fakeGitHub(token) {
  const gists = new Map();
  let n = 0;
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  async function fetch(url, init) {
    const method = (init && init.method) || 'GET';
    calls.push(method + ' ' + url.replace('https://api.github.com', ''));
    if (init.headers.Authorization !== 'Bearer ' + token) return reply(401, {});
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === '/gists' && method === 'GET') return reply(200, [...gists.values()].map((g) => ({ id: g.id, files: Object.fromEntries(Object.keys(g.files).map((f) => [f, {}])) })));
    if (u.pathname === '/gists' && method === 'POST') {
      assert.equal(body.public, false);
      const g = { id: 'g' + ++n, files: {} };
      for (const [f, v] of Object.entries(body.files)) g.files[f] = { content: v.content };
      gists.set(g.id, g);
      return reply(201, g);
    }
    const m = /^\/gists\/(\w+)$/.exec(u.pathname);
    const g = m && gists.get(m[1]);
    if (!g) return reply(404, {});
    if (method === 'GET') return reply(200, g);
    if (method === 'PATCH') {
      for (const [f, v] of Object.entries(body.files)) g.files[f] = { content: v.content };
      return reply(200, g);
    }
    return reply(405, {});
  }
  return { fetch, gists, calls };
}

test('sync through a private gist: made once, found again, merged both ways', async () => {
  const gh = fakeGitHub('t0k');
  const laptop = S.gist('t0k', { fetch: gh.fetch });
  const a = S.track(S.empty('arxiv:1'), [note('a')], at('2026-02-01T00:00:00Z'));
  const out1 = await laptop.sync('arxiv:1', a);
  assert.deepEqual(out1.notes.map((x) => x.id), ['a']);
  assert.equal(gh.gists.size, 1);
  assert.ok(gh.gists.get(laptop.id()).files['texglass-notes.json'].content.includes('"arxiv:1"'));

  // Another device finds the same gist, adds a note, and gets the laptop's.
  const phone = S.gist('t0k', { fetch: gh.fetch });
  const b = S.track(S.empty('arxiv:1'), [note('b')], at('2026-02-02T00:00:00Z'));
  const out2 = await phone.sync('arxiv:1', b);
  assert.equal(gh.gists.size, 1);
  assert.deepEqual(out2.notes.map((x) => x.id).sort(), ['a', 'b']);
  // and the laptop now sees both
  const out3 = await laptop.sync('arxiv:1', out1);
  assert.deepEqual(out3.notes.map((x) => x.id).sort(), ['a', 'b']);

  // Nothing new: no write.
  const before = gh.calls.filter((c) => c.startsWith('PATCH')).length;
  await laptop.sync('arxiv:1', out3);
  assert.equal(gh.calls.filter((c) => c.startsWith('PATCH')).length, before);

  // Every paper at once.
  const all = await phone.sync(null, { 'tex:x.tex': S.track(S.empty('tex:x.tex'), [note('x')], at('2026-02-03T00:00:00Z')) });
  assert.deepEqual(Object.keys(all), ['tex:x.tex']);
  assert.deepEqual(Object.keys(await laptop.read()).sort(), ['arxiv:1', 'tex:x.tex']);
});

test('sync: a wrong token says so, and a deleted gist is made again', async () => {
  const gh = fakeGitHub('right');
  await assert.rejects(S.gist('wrong', { fetch: gh.fetch }).sync('k', S.empty('k')), (e) => e.auth && /Sign in again/.test(e.message));
  const g = S.gist('right', { fetch: gh.fetch, gistId: 'gone' });
  const out = await g.sync('k', S.track(S.empty('k'), [note('a')]));
  assert.equal(out.notes.length, 1);
  assert.notEqual(g.id(), 'gone');
  assert.equal(gh.gists.size, 1);
});

test('reading progress rides along: merged result by result, later wins, kept in files and the gist', () => {
  const a = Object.assign(S.empty('arxiv:1'), {
    progress: { 'label:lem:a': { s: 'read', t: '2026-11-01T00:00:00Z' }, 'label:thm': { s: 'skimmed', q: true, t: '2026-11-03T00:00:00Z' } },
  });
  const b = Object.assign(S.empty('arxiv:1'), {
    progress: { 'label:lem:a': { s: 'understood', t: '2026-11-02T00:00:00Z' }, 'label:thm': { s: 'read', t: '2026-11-02T00:00:00Z' }, bad: { s: 'nonsense' } },
  });
  const m = S.merge(a, b);
  assert.deepEqual(m.progress, {
    'label:lem:a': { s: 'understood', t: '2026-11-02T00:00:00Z' },
    'label:thm': { s: 'skimmed', q: true, t: '2026-11-03T00:00:00Z' },
  });
  assert.equal(S.equal(m, a), false);
  assert.equal(S.equal(m, S.merge(m, a)), true);
  // a record with only progress is worth keeping, and survives a file and the gist's store
  assert.equal(S.isEmpty(m), false);
  assert.equal(S.isEmpty(S.empty('x')), true);
  const back = S.parseFile(S.toFile(m), 'arxiv:1')['arxiv:1'];
  assert.deepEqual(back.progress, m.progress);
  const store = S.parseFile(S.toStore({ 'arxiv:1': m }));
  assert.deepEqual(store['arxiv:1'].progress, m.progress);
  // notes changing do not lose it
  const tracked = S.track(m, []);
  assert.deepEqual(tracked.progress, m.progress);
});

test('the map changes ride along with the notes and merge entry by entry', () => {
  const N = require('../src/notes-sync.js');
  const a = { notes: [], map: {
    pos: { 'label:a': { x: 10, y: 20, t: '2026-01-01T00:00:00Z' } },
    pin: { 'label:main': { d: 'uses', t: '2026-01-01T00:00:00Z' }, bogus: { d: 'sideways' } },
    view: { Proof: { p: { 'label:main': 'uses', 'eq:(2)': 'self' }, t: '2026-01-01T00:00:00Z' } },
  } };
  const b = { notes: [], map: {
    pos: { 'label:a': { t: '2026-01-02T00:00:00Z' } }, // moved back later on another device
    pin: { 'label:main': { d: '', t: '2025-12-01T00:00:00Z' } }, // an older unpin loses
    link: { 'label:b > label:main': { s: 'add', t: '2026-01-01T00:00:00Z' }, nolink: { s: 'add' } },
  } };
  const m = N.merge(a, b).map;
  assert.equal(m.pos['label:a'].x, undefined);
  assert.equal(m.pin['label:main'].d, 'uses');
  assert.equal(m.pin.bogus, undefined);
  assert.equal(m.link['label:b > label:main'].s, 'add');
  assert.equal(m.link.nolink, undefined);
  assert.deepEqual(m.view.Proof.p, { 'label:main': 'uses', 'eq:(2)': 'self' });
  assert.equal(N.isEmpty({ notes: [], map: {} }), true);
  assert.equal(N.isEmpty({ notes: [], map: { pin: { k: { d: 'self' } } } }), false);
  const back = Object.values(N.parseFile(N.toFile({ paper: 'tex:x', notes: [], map: m })))[0];
  assert.deepEqual(back.map, N.cleanMap(m));
  assert.ok(!N.equal({ notes: [], map: {} }, { notes: [], map: m }));
  const store = JSON.parse(N.toStore({ k: { notes: [], map: m } }));
  assert.ok(store.papers.k.map.view.Proof);
});

test('pin sets, the reading order and notes on pins ride along too', () => {
  const N = require('../src/notes-sync.js');
  const a = { notes: [], map: {
    pin: { 'm:R': { d: 'self', t: '2026-01-01T00:00:00Z' } }, // a Notation row is a pin like the others
    note: { 'label:main': { n: '  start   here ', o: 1, t: '2026-01-01T00:00:00Z' }, 'text:n1': { n: 'x'.repeat(300), o: 0, t: '2026-01-01T00:00:00Z' } },
    view: { Talk: { p: { 'label:main': 'self', 'm:R': 'self' }, x: ['n1', 'n1', 7], o: ['text:n1', 'label:main'], t: '2026-01-01T00:00:00Z' } },
  } };
  const b = { notes: [], map: {
    note: { 'label:main': { n: 'start with the proof', o: 'first', t: '2026-01-02T00:00:00Z' } }, // later wins; a bad order goes
  } };
  const m = N.merge(a, b).map;
  assert.deepEqual(m.pin['m:R'], { d: 'self', t: '2026-01-01T00:00:00Z' });
  assert.deepEqual(m.note['label:main'], { n: 'start with the proof', o: null, t: '2026-01-02T00:00:00Z' });
  assert.equal(m.note['text:n1'].n.length, 200, 'a note is one line');
  assert.deepEqual(m.view.Talk.x, ['n1'], 'passages by id, once');
  assert.deepEqual(m.view.Talk.o, ['text:n1', 'label:main']);
  assert.deepEqual(N.cleanMap({ note: { k: { n: 'a\nb' } } }).note.k, { n: 'a b', o: null });
});
