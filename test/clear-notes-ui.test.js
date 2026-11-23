'use strict';
// Settings → Your notes: clearing the notes of one paper or of every paper,
// and the clearing reaching another device through the gist instead of the
// old notes coming back (app.js, src/features.js, src/notes-sync.js).
// api.github.com is played by a fake here. Skipped where Playwright and a
// browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const DOC = '\\documentclass{article}\n\\title{A Paper on Bounds}\n\\begin{document}\n\\maketitle\n\\section{Intro}\nThe main difficulty is renormalisation. We work on the torus.\n\n' +
  'A second paragraph says something else entirely.\n\\end{document}\n';

async function serve(context) {
  await context.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

/** One gist account behind https://api.github.com, shared by every page of the test. */
function fakeGist(context, token) {
  const gists = new Map();
  return context.route('https://api.github.com/**', (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (status, body) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.headers().authorization !== 'Bearer ' + token) return json(401, {});
    const u = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    if (u.pathname === '/gists' && req.method() === 'GET') return json(200, [...gists.values()]);
    if (u.pathname === '/gists' && req.method() === 'POST') {
      const g = { id: 'g' + (gists.size + 1), files: {} };
      for (const [f, v] of Object.entries(body.files)) g.files[f] = { content: v.content };
      gists.set(g.id, g);
      return json(201, g);
    }
    const g = gists.get(u.pathname.split('/')[2]);
    if (!g) return json(404, {});
    if (req.method() === 'PATCH') for (const [f, v] of Object.entries(body.files)) g.files[f] = { content: v.content };
    return json(200, g);
  }).then(() => gists);
}

async function openDoc(page) {
  await page.addInitScript((doc) => {
    if (!localStorage.getItem('texglass:last')) {
      localStorage.setItem('texglass:last', doc);
      localStorage.setItem('texglass:last-name', 'bounds.tex');
    }
  }, DOC);
  await page.goto('http://texglass.test/index.html');
  await page.waitForSelector('#preview .section, #preview h2');
}

async function highlight(page, words) {
  await page.evaluate((w) => {
    const p = [...document.querySelectorAll('#preview p')].find((x) => x.textContent.includes(w));
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode()) && !t.data.includes(w));
    const r = document.createRange();
    r.setStart(t, t.data.indexOf(w));
    r.setEnd(t, t.data.indexOf(w) + w.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    p.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  }, words);
  await page.waitForFunction(() => !document.querySelector('.tg-hlbar').hidden);
  await page.click('.tg-hlbar .tg-swatch[data-color="green"]');
}

const stored = (page) => page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('texglass:notes:'));
  return k ? { key: k, record: JSON.parse(localStorage.getItem(k)) } : null;
});


const greens = (page) => page.evaluate(() => (CSS.highlights.get('tg-hl-green') ? CSS.highlights.get('tg-hl-green').size : 0));
const gistPapers = (g) => JSON.parse(g.files['texglass-notes.json'].content).papers;

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (!(await fn()) && Date.now() - t0 < (ms || 8000)) await new Promise((r) => setTimeout(r, 200));
  return fn();
}

/** Settings → one of the Clear buttons → untick some kinds → Clear. Resolves to the message shown. */
async function clearFromSettings(page, scope, untick) {
  await page.click('#settings');
  await page.click(`.features-clear [data-scope="${scope}"]`);
  await page.waitForFunction(() => !document.querySelector('.clear-confirm').hidden);
  for (const p of untick || []) await page.uncheck(`.clear-confirm input[data-part="${p}"]`);
  await page.click('.clear-go');
  await page.waitForFunction(() => {
    const t = document.querySelector('.clear-done').textContent;
    return t && t !== 'Clearing…';
  });
  const msg = await page.textContent('.clear-done');
  await page.click('.features-done');
  return msg;
}

