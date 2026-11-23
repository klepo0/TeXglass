'use strict';
// Pin tools (src/pins.js, src/insight.js, src/find.js): P pins what is under
// the pointer, J / K step through the pins; Contents shows how many pins each
// section holds; "+ uses, as a set" on the map and "Pin as a set" in the Uses
// tab pin a result with what it uses as a set of its own; the Pins tab
// suggests a starter set of the main results. Skipped where Playwright and a
// browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const filler = 'Filler text that only takes room on the page, so that a jump has somewhere to go.\n\n'.repeat(12);
const DOC = '\\documentclass{article}\n\\title{Tools}\n\\newtheorem{theorem}{Theorem}[section]\n\\newtheorem{lemma}[theorem]{Lemma}\n\\theoremstyle{definition}\\newtheorem{definition}[theorem]{Definition}\n\\begin{document}\n\\maketitle\n' +
  '\\section{One}\n\\begin{definition}\\label{def:a} A thing.\\end{definition}\n' + filler +
  '\\begin{lemma}\\label{lem:a} By Definition~\\ref{def:a}.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' + filler +
  '\\section{Two}\n\\begin{theorem}\\label{thm:main} Using Lemma~\\ref{lem:a} and Definition~\\ref{def:a}.\\end{theorem}\\begin{proof} By Lemma~\\ref{lem:a}.\\end{proof}\n' + filler +
  '\\end{document}';

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

test('P, J / K, pins in Contents, pin as a set, and the suggested starter set', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.setInputFiles('#file-input', { name: 'tools.tex', mimeType: 'text/x-tex', buffer: Buffer.from(DOC) });
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 3);
    const badge = () => page.$eval('#pins .tg-pins-badge', (b) => (b.hidden ? '' : b.textContent));
    const th = (l) => `#preview .theorem[data-label="${l}"]`;

    // the starter set, offered in the Pins tab: Theorem 1.1 with the definition it rests on (not the lemma)
    await page.click('[data-side-tab="pins"]');
    await page.click('.side-pins [data-pins-starter]');
    assert.equal(await page.getAttribute('.side-pins [data-pins-set="Main results (suggested)"]', 'aria-pressed'), 'true', 'nothing was pinned: the set is pinned');
    assert.deepEqual(await page.$$eval('.side-pins .tg-pins-row', (r) => r.map((x) => x.dataset.key)), ['label:def:a', 'label:thm:main']);
    assert.equal(await page.locator('.side-pins [data-pins-starter]').count(), 0, 'offered once');
    await page.click('.side-pins [data-pins-act="clear"]');
    await page.click('.side-pins [data-pins-act="clear-ok"]');
    assert.equal(await badge(), '');

    // P pins what is under the pointer, and again unpins it
    await page.locator(th('lem:a')).scrollIntoViewIfNeeded();
    await page.hover(th('lem:a'));
    await page.keyboard.press('p');
    assert.equal(await badge(), '1');
    await page.keyboard.press('p');
    assert.equal(await badge(), '');
    await page.keyboard.press('p');
    await page.locator(th('thm:main')).scrollIntoViewIfNeeded();
    await page.hover(th('thm:main'));
    await page.keyboard.press('p');
    assert.equal(await badge(), '2');

    // Contents: a count by each section holding pins
    await page.click('[data-side-tab="toc"]');
    await page.waitForFunction(() => document.querySelectorAll('#toc-list .tg-toc-pins').length === 2);
    const counts = await page.$$eval('#toc-list a', (as) => as.map((a) => [a.querySelector('.toc-title').textContent.trim(), (a.querySelector('.tg-toc-pins') || {}).textContent || '']));
    assert.deepEqual(counts, [['One', '1'], ['Two', '1']]);

    // J / K step through the pins, in the paper's order
    await page.mouse.move(5, 400);
    const topOf = (l) => page.$eval(th(l), (el) => el.getBoundingClientRect().top);
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    await page.keyboard.press('j');
    await page.waitForTimeout(600);
    assert.ok((await topOf('lem:a')) < 600, 'J goes to the first pin');
    await page.keyboard.press('j');
    await page.waitForTimeout(600);
    assert.ok((await topOf('thm:main')) < 600, 'J again: the next one ' + (await topOf('thm:main')) + ' ' + (await topOf('lem:a')));
    await page.keyboard.press('k');
    await page.waitForTimeout(600);
    assert.ok((await topOf('lem:a')) < 600 && (await topOf('lem:a')) > -50, 'K goes back');

    // the map: + uses, as a set
    await page.keyboard.press('m');
    await page.waitForSelector('.insight-dialog[open] .dep-map');
    await page.locator('.insight-dialog .dep-node', { hasText: 'Lemma 1.2' }).first().click();
    await page.mouse.move(5, 5);
    await page.click('.insight-dialog [data-mset="uses"]');
    await page.keyboard.press('Escape');
    await page.click('[data-side-tab="pins"]');
    assert.ok(await page.locator('.side-pins [data-pins-set="Lemma 1.2 with what it uses"]').count(), 'kept as a set');
    assert.equal(await badge(), '2', 'the other pin stays (and the lemma was pinned already)');

    // the Uses tab: Pin as a set
    await page.click('#find');
    await page.click('.find-bar button[role="tab"][data-mode="uses"]');
    await page.fill('.find-input', 'Theorem 2.1');
    await page.waitForSelector('.uses-pinset');
    await page.click('.uses-pinset');
    assert.match(await page.textContent('.uses-pinset'), /Pinned/);
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('.side-pins [data-pins-set="Theorem 2.1 with what it uses"]').count());
    assert.match(await page.textContent('.side-pins .tg-pins-row[data-key="label:thm:main"]'), /with what it uses/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
