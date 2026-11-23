'use strict';
// Sharing the view on screen (src/share.js, src/pick.js, app.js): the link
// carries "Show only these" with its pins, or "What does this use?", and the
// person who opens it sees the same thing, without their own pins changing
// until they choose "Keep these pins". arXiv is played by a fake. The browser
// part is skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Share = require('../src/share.js');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

test('a view goes in a link and comes back, squeezed or not', async () => {
  const view = {
    m: 'p',
    p: [['label:lem:a', 'self'], ['label:thm:main', 'uses'], ['eq:(2.1)', 'self']],
    t: [{ q: 'a passage worth keeping', a: 'before it ', b: ' after it' }],
    o: ['label:thm:main'],
  };
  const code = await Share.encodeView(view);
  assert.match(code, /^[12][A-Za-z0-9_-]+$/);
  assert.deepEqual(await Share.decodeView(code), Object.assign({}, view, { r: [], n: {} }));
  // plain base64url when nothing can squeeze
  const plain = '1' + Buffer.from(JSON.stringify({ m: 'u', f: 'label:thm:main', d: 'both', h: 1 })).toString('base64url');
  assert.deepEqual(await Share.decodeView(plain), { m: 'u', f: 'label:thm:main', d: 'both', h: 1 });
  const search = await Share.decodeView(await Share.encodeView({ m: 's', s: { inc: ['label:lem:a'], exc: ['eq:(2.1)'], any: false, direct: true } }));
  assert.deepEqual(search, { m: 's', s: { inc: ['label:lem:a'], exc: ['eq:(2.1)'], any: false, direct: true } });
  // in the link, as it is
  const url = new URL(Share.link({ arxiv: '2301.00001', view: code }));
  assert.equal(url.searchParams.get('view'), code);
  assert.equal(url.searchParams.get('goto'), null);
});

test('a link can only carry a view, and nothing in it but keys', async () => {
  const enc = (o) => '1' + Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(await Share.decodeView('garbage'), null);
  assert.equal(await Share.decodeView('1%%%'), null);
  assert.equal(await Share.decodeView(enc({ m: 'x' })), null);
  assert.equal(await Share.decodeView(enc({ m: 'p', p: [] })), null);
  assert.equal(await Share.decodeView(enc({ m: 'u', f: 'label:a', d: 'self' })), null);
  const v = await Share.decodeView(enc({ m: 'p', p: [['label:a', 'evil'], ['label:b', 'uses'], [{}, 'self'], 'eq:(1)'], t: [{ q: 'x'.repeat(500) }], extra: '<script>' }));
  assert.deepEqual(v, { m: 'p', p: [['label:b', 'uses'], ['eq:(1)', 'self']], t: [], o: [], r: [], n: {} });
  assert.equal(Share.describeView(v), '2 pinned items');
  assert.equal(Share.describeView({ m: 'u', f: 'label:thm:main', d: 'uses' }, () => 'Theorem 3'), 'what Theorem 3 uses');
  assert.equal(await Share.encodeView(null), null);
});

test('a link carries the reading order, the notes and the pin set’s name', async () => {
  const view = {
    m: 'p',
    p: [['label:lem:a', 'self'], ['eq:(2.1)', 'self']],
    t: [{ q: 'a passage worth keeping', a: '', b: '' }],
    o: [],
    r: ['t0', 'eq:(2.1)', 'label:lem:a', 'label:gone', 't7'],
    n: { 'eq:(2.1)': '  start   here ', t0: 'the key idea', 'label:gone': 'dropped', 'label:lem:a': 7 },
    s: 'For the talk',
  };
  const back = await Share.decodeView(await Share.encodeView(view));
  assert.deepEqual(back.r, ['t0', 'eq:(2.1)', 'label:lem:a'], 'only refs to what the view holds');
  assert.deepEqual(back.n, { 'eq:(2.1)': 'start here', t0: 'the key idea' });
  assert.equal(back.s, 'For the talk');
  assert.equal(Share.describeView(back), 'the pin set “For the talk” (3 pinned items)');
  const long = await Share.decodeView(await Share.encodeView({ m: 'p', p: [['label:a', 'self']], n: { 'label:a': 'x'.repeat(500) } }));
  assert.equal(long.n['label:a'].length, 200, 'a note is one line');
});

function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
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

const filler = (s) => Array.from({ length: 8 }, (_, k) => `Filler ${s} paragraph ${k} with enough words to fill a line or two of the page.`).join('\n\n');
const TEX = `\\documentclass{article}
\\usepackage{amsthm}
\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}[theorem]{Lemma}
\\title{Shared heat bounds}
\\begin{document}
\\maketitle
\\section{Tools}
${filler('a')}
\\begin{lemma}\\label{lem:a}The first tool holds.\\end{lemma}
\\begin{proof}By the first argument.\\end{proof}
\\begin{lemma}\\label{lem:b}The second tool holds.\\end{lemma}
\\begin{proof}By the second argument.\\end{proof}
${filler('b')}
\\section{Main}
A sentence with a quiet passage worth sharing in the middle.

\\begin{theorem}\\label{thm:main}The main bound holds.\\end{theorem}
\\begin{proof}Combine Lemma~\\ref{lem:a} with care.\\end{proof}
${filler('c')}
\\end{document}
`;
const TARBALL = zlib.gzipSync(tar({ 'main.tex': TEX }));

