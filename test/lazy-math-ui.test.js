'use strict';
// Long papers on phones: formulas away from the screen are put away (app.js
// stripMath) and drawn again as they near it (fillMath). The reading tools
// must see the same text, TeX and equation numbers either way. ?lazy=1 turns
// this on for a short made-up paper; on a phone it starts at 3000 formulas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const SECTIONS = 60;
const DOC = String.raw`\documentclass{article}
\begin{document}
` + Array.from({ length: SECTIONS }, (_, k) => String.raw`\section{Part ${k + 1}}
The quantity $a_{${k}} + b^2$ and $\int_0^1 f_{${k}}(x)\,dx$ are bounded, as in \eqref{eq:${k}}.
\begin{equation}\label{eq:${k}}
\sum_{n=1}^{\infty} \frac{x_{${k}}^n}{n!} = e^{x_{${k}}} - 1.
\end{equation}
Some words after the formula, enough to take a few lines on a phone screen and more.`).join('\n\n') + '\n\\end{document}';

test('long papers on phones: formulas far from the screen wait, the reading tools still see them', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await playwright.chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const ctx = await browser.newContext({ ...playwright.devices['iPhone 13'], serviceWorkers: 'block' });
    await ctx.addInitScript((d) => {
      localStorage.setItem('texglass:last', d);
      localStorage.setItem('texglass:last-name', 'parts.tex');
      localStorage.setItem('texglass:coach', 'done');
    }, DOC);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    await page.route(/^https?:\/\/(?!texglass\.test)/, (route) => route.fulfill({ status: 503, body: '' }));
    await page.goto('http://texglass.test/index.html?lazy=1');
    await page.waitForSelector('#preview .math-display');
    await page.waitForTimeout(500);

    // The text a reader's notes are anchored to: everything but the MathML.
    const textOf = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      const w = document.createTreeWalker(el, 4, { acceptNode: (n) => (n.parentElement.closest('.katex-mathml') ? 2 : 1) });
      let out = '';
      for (let n = w.nextNode(); n; n = w.nextNode()) out += n.data;
      return out.replace(/\s+/g, ' ');
    }, sel);
    const state = () => page.evaluate(() => {
      const ds = [...document.querySelectorAll('#preview .math-display')];
      return {
        first: !ds[0].querySelector('.tg-lazy'),
        last: !ds[ds.length - 1].querySelector('.tg-lazy'),
        waiting: document.querySelectorAll('#preview .tg-lazy').length,
        tags: [...document.querySelectorAll('.math-display .katex-html .tag')].map((x) => x.textContent.trim()),
        tex: document.querySelectorAll('#preview annotation[encoding="application/x-tex"]').length,
        katex: document.querySelectorAll('#preview .katex').length,
      };
    });

    const top = await state();
    assert.ok(top.first, 'formulas on screen are drawn');
    assert.ok(!top.last && top.waiting > 100, `far formulas wait (${top.waiting})`);
    assert.equal(top.tags.length, SECTIONS, 'every equation number is still there (find, the map)');
    assert.equal(top.tags[SECTIONS - 1], `(${SECTIONS})`);
    assert.equal(top.tex, top.katex, 'every formula keeps its TeX');

    const lastSel = '#preview > .src-block:last-of-type';
    const waitingText = await textOf(lastSel);
    const tagEl = await page.evaluateHandle(() => [...document.querySelectorAll('.math-display .katex-html .tag')].pop());

    // A copy of a far block (a preview on hover) gets the drawings once it is in view;
    // one far out of view waits (the Notation tab copies hundreds of sentences).
    const copied = await page.evaluate(() => {
      const far = [...document.querySelectorAll('#preview .math-display')].pop();
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;top:0;left:0';
      box.appendChild(far.cloneNode(true));
      const away = document.createElement('div');
      away.style.cssText = 'position:fixed;top:100000px;left:0';
      away.appendChild(far.cloneNode(true));
      document.body.append(box, away);
      return new Promise((r) => setTimeout(() => {
        r({ waiting: box.querySelectorAll('.tg-lazy').length, drawn: box.querySelectorAll('.katex-html .mfrac').length, away: away.querySelectorAll('.tg-lazy').length });
        box.remove();
        away.remove();
      }, 300));
    });
    assert.deepEqual(copied, { waiting: 0, drawn: 1, away: 1 });

    // Scroll to the end: the last formulas are drawn, the first ones put away.
    await page.evaluate(() => { const p = document.getElementById('preview-pane'); p.scrollTop = p.scrollHeight; });
    await page.waitForFunction(() => { const ds = [...document.querySelectorAll('#preview .math-display')]; return !ds[ds.length - 1].querySelector('.tg-lazy') && ds[0].querySelector('.tg-lazy'); });
    await page.evaluate(() => { const p = document.getElementById('preview-pane'); p.scrollTop = p.scrollHeight; });
    await page.waitForTimeout(300);
    const end = await state();
    assert.ok(end.last && !end.first, 'drawn near the screen, put away far from it');
    assert.deepEqual(end.tags, top.tags);
    assert.equal(await textOf(lastSel), waitingText, 'the same text either way, so notes stay in place');
    assert.ok(await tagEl.evaluate((el) => el.isConnected && !!el.closest('.katex-html:not(.tg-lazy)')), 'an equation number is the same node once drawn');
    const shot = await page.evaluate(() => { const k = [...document.querySelectorAll('#preview .math-display .katex-html')].pop(); return k.getBoundingClientRect().height > 10 && getComputedStyle(k).visibility; });
    assert.equal(shot, 'visible');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
