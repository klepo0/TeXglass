'use strict';
// Saving papers for offline reading in the web viewer (app.js + src/library.js):
// "Save for offline" keeps an arXiv paper with its figures on the device, it
// opens from "Saved papers…" and when arXiv can't be reached, and the list
// follows the reader to another device through the notes gist. arXiv and
// api.github.com are played by fakes. Skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
// a 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const TEX = '\\documentclass{article}\n\\usepackage{graphicx}\n\\title{Saved \\emph{heat} bounds\\thanks{Thanks.}}\n\\begin{document}\n\\maketitle\n\\section{Kept offline}\nA figure:\n\n\\includegraphics{fig}\n\\end{document}\n';
const TARBALL = zlib.gzipSync(tar({ 'main.tex': TEX, 'fig.png': PNG }));

async function serve(context, arxiv) {
  await context.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
  await context.route('https://arxiv.org/src/**', (route) => {
    if (!arxiv.up) return route.abort('internetdisconnected');
    arxiv.hits++;
    route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/gzip', body: TARBALL });
  });
}

/** One gist account behind https://api.github.com, shared by every context given the same map. */
function fakeGist(context, token, gists) {
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
  });
}

const figureShown = (page) => page.waitForFunction(() => {
  const img = document.querySelector('#preview img.graphic');
  return img && img.src.startsWith('blob:') && img.complete && img.naturalWidth === 1;
});

test('saving papers for offline reading, opening them offline, and the list on another device', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const gists = new Map();
    const arxiv = { up: true, hits: 0 };
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    await serve(phone, arxiv);
    await fakeGist(phone, 'tok', gists);
    const page = await phone.newPage();
    await page.addInitScript(() => { if (!localStorage.getItem('texglass:gist-token')) localStorage.setItem('texglass:gist-token', 'tok'); });
    await page.goto('http://texglass.test/index.html?arxiv=2401.00001');
    await page.waitForFunction(() => /Kept offline/.test(document.getElementById('preview').textContent));
    await figureShown(page);

    // Save it with the toolbar button (it fits in the phone's toolbar).
    assert.equal(await page.isVisible('#save-offline'), true);
    const bar = await page.evaluate(() => {
      const b = document.getElementById('save-offline').getBoundingClientRect();
      return { right: b.right, width: innerWidth, scroll: document.querySelector('.toolbar').scrollWidth - document.querySelector('.toolbar').clientWidth };
    });
    assert.ok(bar.right <= bar.width && bar.scroll <= 0, 'the toolbar fits: ' + JSON.stringify(bar));
    assert.equal(await page.getAttribute('#save-offline', 'aria-pressed'), 'false');
    await page.screenshot({ path: process.env.LIBRARY_BAR_SHOT || path.join(require('os').tmpdir(), 'library-bar.png') });
    await page.click('#save-offline');
    await page.waitForFunction(() => document.getElementById('save-offline').getAttribute('aria-pressed') === 'true');
    assert.match(await page.textContent('#status'), /Saved for offline reading \(\d+ B\)/);
    // the … menu item says so too
    await page.click('#more');
    assert.equal(await page.getAttribute('#library-save', 'aria-checked'), 'true');
    assert.equal(await page.textContent('#library-save'), 'Saved for offline');
    await page.click('#more');

    // The list goes up to the gist (not the paper).
    const t0 = Date.now();
    const gistText = () => { const g = [...gists.values()][0]; return g ? g.files['texglass-notes.json'].content : ''; };
    while (!gistText().includes('arxiv:2401.00001') && Date.now() - t0 < 8000) await page.waitForTimeout(200);
    const inGist = JSON.parse(gistText()).papers.library;
    assert.ok(inGist, 'the list is in the gist');
    assert.equal(inGist.notes[0].id, 'arxiv:2401.00001');
    assert.equal(inGist.notes[0].anchor.title, 'Saved heat bounds');
    assert.ok(!gistText().includes('Kept offline'), 'the paper itself stays on the device');

    // Saved papers…: one paper, with its title and size.
    await page.click('#more');
    await page.click('#library-open');
    await page.waitForSelector('#library-list .library-item');
    assert.equal(await page.locator('#library-list .library-item').count(), 1);
    assert.equal(await page.textContent('#library-list .preprint-title'), 'Saved heat bounds');
    assert.match(await page.textContent('#library-list .arxiv-result-meta'), /arXiv:2401\.00001 · \d+ B · saved/);
    assert.match(await page.textContent('#library-foot'), /1 paper on this device/);
    await page.screenshot({ path: process.env.LIBRARY_SHOT || path.join(require('os').tmpdir(), 'library.png') });
    await page.click('#library-close');

    // Another paper is opened; then, with no connection, the saved one opens from the Open dialog.
    await page.evaluate(() => { localStorage.setItem('texglass:last', '\\section{Something else}'); localStorage.setItem('texglass:last-name', 'other.tex'); localStorage.setItem('texglass:last-saved', ''); });
    await page.goto('http://texglass.test/index.html');
    await page.waitForFunction(() => /Something else/.test(document.getElementById('preview').textContent));
    arxiv.up = false;
    const hits = arxiv.hits;
    await phone.setOffline(true);
    await page.click('#open');
    await page.waitForSelector('#library-recent-list .library-recent-open');
    assert.equal(await page.textContent('#library-recent-list .library-recent-title'), 'Saved heat bounds', 'the Open dialog lists the saved papers');
    await page.screenshot({ path: process.env.LIBRARY_OPEN_SHOT || path.join(require('os').tmpdir(), 'library-open.png') });
    await page.fill('#arxiv-input', '2401.00001');
    await page.press('#arxiv-input', 'Enter');
    await page.waitForFunction(() => /Kept offline/.test(document.getElementById('preview').textContent));
    await figureShown(page);
    assert.equal(arxiv.hits, hits, 'arXiv was not asked');
    assert.match(await page.textContent('#status'), /opened your saved copy/i);
    await phone.setOffline(false);

    // A reload keeps the saved copy open, figure included.
    await page.reload();
    await page.waitForFunction(() => /Kept offline/.test(document.getElementById('preview').textContent));
    await figureShown(page);

    // arXiv unreachable while online: the saved copy too.
    await page.evaluate(() => { localStorage.setItem('texglass:last-saved', ''); });
    await page.goto('http://texglass.test/index.html?arxiv=2401.00001v2');
    await page.waitForFunction(() => /Kept offline/.test(document.getElementById('preview').textContent));
    await figureShown(page);
    arxiv.up = true;

    // --- a laptop with the same gist: the paper is on the list, to download ---
    const laptop = await browser.newContext();
    await serve(laptop, arxiv);
    await fakeGist(laptop, 'tok', gists);
    const p2 = await laptop.newPage();
    await p2.addInitScript(() => { if (!localStorage.getItem('texglass:gist-token')) localStorage.setItem('texglass:gist-token', 'tok'); });
    await p2.goto('http://texglass.test/index.html');
    await p2.waitForSelector('#preview h2');
    await p2.click('#more');
    await p2.click('#library-open');
    await p2.waitForSelector('#library-list .library-elsewhere');
    assert.match(await p2.textContent('#library-list .arxiv-result-meta'), /saved on another device/);
    await p2.click('#library-list .library-download');
    await p2.waitForFunction(() => /Kept offline/.test(document.getElementById('preview').textContent));
    await p2.waitForFunction(() => document.getElementById('library-save').getAttribute('aria-checked') === 'true');
    await p2.click('#more');
    await p2.click('#library-open');
    await p2.waitForSelector('#library-list .library-item:not(.library-elsewhere)');

    // Removed on the laptop: off the list everywhere.
    await p2.click('#library-list .library-remove');
    await p2.waitForFunction(() => !document.querySelector('#library-list .library-item'));
    assert.match(await p2.textContent('#library-message'), /No saved papers yet/);
    const t1 = Date.now();
    while (JSON.parse(gistText()).papers.library.notes.length && Date.now() - t1 < 8000) await p2.waitForTimeout(200);
    assert.equal(JSON.parse(gistText()).papers.library.notes.length, 0);
  } finally {
    await browser.close();
  }
});

