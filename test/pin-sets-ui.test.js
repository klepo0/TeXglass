'use strict';
// Pin sets, the reading order and notes on pins (src/pins.js, src/insight.js,
// src/pick.js): one pin model for the map's pins and the Notation tab's; the
// Pinned list saves and switches sets, puts pins in order (drag, or ↑ ↓) and
// takes a one-line note on each; Show only these becomes a study sheet. Kept
// with the notes. Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');

/** The pin opens the side panel's Pins tab; a second click would close it again. */
async function openPins(page) {
  if (!(await page.isVisible('.side-pins'))) await page.click('#pins');
  await page.waitForSelector('.side-pins', { state: 'visible' });
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const DOC = '\\documentclass{article}\n\\title{Sets}\n\\newtheorem{lemma}{Lemma}[section]\n\\newtheorem{theorem}[lemma]{Theorem}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n\\maketitle\n\\section{Start}\n' +
  'Let $f\\colon \\R \\to \\R$ be smooth.\n\\begin{equation}\\label{eq:a} a = b \\end{equation}\n' +
  '\\begin{lemma}[Bound]\\label{first} First.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  '\\begin{lemma}\\label{second} Second.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  '\\begin{theorem}\\label{main} Last.\\end{theorem}\\begin{proof} By Lemmas~\\ref{first} and~\\ref{second}.\\end{proof}\n\\end{document}';

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

test('pin sets, a reading order and notes in the Pinned list, and the study sheet', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serve(page);
    const open = async () => {
      await page.goto('http://texglass.test/index.html');
      await page.waitForSelector('#preview h1, #preview h2, #preview .section');
      await page.setInputFiles('#file-input', { name: 'sets.tex', mimeType: 'text/x-tex', buffer: Buffer.from(DOC) });
      await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 3);
    };
    await open();
    const badge = () => page.$eval('#pins .tg-pins-badge', (b) => (b.hidden ? '' : b.textContent));
    const pinThm = async (label) => {
      await page.hover(`#preview .theorem[data-label="${label}"]`);
      await page.waitForSelector(`#preview .theorem[data-label="${label}"] .tg-pin-btn`, { state: 'attached' });
      await page.evaluate((l) => document.querySelector(`#preview .theorem[data-label="${l}"] .tg-pin-btn`).click(), label);
    };
    const rows = () => page.$$eval('.side-pins .tg-pins-row', (rs) => rs.map((r) => r.dataset.key));

    // pin two results and the equation
    await pinThm('main');
    await pinThm('first');
    await page.hover('#preview .math-display:has-text("(1)")');
    await page.waitForSelector('#preview .math-display .tg-pin-btn', { state: 'attached' });
    await page.evaluate(() => document.querySelector('#preview .math-display .tg-pin-btn').click());
    assert.equal(await badge(), '3');

    // the list: by kind first; In order gives one list with handles
    await openPins(page);
    assert.equal(await page.getAttribute('[data-pins-view="kind"]', 'aria-pressed'), 'true');
    assert.equal(await page.locator('.tg-pins-drag').count(), 0);
    await page.click('[data-pins-view="order"]');
    assert.equal(await page.locator('.tg-pins-drag').count(), 3);
    // before any reordering: the paper's order, not the order they were pinned in
    assert.deepEqual(await rows(), ['eq:(1)', 'label:first', 'label:main']);
    // ↑ on a handle moves it up, and it keeps the focus
    await page.focus('[data-pins-drag="label:main"]');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.deepEqual(await rows(), ['label:main', 'eq:(1)', 'label:first']);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.pinsDrag), 'label:main');
    // drag Lemma 1.1 to the top
    const h = await page.locator('[data-pins-drag="label:first"]').boundingBox();
    const top = await page.locator('.tg-pins-row').first().boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, top.y + 3, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await rows(), ['label:first', 'label:main', 'eq:(1)']);

    // a one-line note
    await page.click('.tg-pins-row[data-key="label:main"] .tg-pins-pen');
    await page.fill('.tg-pins-memo-in', 'start the talk here');
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('.tg-pins-row[data-key="label:main"] .tg-pins-memo'), 'start the talk here');
    assert.equal(await page.isVisible('.side-pins'), true, 'Enter keeps the list open');

    // save as a set; change the pins; Update and switching back
    await page.click('[data-pins-act="save"]');
    await page.fill('.tg-pins-set-name', 'For the talk');
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('[data-pins-set="For the talk"]', 'aria-pressed'), 'true');
    await page.click('.tg-pins-row[data-key="label:first"] .tg-pins-x');
    assert.equal(await page.getAttribute('[data-pins-set="For the talk"]', 'aria-pressed'), 'false');
    assert.match(await page.textContent('.tg-pins-set-update'), /Update “For the talk”/);
    await page.click('[data-pins-act="save"]');
    await page.fill('.tg-pins-set-name', 'Short');
    await page.click('[data-pins-act="save-ok"]');
    assert.equal(await page.getAttribute('[data-pins-set="Short"]', 'aria-pressed'), 'true');
    await page.click('[data-pins-set="For the talk"]');
    assert.equal(await badge(), '3');
    assert.deepEqual(await rows(), ['label:first', 'label:main', 'eq:(1)'], 'the set brings its order back');
    assert.equal(await page.getAttribute('[data-pins-set="For the talk"]', 'aria-pressed'), 'true');
    await page.keyboard.press('Escape');

    // Show only these: the study sheet, in order, with the note
    await openPins(page);
    await page.click('[data-pins-act="show"]');
    await page.waitForSelector('#preview.pick-view .pick-sheet');
    assert.match(await page.textContent('.pick-sheet'), /Reading order/);
    const sheet = await page.$$eval('.pick-sheet li', (li) => li.map((x) => x.textContent));
    assert.equal(sheet.length, 3);
    assert.match(sheet[0], /Lemma 1\.1/);
    assert.match(sheet[1], /Theorem 1\.3.*start the talk here/);
    assert.equal(await page.textContent('#preview .theorem[data-label="main"] ~ .pick-memo, #preview .pick-memo:has(+ .theorem[data-label="main"])').catch(() => ''), '2start the talk here');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#preview .pick-sheet, #preview .pick-memo').count(), 0, 'the sheet goes with the view');

    // kept with the notes: open the paper again
    await open();
    assert.equal(await badge(), '3');
    await openPins(page);
    assert.equal(await page.getAttribute('[data-pins-view="order"]', 'aria-pressed'), 'true', 'with an order, the list opens in order');
    assert.deepEqual(await rows(), ['label:first', 'label:main', 'eq:(1)']);
    assert.equal(await page.textContent('.tg-pins-row[data-key="label:main"] .tg-pins-memo'), 'start the talk here');
    assert.deepEqual(await page.$$eval('[data-pins-set]', (b) => b.map((x) => x.dataset.pinsSet)), ['For the talk', 'Short']);
    await page.click('[data-pins-setdel="Short"]');
    assert.deepEqual(await page.$$eval('[data-pins-set]', (b) => b.map((x) => x.dataset.pinsSet)), ['For the talk']);
    const stored = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'));
    assert.match(stored, /"note":\{[^]*"n":"start the talk here"/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
