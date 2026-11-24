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

test('capture a pin into another set, resume a draft, and read and collect selected pins', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    const source = DOC.replace('Last.', 'By Lemma~\\ref{second}.');
    await page.setInputFiles('#file-input', { name: 'study.tex', mimeType: 'text/x-tex', buffer: Buffer.from(source) });
    const theorem = (key) => page.locator(`#preview .theorem[data-label="${key}"]`);
    for (const el of [theorem('first'), theorem('main'), page.locator('#preview .math-display').first()]) {
      await el.hover();
      await el.locator('.tg-pin-btn').evaluate((pin) => pin.click());
    }
    await openPins(page);
    const panel = page.locator('.side-pins');
    const row = (key) => panel.locator(`.tg-pins-row[data-key="${key}"]`);
    const act = (name) => panel.locator(`[data-pins-act="${name}"]`);
    const set = (name) => panel.locator(`[data-pins-set="${name}"]`);
    const keys = (selector = '.tg-pins-row') => panel.locator(selector).evaluateAll((rows) => rows.map((r) => r.dataset.key));
    const badge = () => page.locator('#pins .tg-pins-badge').textContent();

    await act('save').click();
    await panel.locator('.tg-pins-set-name').fill('Talk');
    await act('save-ok').click();
    await panel.locator('[data-pins-view="order"]').click();
    await row('label:main').locator('[data-pins-drag]').press('ArrowUp');
    await row('label:main').locator('[data-pins-drag]').press('ArrowUp');
    await row('eq:(1)').locator('[data-pins-unpin]').click();
    await row('label:main').locator('[data-pins-go]').click();
    const rowDestination = row('label:main').getByLabel('Add to set…');
    await rowDestination.focus();
    await rowDestination.selectOption({ label: 'New set…' });
    await row('label:main').getByLabel('Set name').fill('Referee');
    await row('label:main').getByLabel('Set name').press('Enter');
    assert.deepEqual(await keys(), ['label:main', 'label:first']);
    await set('Referee').click();
    assert.equal(await badge(), '1');

    await theorem('main').locator('a.ref').first().hover();
    const previewDestination = page.locator('#ref-popover').getByLabel('Add to set…');
    await previewDestination.waitFor();
    await previewDestination.focus();
    const destinations = () => previewDestination.locator('option').allTextContents();
    assert.equal((await destinations())[1], 'Referee');
    await previewDestination.selectOption({ label: 'Talk' });
    assert.equal(await badge(), '1', 'the reader stays with the current set');
    await previewDestination.blur();
    await previewDestination.focus();
    assert.equal((await destinations())[1], 'Talk');
    await set('Talk').click();
    assert.deepEqual(await keys(), ['label:main', 'label:first', 'label:second']);
    assert.match(await set('Talk').textContent(), /Draft/);
    await page.keyboard.press('j');
    assert.equal(await theorem('first').evaluate((el) => el.classList.contains('flash')), true);
    await act('update').click();
    assert.doesNotMatch(await set('Talk').textContent(), /Draft/);

    await row('label:first').locator('.tg-pins-pen').click();
    await row('label:first').locator('.tg-pins-memo-in').fill('Talk rehearsal');
    await row('label:first').locator('.tg-pins-memo-in').press('Enter');
    const search = panel.getByRole('searchbox', { name: 'Search pins' });
    await search.fill('rehearsal');
    assert.deepEqual(await keys('.tg-pins-row:not([hidden])'), ['label:first']);
    await act('select-matching').click();
    await search.fill('Theorem 1.3');
    assert.deepEqual(await keys('.tg-pins-row:not([hidden])'), ['label:main']);
    await act('select-matching').click();
    const destination = panel.getByRole('combobox', { name: 'Add to…', exact: true });
    await destination.focus();
    assert.deepEqual(await destination.locator('optgroup').evaluateAll((groups) => groups.map((group) => group.label)), ['Pin sets', 'Collections']);
    await destination.selectOption({ label: 'Referee' });
    assert.equal(await set('Referee').locator('.tg-sets-size').textContent(), '2');
    await destination.selectOption({ label: 'New collection…' });
    const collectionName = panel.getByRole('textbox', { name: 'Collection name' });
    await collectionName.fill('Literature review');
    await collectionName.press('Enter');
    const collection = panel.locator('details[data-coll="Literature review"]');
    assert.match(await collection.locator('summary').textContent(), /2 from 1 paper/);
    assert.match(await collection.textContent(), /Talk rehearsal/);
    await act('unpin-selected').click();
    assert.deepEqual(await keys(), ['label:second']);
    await act('revert').click();
    await search.fill('');

    await act('show').click();
    const bar = page.locator('.pick-bar');
    const read = bar.getByRole('button', { name: 'Read in this order' });
    const top = (el) => el.evaluate((x) => x.getBoundingClientRect().top);
    assert.ok(await top(theorem('first')) < await top(theorem('main')));
    await read.click();
    assert.ok(await top(theorem('main')) < await top(theorem('first')));
    assert.ok(await top(theorem('first')) < await top(theorem('second')));
    await read.click();
    assert.ok(await top(theorem('first')) < await top(theorem('main')));
    await bar.locator('[data-act="done"]').click();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('a direct dependency view expands one branch and saves the visible subset', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    const source = DOC.replace('Second.\\end{lemma}\\begin{proof} Clear.', 'Second.\\end{lemma}\\begin{proof} By Lemma~\\ref{first}.')
      .replace('By Lemmas~\\ref{first} and~\\ref{second}.', 'By Lemma~\\ref{second}.');
    await page.setInputFiles('#file-input', { name: 'branches.tex', mimeType: 'text/x-tex', buffer: Buffer.from(source) });
    const theorem = (key) => page.locator(`#preview .theorem[data-label="${key}"]`);
    await theorem('main').hover();
    await theorem('main').getByRole('button', { name: 'What does this use?' }).click();
    const bar = page.locator('.pick-bar');
    const direct = bar.getByRole('button', { name: 'Direct', exact: true });
    assert.equal(await theorem('first').isVisible(), true);
    await direct.click();
    assert.equal(await theorem('first').isVisible(), false);
    assert.equal(await theorem('second').isVisible(), true);
    await theorem('second').getByRole('button', { name: /Expand branch/ }).click();
    assert.equal(await theorem('first').isVisible(), true);
    await theorem('second').getByRole('button', { name: /Collapse branch/ }).click();
    assert.equal(await theorem('first').isVisible(), false);
    await bar.locator('[data-act="keep-menu"]').click();
    await bar.getByRole('menuitem', { name: 'Save as pin set' }).click();
    await bar.locator('[data-act="done"]').click();
    await openPins(page);
    const set = page.locator('.side-pins [data-pins-set]').filter({ hasText: 'selected branches' });
    await set.click();
    assert.deepEqual(await page.locator('.side-pins .tg-pins-row').evaluateAll((rows) => rows.map((r) => r.dataset.key).sort()), ['label:main', 'label:second']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
