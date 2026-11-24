'use strict';
// TeXmark (.tmd) files in the web viewer: opened like a .tex file, drawn from
// their LaTeX conversion, with block ranges on the .tmd text itself and a
// "Convert to .tex" download. Skipped where Playwright and a browser are not
// installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const TMD = `---
title: A made-up note
author: A. N. Author
---

\\newcommand{\\R}{\\mathbb{R}}

# Setting {#sec:setting}

Let $f : \\R \\to \\R$ be *smooth*.

::: lemma [Small] {#lem:small}
Every $f$ is **fine**.
:::

By @lem:small and [@knuth84], we are done.
`;

test('a .tmd file renders, maps back to its own lines, and converts to .tex', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview .src-block');
    await page.setInputFiles('#file-input', { name: 'note.tmd', mimeType: 'text/plain', buffer: Buffer.from(TMD) });
    await page.waitForFunction(() => /made-up note/.test(document.querySelector('#preview').textContent));

    const view = await page.evaluate(() => {
      const p = document.querySelector('#preview');
      return {
        text: p.textContent.replace(/\s+/g, ' '),
        emph: !!p.querySelector('em'),
        name: document.getElementById('file-name').textContent,
        convertShown: !document.getElementById('convert-tex').hidden,
        blocks: Array.from(p.querySelectorAll('.src-block')).map((b) => [Number(b.dataset.s), Number(b.dataset.e), b.textContent.replace(/\s+/g, ' ').trim()]),
      };
    });
    assert.equal(view.name, 'note.tmd');
    assert.match(view.text, /1\s*Setting/);
    assert.match(view.text, /Lemma 1\.1 \(Small\)\. Every/);
    assert.match(view.text, /By Lemma 1\.1/);
    assert.equal(view.emph, true);
    assert.equal(view.convertShown, true);
    // Each block's range is whole lines of the .tmd text.
    const slice = (s, e) => TMD.slice(s, e);
    const heading = view.blocks.find((b) => /Setting/.test(b[2]));
    assert.equal(slice(heading[0], heading[1]), '# Setting {#sec:setting}');
    const lemma = view.blocks.find((b) => /Lemma 1\.1/.test(b[2]));
    assert.equal(slice(lemma[0], lemma[1]), '::: lemma [Small] {#lem:small}\nEvery $f$ is **fine**.\n:::');
    const title = view.blocks.find((b) => /made-up note/.test(b[2]));
    assert.equal(slice(title[0], title[1]), '---\ntitle: A made-up note\nauthor: A. N. Author\n---');

    // Convert to .tex downloads the LaTeX with its preamble.
    await page.evaluate(() => document.getElementById('convert-tex').click());
    const download = await page.waitForEvent('download');
    assert.equal(download.suggestedFilename(), 'note.tex');
    const tex = fs.readFileSync(await download.path(), 'utf8');
    assert.match(tex, /^\\documentclass\{amsart\}/);
    assert.match(tex, /\\newtheorem\{lemma\}\[theorem\]\{Lemma\}/);
    assert.match(tex, /\\begin\{lemma\}\[Small\]\\label\{lem:small\}/);
    assert.match(tex, /By \\cref\{lem:small\} and \\cite\{knuth84\}/);
    assert.match(tex, /\\end\{document\}\n$/);

    // A .tex file hides the button again.
    await page.setInputFiles('#file-input', { name: 'plain.tex', mimeType: 'text/plain', buffer: Buffer.from('\\section{Plain}\nText.') });
    await page.waitForFunction(() => /Plain/.test(document.querySelector('#preview').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('convert-tex').hidden), true);
  } finally {
    await browser.close();
  }
});
