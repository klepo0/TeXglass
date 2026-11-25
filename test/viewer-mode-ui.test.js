'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

test('a saved Split preference opens in Preview and inline editing still works', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    await page.addInitScript(() => {
      localStorage.setItem('texglass:mode', 'split');
      localStorage.setItem('texglass:last', 'A saved paragraph.');
    });
    await page.goto('http://texglass.test/index.html');
    const paragraph = page.locator('#preview .src-block > p', { hasText: 'A saved paragraph.' });
    await paragraph.waitFor();
    assert.deepEqual(await page.locator('.mode-switch button').allTextContents(), ['Preview', 'Edit']);
    assert.equal(await page.locator('#mode-preview').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('texglass:mode')), 'preview');
    assert.equal(await page.locator('#source, #splitter').count(), 0);

    await page.keyboard.press('Control+Shift+e');
    assert.equal(await page.locator('#mode-preview').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Control+e');
    assert.equal(await page.locator('#mode-edit').getAttribute('aria-pressed'), 'true');
    await paragraph.click();
    await page.fill('#inline-source', 'An edited paragraph.');
    await page.click('#mode-preview');
    await page.locator('#preview .src-block > p', { hasText: 'An edited paragraph.' }).waitFor();
    assert.equal(await page.locator('#inline-source').count(), 0);
    assert.equal(await page.locator('#mode-preview').getAttribute('aria-pressed'), 'true');
  } finally {
    await browser.close();
  }
});
