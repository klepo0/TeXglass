'use strict';
// The web viewer keeps the reader's highlights and notes per paper, exports
// and imports them, and syncs them through a gist (app.js + src/notes-sync.js).
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

test('notes in the web viewer: kept per paper, exported, imported and synced through a gist', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    // --- the laptop ---
    const laptop = await browser.newContext({ acceptDownloads: true });
    await serve(laptop);
    const gists = await fakeGist(laptop, 'tok');
    const page = await laptop.newPage();
    await openDoc(page);
    assert.equal(await page.getAttribute('#notes-toggle', 'aria-checked'), 'true');
    await highlight(page, 'main difficulty');
    const s = await stored(page);
    assert.match(s.key, /^texglass:notes:tex:bounds\.tex#[0-9a-f]{8}$/);
    assert.equal(s.record.notes[0].anchor.quote, 'main difficulty');
    assert.equal(s.record.notes[0].color, 'green');

    // Kept after a reload.
    await page.reload();
    await page.waitForSelector('#preview .section, #preview h2');
    await page.waitForFunction(() => CSS.highlights.get('tg-hl-green') && CSS.highlights.get('tg-hl-green').size === 1);

    // Export.
    await page.click('#more');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#notes-export')]);
    assert.equal(dl.suggestedFilename(), 'bounds.texglass.json');
    const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    assert.equal(exported.paper, s.key.slice('texglass:notes:'.length));
    assert.equal(exported.notes.length, 1);

    // Sign in to the gist: the note goes up.
    await page.click('#more');
    await page.click('#notes-sync');
    await page.fill('#notes-sync-token', 'tok');
    await page.click('#notes-sync-go');
    // The dialog stays to say that, from now on, syncing is automatic.
    await page.waitForFunction(() => !document.getElementById('notes-sync-state').hidden);
    assert.match(await page.textContent('#notes-sync-state'), /^Syncing automatically · last synced just now$/);
    assert.match(await page.textContent('#notes-sync-message'), /Signed in/);
    assert.equal(await page.textContent('#notes-sync-go'), 'Done');
    assert.equal(await page.isVisible('#notes-sync-token'), false);
    assert.equal(await page.isVisible('#notes-sync-now'), true);
    await page.click('#notes-sync-go');
    await page.waitForFunction(() => !document.getElementById('notes-sync-dialog').open);
    // The … menu shows it is on, and its tooltip when it last synced.
    assert.match(await page.textContent('#notes-sync'), /Syncing with GitHub/);
    assert.match(await page.getAttribute('#notes-sync', 'title'), /^Syncing automatically · last synced just now/);
    // Opening the dialog again shows the state, not a sign-in form.
    await page.click('#more');
    await page.click('#notes-sync');
    assert.equal(await page.textContent('#notes-sync-title'), 'Syncing with GitHub');
    await page.click('#notes-sync-now');
    await page.waitForFunction(() => document.getElementById('notes-sync-message').textContent === 'Up to date.');
    await page.click('#notes-sync-go');
    assert.equal(gists.size, 1);
    const g = [...gists.values()][0];
    assert.ok(g.files['texglass-notes.json'].content.includes('main difficulty'));

    // --- another device: same paper, same token; gets the laptop's note and adds one ---
    const phone = await browser.newContext();
    await serve(phone);
    await fakeGist(phone, 'tok').then((m) => { for (const [k, v] of gists) m.set(k, v); });
    const p2 = await phone.newPage();
    await p2.addInitScript(() => { if (!localStorage.getItem('texglass:gist-token')) localStorage.setItem('texglass:gist-token', 'tok'); });
    await openDoc(p2);
    await p2.waitForFunction(() => CSS.highlights.get('tg-hl-green') && CSS.highlights.get('tg-hl-green').size === 1);
    await highlight(p2, 'second paragraph');
    await p2.waitForFunction(() => CSS.highlights.get('tg-hl-green').size === 2);
    // pushed a moment after the change
    const t0 = Date.now();
    while (!g.files['texglass-notes.json'].content.includes('second paragraph') && Date.now() - t0 < 8000) await p2.waitForTimeout(200);
    assert.ok(g.files['texglass-notes.json'].content.includes('second paragraph'), 'the phone pushed its note');
    // and the laptop gets it when it opens the paper again
    await page.reload();
    await page.waitForFunction(() => CSS.highlights.get('tg-hl-green') && CSS.highlights.get('tg-hl-green').size === 2);

    // Import the exported file into a fresh browser: the note appears.
    const fresh = await browser.newContext();
    await serve(fresh);
    const p3 = await fresh.newPage();
    await openDoc(p3);
    assert.equal(await stored(p3), null);
    const file = path.join(os.tmpdir(), 'tg-notes-import.json');
    fs.writeFileSync(file, JSON.stringify(exported));
    await p3.setInputFiles('#notes-file', file);
    await p3.waitForFunction(() => CSS.highlights.get('tg-hl-green') && CSS.highlights.get('tg-hl-green').size === 1);
    assert.equal((await stored(p3)).record.notes.length, 1);

    // Study tools off: no bar, notes kept.
    await p3.click('#more');
    await p3.click('#notes-toggle');
    assert.equal(await p3.getAttribute('#notes-toggle', 'aria-checked'), 'false');
    assert.equal(await p3.evaluate(() => localStorage.getItem('texglass:study')), '0');
  } finally {
    await browser.close();
  }
});
