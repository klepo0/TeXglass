'use strict';
// Comparing two versions in the web viewer (src/diff.js): the older file is
// chosen in the Compare dialog, and changed, new and removed blocks are marked,
// with a bar to step through them. Skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const PRE = [
  '\\documentclass{article}',
  '\\newtheorem{theorem}{Theorem}[section]',
  '\\newtheorem{lemma}[theorem]{Lemma}',
  '\\begin{document}',
  '\\section{Widgets}',
].join('\n') + '\n';
const OLD = PRE + [
  'Widgets are small machines with $n$ gears.',
  '',
  'This paragraph goes away in the new version of the paper entirely.',
  '',
  '\\begin{lemma}\\label{lem:a} Every bounded widget converges.\\end{lemma}',
  '\\begin{proof} Clear.\\end{proof}',
  '\\begin{theorem}\\label{thm:b} Every widget with $n$ gears converges.\\end{theorem}',
  '\\end{document}',
].join('\n') + '\n';
const NEW = PRE + [
  'Widgets are small machines with $n+1$ gears and a spring.',
  '',
  '\\begin{lemma}\\label{lem:a} Every bounded widget converges.\\end{lemma}',
  '\\begin{proof} Clear.\\end{proof}',
  '\\begin{theorem}\\label{thm:b} Every widget with $n \\ge 2$ gears converges quickly.\\end{theorem}',
  'A new remark about sprockets.',
  '\\end{document}',
].join('\n') + '\n';

async function serve(context) {
  await context.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

test('compare the open document with an older file', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await serve(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((doc) => {
      localStorage.setItem('texglass:last', doc);
      localStorage.setItem('texglass:last-name', 'widgets.tex');
    }, NEW);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview .theorem');

    // no arXiv paper open: the dialog offers only a file
    await page.locator('#more').click();
    await page.locator('#compare-open').click();
    assert.equal(await page.locator('#compare-arxiv').isHidden(), true);
    await page.locator('#compare-file-input').setInputFiles({ name: 'widgets-v1.tex', mimeType: 'text/plain', buffer: Buffer.from(OLD) });
    await page.waitForSelector('.diff-bar');

    assert.match(await page.locator('.diff-counts').textContent(), /2 changed · 1 new · 1 removed/);
    // the changed paragraph: new words marked, the changed formula too
    const para = page.locator('#preview .src-block.diff-changed').first();
    assert.match(await para.locator('ins.diff-ins').first().textContent(), /and a spring\./);
    assert.equal(await para.locator('.diff-math-ins').count(), 1);
    // the old version opens under it, with its words struck through
    await para.locator('button.diff-tag').click();
    const old = page.locator('#preview .diff-old-changed').first();
    assert.equal(await old.isVisible(), true);
    assert.match(await old.locator('del.diff-del').first().textContent(), /gears\./);
    // the removed paragraph: folded where it was, opened by its tag
    const removed = page.locator('#preview .diff-old-removed');
    assert.match(await removed.locator('.diff-tag').textContent(), /Removed in widgets\.tex: Text in §1/);
    assert.equal(await removed.locator('.diff-old-body').isVisible(), false);
    // the theorem is named by its number in the list of changes
    const names = await page.locator('.diff-list option').allTextContents();
    assert.ok(names.includes('Theorem 1.2 (changed)'), names.join(' | '));
    assert.ok(names.some((n) => /\(new\)$/.test(n)));
    // the old theorem keeps no id, so links and the map still find the new one
    assert.equal(await page.locator('#preview [id="thm-2"]').count(), 1);
    // step through: the bar counts, and a removed block opens when reached
    await page.locator('.diff-next').click();
    assert.match(await page.locator('.diff-step').textContent(), /^\d \/ 4$/);
    for (let k = 0; k < 4 && !(await removed.locator('.diff-old-body').isVisible()); k++) await page.locator('.diff-next').click();
    assert.equal(await removed.locator('.diff-old-body').isVisible(), true);
    // only changes: the unchanged lemma is hidden, the heading stays
    await page.locator('.diff-only').click();
    assert.equal(await page.locator('#preview .theorem.thm-env-lemma').isVisible(), false);
    assert.equal(await page.locator('#preview h2').isVisible(), true);
    // closing the bar puts the page back as it was
    await page.locator('.diff-close').click();
    assert.equal(await page.locator('.diff-bar').count(), 0);
    assert.equal(await page.locator('#preview .diff-old, #preview .diff-tag, #preview ins.diff-ins').count(), 0);
    assert.equal(await page.locator('#preview .theorem.thm-env-lemma').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