async function context(browser) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__copied.push(s); } } });
  });
  await ctx.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
  await ctx.route('https://arxiv.org/src/**', (route) => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/gzip', body: TARBALL }));
  await ctx.route(/^https?:\/\/(?!texglass\.test|arxiv\.org\/src)/, (route) => route.fulfill({ status: 503, body: '' }));
  return ctx;
}

const local = (link) => link.replace('https://klepo0.github.io/TeXglass/', 'http://texglass.test/index.html');
const shown = (page) => page.evaluate(() => {
  const vis = (el) => el && getComputedStyle(el).display !== 'none' && !el.closest('.pick-hide');
  const thm = (label) => vis(document.querySelector(`#preview .theorem[data-label="${label}"]`));
  const passage = [...document.querySelectorAll('#preview p')].find((p) => /quiet passage/.test(p.textContent));
  return { a: thm('lem:a'), b: thm('lem:b'), main: thm('thm:main'), passage: vis(passage), view: document.getElementById('preview').classList.contains('pick-view') };
});

test('Share with Show only these: the recipient sees the same pins, and keeps them only if they choose', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await playwright.chromium.launch(); } catch (e) { return t.skip('no browser: ' + e.message.split('\n')[0]); }
  try {
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://texglass.test/index.html?arxiv=2301.00001');
    await page.waitForFunction(() => /Shared heat bounds/.test(document.getElementById('preview').textContent));
    await page.waitForFunction(() => !document.getElementById('share').disabled);
    await page.hover('#preview .theorem[data-label="thm:main"]');
    await page.waitForSelector('#preview .theorem[data-label="thm:main"] .tg-pin-btn', { state: 'attached' });

    // pin the main theorem and select a passage to pin it as well
    await page.evaluate(() => document.querySelector('#preview .theorem[data-label="thm:main"] .tg-pin-btn').click());
    const para = page.locator('#preview p', { hasText: 'quiet passage' }).first();
    await para.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await para.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForSelector('.tg-hlbar:not([hidden])');
    await page.click('.tg-hlbar-pin');
    await page.waitForFunction(() => document.querySelector('#pins .tg-pins-badge').textContent === '2');

    // Show only these, then Share
    await page.click('#pins');
    await page.click('[data-pins-act="show"]');
    await page.waitForFunction(() => document.getElementById('preview').classList.contains('pick-view'));
    const before = await shown(page);
    assert.equal(before.main, true);
    assert.equal(before.b, false);
    assert.equal(before.passage, true, 'the paragraph with the pinned passage shows');
    await page.click('#share');
    await page.waitForFunction(() => window.__copied.length === 1);
    const link = (await page.evaluate(() => window.__copied))[0];
    assert.match(link, /^https:\/\/klepo0\.github\.io\/TeXglass\/\?arxiv=2301\.00001&view=[12][\w-]+$/);
    assert.match(await page.textContent('#status'), /opens with this view: \d pinned item/);
    // the bar has a Share button too
    assert.equal(await page.isVisible('.pick-bar [data-act="share"]'), true);

    // someone else opens it, with a pin of their own (Lemma 2 = lem:b)
    const ctx2 = await context(browser);
    const other = await ctx2.newPage();
    other.on('pageerror', (e) => errors.push(e.message));
    await other.goto('http://texglass.test/index.html?arxiv=2301.00001');
    await other.waitForSelector('#preview .theorem[data-label="lem:b"]');
    await other.hover('#preview .theorem[data-label="lem:b"]');
    await other.waitForSelector('#preview .theorem[data-label="lem:b"] .tg-pin-btn', { state: 'attached' });
    await other.evaluate(() => document.querySelector('#preview .theorem[data-label="lem:b"] .tg-pin-btn').click());
    await other.waitForFunction(() => /1/.test(document.querySelector('#pins .tg-pins-badge').textContent));
    await other.goto(local(link));
    await other.waitForFunction(() => document.getElementById('preview').classList.contains('pick-view'), null, { timeout: 15000 });
    const seen = await shown(other);
    assert.deepEqual({ main: seen.main, b: seen.b, passage: seen.passage }, { main: true, b: false, passage: true });
    assert.match(await other.textContent('.pick-bar'), /Shared view/);
    assert.match(await other.textContent('#status'), /view that was shared/);
    // their own pins are untouched
    assert.equal(await other.textContent('#pins .tg-pins-badge'), '1');

    // Dismiss: back to the whole paper, still one pin
    await other.click('.pick-bar [data-act="done"]');
    assert.equal((await shown(other)).view, false);
    assert.equal(await other.textContent('#pins .tg-pins-badge'), '1');

    // open it again and keep the pins: theirs and the shared ones together
    await other.goto(local(link));
    await other.waitForFunction(() => document.getElementById('preview').classList.contains('pick-view'), null, { timeout: 15000 });
    await other.click('.pick-bar [data-act="keep"]');
    await other.waitForFunction(() => +document.querySelector('#pins .tg-pins-badge').textContent >= 2);
    const kept = await shown(other);
    assert.deepEqual({ main: kept.main, b: kept.b, view: kept.view }, { main: true, b: true, view: true });
    assert.match(await other.textContent('.pick-bar'), /pinned/);
    assert.doesNotMatch(await other.textContent('.pick-bar'), /Shared view/);
    assert.deepEqual(errors, []);
    await ctx.close();
    await ctx2.close();
  } finally {
    await browser.close();
  }
});

