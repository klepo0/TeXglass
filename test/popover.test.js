'use strict';
// Hover popovers stay inside the window: below the link when they fit, else
// above, else on the roomier side, capped and scrolling. The browser part is
// skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { layout } = require('../src/popover.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

test('layout: below when it fits, then above, then the roomier side capped', () => {
  const vh = 600;
  assert.deepEqual(layout({ top: 100, bottom: 120 }, 200, vh, 8), { top: 120, cap: null });
  assert.deepEqual(layout({ top: 500, bottom: 520 }, 200, vh, 8), { top: 300, cap: null });
  // fits on neither side: the side with more room, capped to it
  assert.deepEqual(layout({ top: 200, bottom: 220 }, 500, vh, 8), { down: true, room: 372, cap: 372 });
  assert.deepEqual(layout({ top: 400, bottom: 420 }, 500, vh, 8), { down: false, room: 392, cap: 392 });
});

const lines = Array.from({ length: 60 }, (_, k) => `Line ${k + 1} of a long statement, $x_{${k}} = y^{${k}}$.`).join('\n');
const DOC = String.raw`\documentclass{article}
\begin{document}
\section{Intro}
\newtheorem{theorem}{Theorem}
\begin{theorem}\label{big}
` + lines + String.raw`
\end{theorem}
` + Array.from({ length: 30 }, () => 'Filler paragraph so the page scrolls.\n\n').join('') +
String.raw`See Theorem~\ref{big} here.

` + Array.from({ length: 30 }, () => 'More filler after the reference.\n\n').join('') + String.raw`
\end{document}`;

test('a tall reference preview stays inside a small window and scrolls', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 480 } });
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
    await page.click('#mode-preview');
    await page.waitForFunction(() => [...document.querySelectorAll('#preview a.ref')].some((a) => a.textContent.trim() === '1'));
    const link = page.locator('#preview a.ref', { hasText: /^1$/ }).last();

    for (const at of ['center', 'end', 'start']) {
      await link.evaluate((a, block) => a.scrollIntoView({ block }), at);
      await page.mouse.move(1, 1);
      await page.waitForTimeout(400);
      await link.hover();
      await page.waitForSelector('#ref-popover:not([hidden]) .theorem');
      const box = await page.evaluate(() => {
        const p = document.querySelector('#ref-popover');
        const card = p.firstElementChild;
        const r = p.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: document.documentElement.clientWidth,
          vh: document.documentElement.clientHeight, scrolls: card.scrollHeight > card.clientHeight + 1 };
      });
      assert.ok(box.top >= 0 && box.bottom <= box.vh, `${at}: vertically inside (${box.top}..${box.bottom} of ${box.vh})`);
      assert.ok(box.left >= 0 && box.right <= box.vw, `${at}: horizontally inside`);
      assert.ok(box.scrolls, `${at}: the card scrolls`);
      // the pointer can move into it and it stays open
      const card = await page.locator('#ref-popover .ref-popover-body').boundingBox();
      await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 8 });
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#ref-popover').isVisible(), true, `${at}: still open while hovered`);
    }
  } finally {
    await browser.close();
  }
});
