'use strict';
// Click a formula to copy its LaTeX, in a real browser. Skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');

test('a click on a formula copies its LaTeX; links, modifiers, double-clicks and Edit mode do not', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      '<article id="doc"><p>Text <span class="math math-inline" id="m1" data-tex="x^2 &lt; y">x²&lt;y</span> and ' +
      '<a href="#eq" id="link"><span class="math math-inline" data-tex="(1)">(1)</span></a>.</p>' +
      '<div class="math math-display" id="eq" data-tex="\\sum_i a_i">Σ aᵢ</div><p id="plain">plain text</p></article>');
    await page.addScriptTag({ path: path.join(ROOT, 'src/copytex.js') });
    await page.evaluate(() => {
      window.copied = [];
      window.copier = TeXglassCopyTex.attach({ roots: [document.getElementById('doc')], write: (s) => { window.copied.push(s); } });
    });
    const copied = () => page.evaluate(() => window.copied.slice());

    await page.click('#m1');
    assert.deepEqual(await copied(), ['x^2 < y']);
    await page.waitForSelector('.copy-toast.show');
    assert.equal(await page.textContent('.copy-toast'), 'Copied LaTeX');
    await page.click('#eq');
    assert.deepEqual(await copied(), ['x^2 < y', '\\sum_i a_i']);

    await page.click('#link .math'); // a reference link: follows it, no copy
    await page.click('#plain');
    await page.click('#m1', { modifiers: ['Control'] });
    assert.equal((await copied()).length, 2);

    await page.evaluate(() => window.copier.setEnabled(false));
    await page.click('#m1');
    assert.equal((await copied()).length, 2);
    assert.equal(await page.evaluate(() => document.getElementById('doc').classList.contains('math-copyable')), false);

    // With a delay (VS Code), a double-click jumps to the source instead of copying.
    await page.evaluate(() => {
      window.copier.detach();
      window.copier = TeXglassCopyTex.attach({ roots: [document.getElementById('doc')], delay: 300, write: (s) => { window.copied.push(s); } });
    });
    await page.dblclick('#eq');
    await page.waitForTimeout(450);
    assert.equal((await copied()).length, 2);
    await page.click('#eq');
    await page.waitForTimeout(450);
    assert.deepEqual((await copied()).slice(2), ['\\sum_i a_i']);
  } finally {
    await browser.close();
  }
});
