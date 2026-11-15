'use strict';
// The find bar in a real browser: its buttons respond to clicks. Skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');

test('the find bar\'s next, previous and close buttons work when clicked', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
    const paras = Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i} lorem ipsum.</p>`).join('');
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<section id="pane" style="height:100vh;overflow:auto"><article id="doc">${paras}</article></section>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/find.js') });
    await page.evaluate(() => {
      window.finder = TeXglassFind.attach({ root: document.getElementById('doc'), scroller: document.getElementById('pane') });
      window.finder.open('find');
    });
    await page.keyboard.type('lorem');
    await page.waitForFunction(() => window.finder.state().count === 30);
    const current = () => page.evaluate(() => window.finder.state().current);
    const start = await current();
    await page.click('.find-next');
    assert.equal(await current(), start + 1);
    await page.click('.find-prev');
    await page.click('.find-prev');
    assert.equal(await current(), start - 1 < 0 ? 29 : start - 1);
    await page.click('.find-modes [data-mode="goto"]');
    assert.equal(await page.evaluate(() => window.finder.state().mode), 'goto');
    await page.click('.find-close');
    assert.equal(await page.evaluate(() => window.finder.isOpen()), false);
    // Esc closes it too, even with the focus outside its input.
    await page.evaluate(() => window.finder.open('find'));
    await page.click('#doc p:nth-child(5)');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.finder.isOpen()), false);
  } finally {
    await browser.close();
  }
});
