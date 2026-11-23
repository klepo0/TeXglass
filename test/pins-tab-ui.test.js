'use strict';
// The side panel's Pins tab (src/pins.js panel, src/insight.js sidePanel): the
// saved pin sets fixed at the top, the one chosen in its reading order below,
// drawn like the contents; a click goes to the item. Also: a proof's pin sits
// by its title, and text pinned across paragraphs keeps them all in Show only
// these. Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const DOC = '\\documentclass{article}\n\\title{Tab}\n\\newtheorem{lemma}{Lemma}[section]\n\\newtheorem{theorem}[lemma]{Theorem}\n\\begin{document}\n\\maketitle\n\\section{Start}\n' +
  'Alpha words begin here and run on for a while.\n\nBravo words follow in a second paragraph.\n\nCharlie words stay out.\n' +
  'Filler text that only takes room on the page, so that a jump has somewhere to go.\n\n'.repeat(30) +
  '\\begin{equation}\\label{eq:a} a = b \\end{equation}\n\\[ x^2 + y^2 = r^2 \\]\n' +
  '\\begin{lemma}[Bound]\\label{first} First.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  '\\begin{theorem}\\label{main} Last.\\end{theorem}\\begin{proof} By Lemma~\\ref{first}.\\end{proof}\n\\end{document}';

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

