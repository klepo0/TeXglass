'use strict';
// Hovering a footnote mark in the web viewer previews the footnote, as a
// reference or citation link does. Skipped where Playwright and a browser are
// not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const DOC = String.raw`\documentclass{article}
\begin{document}
\section{Intro}
Some text.\footnote{A note with math $x^2 + y^2$ and a \textbf{bold} word.} More text.
\end{document}`;

test('hovering a footnote mark previews the footnote text', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
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
    await page.waitForSelector('#preview sup.fn a');

    await page.hover('#preview sup.fn a');
    await page.waitForSelector('#ref-popover:not([hidden]) .fn-preview');
    const pop = await page.evaluate(() => {
      const p = document.querySelector('#ref-popover .fn-preview');
      return { text: p.textContent, back: !!p.querySelector('.fn-back'), ids: p.querySelectorAll('[id]').length, math: !!p.querySelector('.katex'), li: !!p.querySelector('li') };
    });
    assert.match(pop.text, /A note with math/);
    assert.match(pop.text, /bold/);
    assert.equal(pop.back, false, 'no back link in the preview');
    assert.equal(pop.ids, 0);
    assert.equal(pop.math, true);
    assert.equal(pop.li, false, 'the text, not a list item');

    // Leaving the mark closes it.
    await page.mouse.move(5, 650);
    await page.waitForSelector('#ref-popover', { state: 'hidden' });
  } finally {
    await browser.close();
  }
});
