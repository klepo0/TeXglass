'use strict';
// The larger dependency map: M opens and closes it, and it zooms (buttons,
// keys, Ctrl + wheel) and pans without zooming the page under it. Skipped
// where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

// A long chain of lemmas, each using the two before it, so the map is wider
// than the window.
const N = 24;
let body = '';
for (let i = 1; i <= N; i++) {
  body += `\\begin{lemma}\\label{l${i}} Statement $x_{${i}}$.\\end{lemma}\n`;
  body += i > 2 ? `\\begin{proof} By Lemmas~\\ref{l${i - 1}} and~\\ref{l${i - 2}}.\\end{proof}\n` : '\\begin{proof} Clear.\\end{proof}\n';
}
// Two theorems rest on the last lemma, so the chain does not fold into one of them.
body += `\\begin{theorem} A.\\end{theorem}\\begin{proof} By Lemma~\\ref{l${N}}.\\end{proof}\n`;
body += `\\begin{theorem} B.\\end{theorem}\\begin{proof} By Lemma~\\ref{l${N}}.\\end{proof}\n`;
const DOC = `\\documentclass{article}\n\\newtheorem{lemma}{Lemma}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\section{Chain}\n${body}\\end{document}`;

test('M opens the larger map, which zooms and pans', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.evaluate((doc) => window.TeXglassViewer.reshow(doc), DOC);
    await page.waitForFunction((n) => document.querySelectorAll('#preview .theorem').length >= n, N);

    await page.click('#preview .theorem');
    await page.keyboard.press('m');
    await page.waitForSelector('.insight-dialog[open] .dep-map');
    const state = () => page.evaluate(() => {
      const svg = document.querySelector('.insight-dialog .dep-map');
      const wrap = svg.parentElement;
      return {
        w: parseFloat(svg.style.width), base: Number(svg.getAttribute('width')),
        level: document.querySelector('.dep-zoom-level').textContent,
        wrapW: wrap.clientWidth, left: wrap.scrollLeft, docZoom: document.documentElement.style.getPropertyValue('--zoom'),
      };
    });
    // Show every lemma: unfold the chain if it folded.
    if (await page.isChecked('.insight-dialog input[data-opt="fold"]').catch(() => false)) await page.uncheck('.insight-dialog input[data-opt="fold"]');
    let s = await state();
    assert.equal(s.level, '100%');
    assert.ok(s.base > s.wrapW, 'the map is wider than its frame');
    const docZoom = s.docZoom;

    await page.keyboard.press('f');
    s = await state();
    assert.ok(s.w <= s.wrapW, 'Fit shows the whole width');
    assert.notEqual(s.level, '100%');

    await page.keyboard.press('0');
    assert.equal((await state()).level, '100%');
    await page.keyboard.press('Control+=');
    s = await state();
    assert.equal(s.level, '125%');
    assert.equal(s.docZoom, docZoom, 'Ctrl+= zoomed the map, not the page');
    await page.click('.dep-zoom [data-zoom="-1"]');
    assert.equal((await state()).level, '100%');

    // Ctrl + wheel zooms out at the pointer.
    // (the map may be redrawn just after a zoom; wait until it is on screen again)
    const wrap = page.locator('.insight-dialog .dep-wrap');
    let box = null;
    for (let tries = 0; !box && tries < 50; tries++) {
      await wrap.waitFor({ state: 'visible' });
      box = await wrap.boundingBox();
      if (!box) await page.waitForTimeout(100);
    }
    assert.ok(box, 'the map is on screen');
    await page.mouse.move(box.x + 300, box.y + 100);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 200);
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.dep-zoom-level').textContent !== '100%');
    await page.keyboard.press('0');

    // Dragging the background moves around the map.
    await page.evaluate(() => { const w = document.querySelector('.insight-dialog .dep-wrap'); w.scrollLeft = 0; w.scrollTop = 0; });
    const before = (await state()).left;
    const spot = await page.evaluate(([x0, y0]) => {
      for (let y = y0 + 40; y < y0 + 300; y += 10) {
        for (let x = x0 + 400; x < x0 + 800; x += 10) {
          const el = document.elementFromPoint(x, y);
          if (el && el.closest('.dep-wrap') && !el.closest('.dep-node, .dep-fold')) return [x, y];
        }
      }
      return null;
    }, [box.x, box.y]);
    assert.ok(spot, 'an empty spot on the map');
    await page.mouse.move(spot[0], spot[1]);
    await page.mouse.down();
    await page.mouse.move(spot[0] - 150, spot[1], { steps: 5 });
    await page.mouse.up();
    assert.ok((await state()).left > before + 100, 'dragged to the right part of the map');

    // M again closes it.
    await page.keyboard.press('m');
    assert.equal(await page.evaluate(() => !!document.querySelector('.insight-dialog[open]')), false);

    // Typing M in the editor types it.
    await page.click('#mode-edit');
    await page.locator('#preview .theorem').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('m');
    assert.equal(await page.evaluate(() => !!document.querySelector('.insight-dialog[open]')), false);
    assert.match(await page.inputValue('#inline-source'), /m$/);
  } finally {
    await browser.close();
  }
});
