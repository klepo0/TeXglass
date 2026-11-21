'use strict';
// A paper whose macros or symbols contain \| or \{ (a backslash followed by a
// non-letter) used to make the notation list throw while sorting A–Z
// (alphaOf), which left the Notation tab blank and the side panel stuck.
// A made-up paper. The browser part is skipped where Playwright is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { alphaOf } = require('../src/insight.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

test('A–Z place of symbols with \\| and \\{', () => {
  assert.equal(alphaOf('\\|#1\\|').group, 'Other');
  assert.equal(alphaOf('\\left\\|#1\\right\\|').group, 'Other');
  assert.equal(alphaOf('\\{x_t\\}').group, 'X');
  assert.equal(alphaOf('\\|A\\|_{\\alpha,m}').group, 'A');
  assert.equal(alphaOf('\\,\\Gamma').group, 'Greek');
});

const DOC = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}[theorem]{Lemma}
\\newcommand{\\nrm}[1]{\\|#1\\|}
\\newcommand{\\set}[1]{\\left\\{#1\\right\\}}
\\newcommand{\\R}{\\mathbb{R}}
\\begin{document}
\\section{Setting}
Let $\\{x_t\\} := \\set{x \\in \\R : \\nrm{x} \\le t}$ for $t > 0$.
\\begin{lemma}\\label{lem:a} For all $t$, $\\nrm{x_t} \\le t$. \\end{lemma}
\\begin{theorem} By Lemma~\\ref{lem:a}, $\\{x_t\\}$ is bounded in $\\R$. \\end{theorem}
\\end{document}`;

test('Notation and Map tabs work on a paper with \\| in its macros', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    // The reader left the Notation tab open last time, sorted A–Z.
    await page.addInitScript(() => {
      localStorage.setItem('texglass:side-tab', 'notation');
      localStorage.setItem('texglass:notation-order', 'az');
    });
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.click('#mode-split');
    await page.fill('#source', DOC);
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 2);
    await page.click('#mode-preview');

    await page.click('[data-side-tab="notation"]');
    await page.waitForSelector('.side-insight .insight-group');
    const listed = await page.locator('.side-insight').textContent();
    assert.match(listed, /\\nrm/);

    await page.click('[data-side-tab="deps"]');
    await page.waitForSelector('.side-insight svg, .side-insight .dep-node, .side-insight [data-key]');
    await page.click('[data-side-tab="notation"]');
    await page.waitForSelector('.side-insight .insight-group');
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('.side-insight .insight-failed').count(), 0);
  } finally {
    await browser.close();
  }
});