test('Share keeps the reading order and the notes: the recipient sees the study sheet, and keeps the notes', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await playwright.chromium.launch(); } catch (e) { return t.skip('no browser: ' + e.message.split('\n')[0]); }
  try {
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://texglass.test/index.html?arxiv=2301.00001');
    await page.waitForFunction(() => !document.getElementById('share').disabled);
    for (const label of ['thm:main', 'lem:a']) {
      await page.hover(`#preview .theorem[data-label="${label}"]`);
      await page.waitForSelector(`#preview .theorem[data-label="${label}"] .tg-pin-btn`, { state: 'attached' });
      await page.evaluate((l) => document.querySelector(`#preview .theorem[data-label="${l}"] .tg-pin-btn`).click(), label);
    }
    await page.click('#pins');
    await page.click('[data-pins-view="order"]');
    await page.focus('[data-pins-drag="label:thm:main"]');
    await page.keyboard.press('ArrowDown');
    await page.click('.tg-pins-row[data-key="label:lem:a"] .tg-pins-pen');
    await page.fill('.tg-pins-memo-in', 'the tool behind it');
    await page.keyboard.press('Enter');
    await page.click('[data-pins-act="show"]');
    await page.waitForSelector('#preview .pick-sheet');
    await page.click('#share');
    await page.waitForFunction(() => window.__copied.length === 1);
    const link = (await page.evaluate(() => window.__copied))[0];
    const view = await Share.decodeView(new URL(link).searchParams.get('view'));
    assert.deepEqual(view.r, ['label:lem:a', 'label:thm:main']);
    assert.deepEqual(view.n, { 'label:lem:a': 'the tool behind it' });

    const ctx2 = await context(browser);
    const other = await ctx2.newPage();
    other.on('pageerror', (e) => errors.push(e.message));
    await other.goto(local(link));
    await other.waitForSelector('#preview.pick-view .pick-sheet', { timeout: 15000 });
    const sheet = await other.$$eval('.pick-sheet li', (li) => li.map((x) => x.textContent));
    assert.equal(sheet.length, 2);
    assert.match(sheet[0], /Lemma.*the tool behind it/);
    assert.match(sheet[1], /Theorem/);
    await other.click('.pick-bar [data-act="keep"]');
    await other.waitForFunction(() => document.querySelector('#pins .tg-pins-badge').textContent === '2');
    await other.click('#pins');
    assert.deepEqual(await other.$$eval('.tg-pins-menu .tg-pins-row', (r) => r.map((x) => x.dataset.key)), ['label:lem:a', 'label:thm:main'], 'the order came along');
    assert.equal(await other.textContent('.tg-pins-row[data-key="label:lem:a"] .tg-pins-memo'), 'the tool behind it');
    assert.deepEqual(errors, []);
    await ctx.close();
    await ctx2.close();
  } finally {
    await browser.close();
  }
});

test('Share with What does this use? and Hide the rest opens the same focus', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await playwright.chromium.launch(); } catch (e) { return t.skip('no browser: ' + e.message.split('\n')[0]); }
  try {
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://texglass.test/index.html?arxiv=2301.00001');
    await page.waitForFunction(() => !document.getElementById('share').disabled);
    await page.hover('#preview .theorem[data-label="thm:main"]');
    await page.waitForSelector('#preview .theorem[data-label="thm:main"] .uses-btn', { state: 'attached' });
    await page.evaluate(() => document.querySelector('#preview .theorem[data-label="thm:main"] .uses-btn').click());
    await page.waitForFunction(() => document.getElementById('preview').classList.contains('uses-focus'));
    await page.click('.uses-bar:not(.pick-bar) [data-act="collapse"]');
    await page.click('#share');
    await page.waitForFunction(() => window.__copied.length === 1);
    const link = (await page.evaluate(() => window.__copied))[0];
    assert.match(link, /&view=/);
    assert.match(await page.textContent('#status'), /what Theorem 3 uses/);

    const other = await ctx.newPage();
    other.on('pageerror', (e) => errors.push(e.message));
    await other.goto(local(link));
    await other.waitForFunction(() => document.getElementById('preview').classList.contains('uses-focus'), null, { timeout: 15000 });
    const st = await other.evaluate(() => ({
      collapse: document.getElementById('preview').classList.contains('uses-collapse'),
      sel: document.querySelector('#preview .theorem[data-label="thm:main"]').classList.contains('uses-sel'),
      a: document.querySelector('#preview .theorem[data-label="lem:a"]').classList.contains('uses-on'),
    }));
    assert.deepEqual(st, { collapse: true, sel: true, a: true });
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
  }
});
