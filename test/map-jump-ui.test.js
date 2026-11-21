'use strict';
// Double-clicking (or double-tapping) a result on the dependency map jumps to it
// in the text: the larger map closes, and Back returns to where the reader was.
// A single click still only picks the result on the map. Skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i}, long enough to need scrolling between the results of this paper.\n\n`).join('');
const DOC = `\\documentclass{article}\n\\newtheorem{lemma}{Lemma}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\section{Start}\n` +
  `\\begin{lemma}\\label{first} First.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n${filler}` +
  `\\begin{lemma}\\label{second} Second.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n${filler}` +
  `\\begin{theorem} Last.\\end{theorem}\\begin{proof} By Lemmas~\\ref{first} and~\\ref{second}.\\end{proof}\n\\end{document}`;

test('a double-click on a map node jumps to that result', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.click('#mode-split');
    await page.fill('#source', DOC);
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 3);
    await page.click('#mode-preview');

    // Read the end of the paper, then open the larger map.
    const toEnd = () => page.evaluate(() => { const p = document.getElementById('preview-pane'); p.scrollTop = p.scrollHeight; });
    await toEnd();
    await page.waitForTimeout(300);
    const inView = (name) => page.evaluate((name) => {
      const pane = document.getElementById('preview-pane').getBoundingClientRect();
      const el = Array.from(document.querySelectorAll('#preview .theorem')).find((x) => x.textContent.includes(name));
      const r = el.getBoundingClientRect();
      return r.bottom > pane.top && r.top < pane.bottom;
    }, name);
    assert.equal(await inView('First.'), false);

    await page.keyboard.press('m');
    await page.waitForSelector('.insight-dialog[open] .dep-map');
    const node = (label) => page.locator('.insight-dialog .dep-node', { hasText: label }).first();

    // One click picks the result on the map and leaves the text alone.
    await node('Lemma 1').click();
    await page.waitForTimeout(600);
    assert.ok(await page.evaluate(() => document.querySelector('.insight-dialog').open), 'one click keeps the map open');
    assert.equal(await inView('First.'), false);

    // A double-click closes the map and jumps there.
    await node('Lemma 1').dblclick();
    await page.waitForFunction(() => !document.querySelector('.insight-dialog').open);
    await page.waitForTimeout(1200);
    assert.equal(await inView('First.'), true, 'jumped to Lemma 1');
    assert.ok(await page.evaluate(() => { const b = document.querySelector('.tg-history'); return b && !b.hidden && getComputedStyle(b).display !== 'none'; }), 'Back is offered');

    // Back returns to the end of the paper.
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(1200);
    assert.equal(await inView('Last.'), true, 'Back returned to the end');

    // The side panel's Map tab does the same.
    if (await page.locator('#toc-pane').isHidden()) await page.click('#toc-toggle');
    await page.click('[data-side-tab="deps"]');
    await page.waitForSelector('#toc-pane .dep-map');
    const side = page.locator('#toc-pane .dep-node', { hasText: 'Lemma 2' }).first();
    await side.click();
    await page.waitForTimeout(600);
    assert.equal(await inView('Second.'), false, 'one click in the side panel does not jump');
    await side.dblclick();
    await page.waitForTimeout(1200);
    assert.equal(await inView('Second.'), true, 'jumped to Lemma 2 from the side panel');
  } finally {
    await browser.close();
  }
});