test('the Pins tab, the proof pin by its title, and text pinned over paragraphs', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.setInputFiles('#file-input', { name: 'tab.tex', mimeType: 'text/x-tex', buffer: Buffer.from(DOC) });
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 2);
    const badge = () => page.$eval('#pins .tg-pins-badge', (b) => (b.hidden ? '' : b.textContent));

    // the proof's pin: right after "Proof.", not at the block's far right
    const proof = page.locator('#preview .theorem[data-label="main"] + .proof, #preview .proof:has-text("By Lemma")').first();
    await proof.hover();
    await page.waitForSelector('#preview .proof .tg-pin-btn', { state: 'attached' });
    const where = await proof.evaluate((p) => {
      const b = p.querySelector('.tg-pin-btn');
      const h = p.querySelector('.proof-head');
      return { after: b.previousElementSibling === h || (h.compareDocumentPosition(b) & 4) !== 0, sameLine: b.parentElement === h.parentElement, pos: getComputedStyle(b).position };
    });
    assert.deepEqual(where, { after: true, sameLine: true, pos: 'static' });

    // pin two results, put them in order, save a set
    const pinThm = async (label) => {
      await page.hover(`#preview .theorem[data-label="${label}"]`);
      await page.waitForSelector(`#preview .theorem[data-label="${label}"] .tg-pin-btn`, { state: 'attached' });
      await page.evaluate((l) => document.querySelector(`#preview .theorem[data-label="${l}"] .tg-pin-btn`).click(), label);
    };
    await pinThm('main');
    await pinThm('first');
    await page.click('#pins');
    await page.click('[data-pins-view="order"]');
    await page.focus('[data-pins-drag="label:first"]');
    await page.keyboard.press('ArrowUp');
    await page.click('.tg-pins-row[data-key="label:main"] .tg-pins-pen');
    await page.fill('.tg-pins-memo-in', 'the point of it all');
    await page.keyboard.press('Enter');
    await page.click('[data-pins-act="save"]');
    await page.fill('.tg-pins-set-name', 'Talk');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    // the Pins tab: the set on top, its reading order like the contents
    await page.click('[data-side-tab="pins"]');
    assert.equal(await page.isVisible('#toc-list, .toc-list:not(.tg-sets-steps)').catch(() => false), false);
    assert.deepEqual(await page.$$eval('.side-pins [data-sets-pick]', (b) => b.map((x) => [x.dataset.setsPick, x.getAttribute('aria-selected')])), [['Talk', 'true']]);
    const steps = await page.$$eval('.side-pins .tg-sets-steps li', (li) => li.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
    assert.equal(steps.length, 2);
    assert.match(steps[0], /^1\s*Lemma 1\.1/);
    assert.match(steps[1], /^2\s*Theorem 1\.2.*the point of it all/);
    assert.equal(await page.isVisible('.side-pins .tg-sets-on'), true, 'the set is pinned now');

    // a second set; picking it shows its order, the first stays listed
    await page.click('#pins');
    await page.click('.tg-pins-row[data-key="label:first"] .tg-pins-x');
    await page.click('[data-pins-act="save"]');
    await page.fill('.tg-pins-set-name', 'Main only');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.$$eval('.side-pins [data-sets-pick]', (b) => b.map((x) => x.dataset.setsPick)), ['Main only', 'Talk']);
    await page.click('[data-sets-pick="Talk"]');
    assert.equal(await page.locator('.side-pins .tg-sets-steps li').count(), 2);
    assert.equal(await page.isVisible('.side-pins [data-sets-act="pin"]'), true, 'Pin these, since it is not pinned now');
    // ↓ moves to the next set
    await page.focus('[data-sets-pick="Talk"]');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.getAttribute('[data-sets-pick="Main only"]', 'aria-selected'), 'true');
    await page.click('[data-sets-pick="Talk"]');
    // a click goes there
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    await page.waitForTimeout(200);
    const before = await page.$eval('#preview .theorem[data-label="main"]', (el) => el.getBoundingClientRect().top);
    assert.ok(before > 760, 'out of sight first: ' + before);
    await page.click('.side-pins .tg-sets-steps li:nth-child(2) a');
    await page.waitForTimeout(700);
    const top = await page.$eval('#preview .theorem[data-label="main"]', (el) => el.getBoundingClientRect().top);
    assert.ok(top > 0 && top < 700, 'jumped to Theorem 1.2: ' + top);
    // Pin these brings the set back
    await page.click('.side-pins [data-sets-act="pin"]');
    assert.equal(await badge(), '2');
    assert.equal(await page.isVisible('.side-pins .tg-sets-on'), true);
    const stepNames = () => page.$$eval('.side-pins .tg-sets-steps .toc-title', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));

    // the set pinned now: × takes a pin out of the set and unpins it, the set stays pinned now
    await page.click('.side-pins [data-sets-out="label:first"]');
    assert.equal(await badge(), '1');
    assert.equal((await stepNames()).length, 1);
    assert.equal(await page.isVisible('.side-pins .tg-sets-on'), true);
    assert.equal(await page.isVisible('.side-pins .tg-sets-hint'), true, 'how to add');
    // and the pins can still be unpinned and pinned anywhere
    await pinThm('first');
    assert.equal(await badge(), '2');
    assert.equal(await page.isVisible('.side-pins [data-sets-add="label:first"]'), true, 'pinned, not in the set: offered with +');
    await page.click('.side-pins [data-sets-add="label:first"]');
    assert.deepEqual((await stepNames()).map((x) => x.replace(/ .*/, '')), ['Theorem', 'Lemma'], 'added at the end of the order');
    assert.equal(await page.isVisible('.side-pins .tg-sets-on'), true);
    await pinThm('main'); // unpin from the text
    assert.equal(await badge(), '1');
    assert.equal(await page.isVisible('.side-pins .tg-sets-on'), false, 'the set is no longer what is pinned');
    // a set not pinned now: × only changes the set
    await page.click('[data-sets-pick="Main only"]');
    await page.click('.side-pins [data-sets-add="label:first"]');
    assert.equal(await page.locator('.side-pins .tg-sets-steps li').count(), 2);
    await page.click('.side-pins [data-sets-out="label:main"]');
    assert.equal(await page.locator('.side-pins .tg-sets-steps li').count(), 1);
    assert.equal(await badge(), '1', 'the pins stay as they are');
    // back to Talk, pinned
    await page.click('[data-sets-pick="Talk"]');
    await page.click('.side-pins [data-sets-act="pin"]');
    assert.equal(await badge(), '2');

    // text over two paragraphs: Show only these keeps both
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    await page.waitForTimeout(200);
    const a = await page.locator('#preview p', { hasText: 'Alpha words' }).first().boundingBox();
    const b = await page.locator('#preview p', { hasText: 'Bravo words' }).first().boundingBox();
    await page.mouse.move(a.x + 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 120, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector('.tg-hlbar:not([hidden])');
    await page.click('.tg-hlbar-pin');
    assert.equal(await badge(), '3');
    await page.click('#pins');
    await page.click('[data-pins-act="show"]');
    await page.waitForSelector('#preview.pick-view');
    const seen = async (txt) => page.locator('#preview p', { hasText: txt }).first().isVisible();
    assert.equal(await seen('Alpha words'), true);
    assert.equal(await seen('Bravo words'), true, 'the second paragraph of the passage stays too');
    assert.equal(await seen('Charlie words'), false);
    await page.keyboard.press('Escape');

    // an unnumbered display has a pin too
    const disp = page.locator('#preview .math-display', { hasText: 'r' }).filter({ hasNot: page.locator('.tag') }).first();
    await disp.scrollIntoViewIfNeeded();
    await disp.hover();
    await page.waitForSelector('#preview .math-display:not(:has(.tag)) .tg-pin-btn', { state: 'attached' });
    await page.evaluate(() => document.querySelector('#preview .math-display:not(:has(.tag)) .tg-pin-btn').click());
    assert.equal(await badge(), '4');
    await page.click('#pins');
    assert.match(await page.textContent('.tg-pins-menu'), /Unnumbered equation \(x\^2 \+ y\^2 = r\^2\)/);
    await page.click('[data-pins-act="show"]');
    await page.waitForSelector('#preview.pick-view');
    assert.equal(await page.locator('#preview .math-display:not(:has(.tag))').first().isVisible(), true, 'shown under Show only these');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
