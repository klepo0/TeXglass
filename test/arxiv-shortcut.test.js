'use strict';
// Ctrl+K opens the arXiv dialog, and a bare ?arxiv (the browser extension's
// toolbar button away from a paper) opens the viewer with it showing.
// Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}
const isOpen = (page) => page.evaluate(() => document.getElementById('arxiv-dialog').open);

test('Ctrl+K and Cmd+K open the arXiv dialog; a bare ?arxiv opens it on load', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage();
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    assert.equal(await isOpen(page), false);
    assert.match(await page.getAttribute('#arxiv', 'title'), /Ctrl\+K/);

    await page.keyboard.press('Control+k');
    assert.equal(await isOpen(page), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'arxiv-input');
    await page.keyboard.press('Escape');
    assert.equal(await isOpen(page), false);

    await page.keyboard.press('Meta+k');
    assert.equal(await isOpen(page), true);
    await page.keyboard.press('Escape');

    // From the source editor too.
    await page.click('#mode-split');
    await page.focus('#source');
    await page.keyboard.press('Control+k');
    assert.equal(await isOpen(page), true);
    await page.keyboard.press('Escape');

    // Not while another dialog is open.
    await page.click('#github');
    await page.keyboard.press('Control+k');
    assert.equal(await isOpen(page), false);
    await page.keyboard.press('Escape');

    const page2 = await browser.newPage();
    await serve(page2);
    await page2.goto('http://texglass.test/index.html?arxiv');
    await page2.waitForFunction(() => document.getElementById('arxiv-dialog').open);
    assert.match(await page2.textContent('#arxiv-message'), /Search arXiv/);
  } finally {
    await browser.close();
  }
});
