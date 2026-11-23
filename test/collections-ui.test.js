'use strict';
// Collections in the Pins tab (src/pins.js, app.js): pins from one paper added
// to a collection, then from a second paper; the collection lists both papers,
// and a click on an item in the other paper opens that paper (its saved copy)
// at the item. Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const filler = 'Filler text that only takes room on the page, so that a jump has somewhere to go.\n\n'.repeat(30);
const docOf = (title, name) => '\\documentclass{article}\n\\title{' + title + '}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\maketitle\n\\section{Start}\n' + filler +
  '\\begin{theorem}[' + name + ']\\label{main} Statement.\\end{theorem}\n\\end{document}';

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

test('a collection gathers pins from two papers and opens either', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    const open = async (title, name) => {
      await page.setInputFiles('#file-input', { name: title + '.tex', mimeType: 'text/x-tex', buffer: Buffer.from(docOf(title, name)) });
      await page.waitForFunction((n) => (document.querySelector('#preview .theorem') || {}).textContent?.includes(n), name);
    };
    const pinMain = async () => {
      await page.hover('#preview .theorem[data-label="main"]');
      await page.evaluate(() => document.querySelector('#preview .theorem[data-label="main"] .tg-pin-btn').click());
    };
    const P = '.side-pins ';

    // the first paper: saved for offline, its theorem pinned and put in "Talk"
    await open('Alpha', 'Alpha bound');
    await page.click('#save-offline');
    await page.waitForFunction(() => document.getElementById('save-offline').getAttribute('aria-pressed') === 'true');
    await page.click('[data-side-tab="pins"]');
    assert.match(await page.textContent(P + '.tg-coll-part'), /A collection gathers pins/);
    await pinMain();
    await page.click(P + '[data-coll-act="add"]');
    await page.fill(P + '.tg-coll-name', 'Talk');
    await page.keyboard.press('Enter');
    assert.match(await page.textContent(P + 'details[data-coll="Talk"] summary'), /1 from 1 paper/);

    // the second paper: the same, into the same collection
    await open('Bravo', 'Bravo estimate');
    await page.click('[data-side-tab="pins"]');
    await pinMain();
    await page.click(P + '[data-coll-act="add"]');
    assert.equal(await page.inputValue(P + '.tg-coll-name'), 'Talk', 'the collection there is offered');
    await page.keyboard.press('Enter');
    assert.match(await page.textContent(P + 'details[data-coll="Talk"] summary'), /2 from 2 papers/);
    assert.deepEqual(await page.$$eval(P + '.tg-coll-paper', (d) => d.map((x) => x.textContent.trim())), ['Alpha', 'Bravo open']);

    // a click on the first paper's theorem opens that paper (saved copy) there
    await page.click(P + '.tg-coll-row:has-text("Theorem 1 (Alpha bound)") .tg-coll-go');
    await page.waitForFunction(() => (document.querySelector('#preview .theorem') || {}).textContent?.includes('Alpha bound'));
    await page.waitForTimeout(800);
    const top = await page.$eval('#preview .theorem[data-label="main"]', (el) => el.getBoundingClientRect().top);
    assert.ok(top > 0 && top < 700, 'at the theorem: ' + top);

    // × takes one out; the collection's × deletes it
    await page.click('[data-side-tab="pins"]');
    if (!(await page.$eval(P + 'details[data-coll="Talk"]', (d) => d.open))) await page.click(P + 'details[data-coll="Talk"] summary .tg-sets-name');
    await page.click(P + '.tg-coll-row:has-text("Bravo estimate") [data-coll-x]');
    assert.match(await page.textContent(P + 'details[data-coll="Talk"] summary'), /1 from 1 paper/);
    await page.click(P + '[data-coll-del="Talk"]');
    assert.equal(await page.locator(P + 'details[data-coll]').count(), 0);
    // kept for the next visit
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('texglass:collections')).notes.length);
    assert.equal(kept, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