test('the Open dialog lists at most 5 saved papers, the most recently saved or opened first', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const ctx = await browser.newContext();
    await serve(ctx, { up: false, hits: 0 });
    const page = await ctx.newPage();
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h2');
    // seven saved papers, saved a day apart; paper 2 was opened most recently
    await page.evaluate(async () => {
      const db = await TeXglassLibrary.open();
      for (let i = 1; i <= 7; i++) {
        await db.put({ key: 'tex:p' + i + '.tex', title: 'Paper ' + i, name: 'p' + i + '.tex', source: '\\section{Paper ' + i + '}', images: {}, saved: new Date(Date.UTC(2026, 10, i)).toISOString() });
      }
      localStorage.setItem('texglass:library-opened', JSON.stringify({ 'tex:p2.tex': new Date(Date.UTC(2026, 10, 20)).toISOString() }));
    });
    await page.click('#open');
    await page.waitForFunction(() => document.querySelectorAll('#library-recent-list .library-recent-open').length === 5);
    const titles = await page.$$eval('#library-recent-list .library-recent-title', (els) => els.map((e) => e.textContent));
    assert.deepEqual(titles, ['Paper 2', 'Paper 7', 'Paper 6', 'Paper 5', 'Paper 4']);
    assert.equal(await page.textContent('#arxiv-library'), 'All saved papers (7)');
    // one opens from there
    await page.click('#library-recent-list .library-recent-open[data-key="tex:p5.tex"]');
    await page.waitForFunction(() => /Paper 5/.test(document.getElementById('preview').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('arxiv-dialog').open), false);
    assert.equal(await page.getAttribute('#save-offline', 'aria-pressed'), 'true');
    // and now comes first
    await page.click('#open');
    await page.waitForFunction(() => document.querySelector('#library-recent-list .library-recent-open').dataset.key === 'tex:p5.tex');
    // "All saved papers" opens the full list
    await page.click('#arxiv-library');
    await page.waitForFunction(() => document.getElementById('library-dialog').open);
    await page.waitForFunction(() => document.querySelectorAll('#library-list .library-item').length === 7);
  } finally {
    await browser.close();
  }
});