test('Settings clears one paper or every paper, and the clearing syncs instead of the notes coming back', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const signedIn = () => { if (!localStorage.getItem('texglass:gist-token')) localStorage.setItem('texglass:gist-token', 'tok'); };
    const laptop = await browser.newContext();
    await serve(laptop);
    const gists = await fakeGist(laptop, 'tok');
    const page = await laptop.newPage();
    await page.addInitScript(signedIn);
    await openDoc(page);

    // Nothing open in the panel but the two buttons; nothing made yet.
    await page.click('#settings');
    assert.equal(await page.isVisible('.features-clear [data-scope="paper"]'), true);
    assert.equal(await page.isVisible('.features-clear [data-scope="all"]'), true);
    assert.equal(await page.isVisible('.clear-confirm'), false);
    await page.click('.features-clear [data-scope="paper"]');
    await page.waitForFunction(() => document.querySelector('.clear-summary').textContent);
    assert.equal(await page.textContent('.clear-summary'), 'You have made nothing on this paper yet.');
    await page.click('.clear-cancel');
    assert.equal(await page.isVisible('.clear-confirm'), false);
    await page.click('.features-done');

    await highlight(page, 'main difficulty');
    await highlight(page, 'second paragraph');
    assert.equal(await greens(page), 2);
    // pushed to the gist a moment later
    const g = await waitFor(() => gists.size && [...gists.values()][0]);
    assert.ok(await waitFor(() => JSON.stringify(gistPapers(g)).includes('second paragraph')));
    // A paper this browser never opened, kept only in the gist, and the saved-papers list.
    const papers = gistPapers(g);
    papers['arxiv:2601.00001'] = { title: 'Elsewhere', notes: [{ id: 'far', anchor: { quote: 'far away' }, created: '2026-01-01T00:00:00.000Z' }] };
    papers.library = { title: 'Saved papers', notes: [{ id: 'arxiv:2601.00001', kind: 'saved', anchor: { title: 'Elsewhere' }, created: '2026-01-01T00:00:00.000Z' }] };
    g.files['texglass-notes.json'].content = JSON.stringify({ version: 1, papers });

    // --- the phone gets the notes ---
    const phone = await browser.newContext();
    await serve(phone);
    await fakeGist(phone, 'tok').then((m) => { for (const [k, v] of gists) m.set(k, v); });
    const p2 = await phone.newPage();
    await p2.addInitScript(signedIn);
    await openDoc(p2);
    await p2.waitForFunction(() => CSS.highlights.get('tg-hl-green') && CSS.highlights.get('tg-hl-green').size === 2);

    // --- the laptop clears this paper ---
    await page.click('#settings');
    await page.click('.features-clear [data-scope="paper"]');
    await page.waitForFunction(() => /2 highlights and notes/.test(document.querySelector('.clear-summary').textContent));
    await page.click('.clear-cancel');
    await page.click('.features-done');
    assert.match(await clearFromSettings(page, 'paper'), /^Cleared this paper\.$/);
    assert.equal(await greens(page), 0);
    // The gist remembers them as deleted ...
    const mine = Object.keys(gistPapers(g)).find((k) => k.startsWith('tex:bounds.tex'));
    assert.deepEqual(gistPapers(g)[mine].notes, []);
    assert.equal(Object.keys(gistPapers(g)[mine].deleted).length, 2);
    // ... so the phone, which still has them, loses them instead of bringing them back.
    await p2.reload();
    await p2.waitForSelector('#preview .section, #preview h2');
    assert.ok(await waitFor(async () => (await greens(p2)) === 0), 'cleared on the phone too');
    await p2.waitForTimeout(500);
    assert.deepEqual(gistPapers(g)[mine].notes, [], 'and not pushed back from the phone');

    // --- clear all, but only progress: notes stay ---
    await highlight(page, 'main difficulty');
    assert.ok(await waitFor(() => gistPapers(g)[mine].notes.length === 1));
    assert.match(await clearFromSettings(page, 'all', ['notes', 'pins']), /^Cleared 2 papers, here and on GitHub\.$/);
    assert.equal(await greens(page), 1, 'only reading progress was to go');
    assert.equal(gistPapers(g)['arxiv:2601.00001'].notes.length, 1);
    // An unticked box everywhere: nothing to clear.
    await page.click('#settings');
    await page.click('.features-clear [data-scope="all"]');
    for (const p of ['notes', 'pins', 'progress']) await page.uncheck(`.clear-confirm input[data-part="${p}"]`);
    assert.equal(await page.isDisabled('.clear-go'), true);
    await page.click('.clear-cancel');
    await page.click('.features-done');

    // --- clear everything ---
    await page.click('#settings');
    await page.click('.features-clear [data-scope="all"]');
    await page.waitForFunction(() => /in 2 papers/.test(document.querySelector('.clear-summary').textContent) || /in 1 paper\./.test(document.querySelector('.clear-summary').textContent));
    assert.match(await page.textContent('.clear-summary'), /gist are cleared too/);
    await page.click('.clear-cancel');
    await page.click('.features-done');
    assert.match(await clearFromSettings(page, 'all'), /^Cleared 2 papers, here and on GitHub\.$/);
    assert.equal(await greens(page), 0);
    const after = gistPapers(g);
    assert.deepEqual(after['arxiv:2601.00001'].notes, [], 'a paper kept only in the gist is cleared too');
    assert.ok(after['arxiv:2601.00001'].deleted.far);
    assert.deepEqual(after[mine].notes, []);
    assert.equal(after.library.notes.length, 1, 'the saved-papers list stays');
    await p2.reload();
    await p2.waitForSelector('#preview .section, #preview h2');
    await p2.waitForTimeout(800);
    assert.equal(await greens(p2), 0);
    assert.deepEqual(gistPapers(g)[mine].notes, []);

    // Signed in, but GitHub cannot be reached: clear all clears nothing.
    await highlight(page, 'second paragraph');
    assert.ok(await waitFor(() => gistPapers(g)[mine].notes.length === 1));
    await laptop.unroute('https://api.github.com/**');
    await laptop.route('https://api.github.com/**', (route) => route.abort());
    assert.match(await clearFromSettings(page, 'all'), /^Nothing was cleared: Could not reach GitHub/);
    assert.equal(await greens(page), 1);
  } finally {
    await browser.close();
  }
});
