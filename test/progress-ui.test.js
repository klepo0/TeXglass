'use strict';
// Reading progress (src/progress.js) in the web viewer: a status marker by each
// result, progress in Contents, "What should I read next?", the "?" list and
// the map coloured by status, kept with the paper's notes. Skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const DOC = [
  '\\documentclass{article}',
  '\\newtheorem{theorem}{Theorem}[section]',
  '\\newtheorem{lemma}[theorem]{Lemma}',
  '\\theoremstyle{definition}\\newtheorem{definition}[theorem]{Definition}',
  '\\title{Progress on Widgets}',
  '\\begin{document}',
  '\\section{Basics}',
  '\\begin{definition}\\label{def:widget} A widget is a thing.\\end{definition}',
  '\\begin{lemma}\\label{lem:base} Every widget by Definition~\\ref{def:widget} is small.\\end{lemma}',
  '\\begin{proof} Clear.\\end{proof}',
  '\\begin{lemma}\\label{lem:side} Some widgets are blue.\\end{lemma}',
  '\\section{Main}',
  '\\begin{lemma}\\label{lem:mid} By Lemma~\\ref{lem:base}, widgets stack.\\end{lemma}',
  '\\begin{theorem}\\label{thm:main} Widgets tile the plane.\\end{theorem}',
  '\\begin{proof} Use Lemma~\\ref{lem:mid} and Lemma~\\ref{lem:base}.\\end{proof}',
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

async function openDoc(page) {
  await page.addInitScript((doc) => {
    if (!localStorage.getItem('texglass:last')) {
      localStorage.setItem('texglass:last', doc);
      localStorage.setItem('texglass:last-name', 'widgets.tex');
      localStorage.setItem('texglass:toc', 'on');
      localStorage.setItem('texglass:side-tab', 'toc');
    }
  }, DOC);
  await page.goto('http://texglass.test/index.html');
  await page.waitForSelector('#preview .theorem .rp-marks');
}

const stored = (page) => page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('texglass:notes:'));
  return k ? JSON.parse(localStorage.getItem(k)).progress || {} : {};
});

test('reading progress: markers, Contents, read next, questions and the map', { skip: !chromium }, async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await serve(context);
    const page = await context.newPage();
    await openDoc(page);

    // a marker by every result and proof
    assert.equal(await page.locator('#preview .theorem > p > .rp-marks, #preview .theorem > .rp-marks, #preview .theorem .rp-marks').count() >= 5, true);
    assert.equal(await page.locator('#preview .proof .rp-marks').count(), 2);
    // no text of their own: they never get into copied or searched text
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.rp-marks')].every((b) => b.textContent === '')), true);

    // Contents: the paper as a whole, and each section
    await page.waitForSelector('.rp-summary:not([hidden])');
    assert.match(await page.textContent('.rp-sum-text'), /0 of 5 understood/);
    assert.deepEqual(await page.$$eval('.toc-list .rp-toc-n', (x) => x.map((e) => e.textContent)), ['0/3', '0/2']);

    // click: unread → skimmed → read → understood, kept by label
    const mark = page.locator('[data-label="lem:base"] .rp-mark').first();
    await mark.click();
    assert.equal(await mark.getAttribute('data-s'), 'skimmed');
    await page.locator('[data-label="lem:base"] .rp-mark').first().click();
    await page.locator('[data-label="lem:base"] .rp-mark').first().click();
    assert.equal(await page.locator('[data-label="lem:base"] .rp-mark').first().getAttribute('data-s'), 'understood');
    const p1 = await stored(page);
    assert.equal(p1['label:lem:base'].s, 'understood');
    assert.match(await page.textContent('.rp-sum-text'), /1 of 5 understood/);
    assert.deepEqual(await page.$$eval('.toc-list .rp-toc-n', (x) => x.map((e) => e.textContent)), ['1/3', '0/2']);

    // what to read next: the unread result most others rest on (the definition, which lem:base uses)
    await page.click('.rp-summary [data-rp="next"]');
    assert.match(await page.textContent('.rp-next'), /Definition 1\.1/);
    assert.match(await page.textContent('.rp-next'), /rest/);
    await page.click('.rp-next [data-rp="another"]');
    assert.match(await page.textContent('.rp-next'), /Lemma 2\.1/);

    // ? flag: a Questions button, and only the flagged results in Contents
    await page.hover('[data-label="thm:main"]');
    await page.locator('[data-label="thm:main"] .rp-q').first().click();
    assert.equal((await stored(page))['label:thm:main'].q, true);
    await page.click('.rp-summary [data-rp="questions"]');
    assert.deepEqual(await page.$$eval('.rp-qlist a', (x) => x.map((e) => e.textContent)), ['Theorem 2.2']);
    assert.equal(await page.locator('#toc-list').isVisible(), false);
    await page.click('.rp-summary [data-rp="questions"]');
    assert.equal(await page.locator('#toc-list').isVisible(), true);

    // the map: results coloured by status, the ? one flagged, and what the main theorem still needs
    await page.click('[data-side-tab="deps"]');
    await page.waitForSelector('.side-insight .dep-map');
    assert.equal(await page.locator('.side-insight .dep-node.rp-st-understood').count(), 1);
    assert.equal(await page.locator('.side-insight .dep-node.rp-st-q .rp-qmark').count(), 1);
    assert.equal(await page.locator('.side-insight .rp-legend').count(), 1);
    await page.locator('.side-insight .dep-node.rp-st-q').click();
    assert.match(await page.textContent('.side-insight .rp-detail'), /Not yet understood 2 of the 3/);
    // changing a status recolours the map at once
    await page.locator('[data-label="def:widget"] .rp-mark').first().click();
    assert.equal(await page.locator('.side-insight .dep-node.rp-st-skimmed').count(), 1);

    // kept across a reload
    await page.reload();
    await page.waitForSelector('[data-label="lem:base"] .rp-mark[data-s="understood"]');
    assert.equal(await page.locator('[data-label="thm:main"] .rp-q[aria-pressed="true"]').count(), 1);

    // switched off from the … menu: no markers, no summary
    await page.click('#more');
    await page.click('#progress-toggle');
    assert.equal(await page.locator('#preview .rp-marks').count(), 0);
    assert.equal(await page.locator('.rp-summary').isVisible(), false);
  } finally {
    await browser.close();
  }
});
