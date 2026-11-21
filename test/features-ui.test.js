'use strict';
// Settings in the web viewer: the gear opens a panel that switches reading aids
// off and on again, and the page follows at once. Skipped where Playwright and
// a browser are not installed.
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
  '\\begin{document}',
  '\\section{Basics}',
  'Let $G$ be a gadget.\\footnote{Gadgets are small.}',
  '\\begin{lemma}\\label{lem:base} Every gadget is small.\\end{lemma}',
  '\\begin{theorem}\\label{thm:main} By Lemma~\\ref{lem:base}, gadgets tile.\\end{theorem}',
  '\\begin{proof} Use Lemma~\\ref{lem:base}.\\end{proof}',
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

test('the Settings panel switches reading aids off and on', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await serve(context);
    const page = await context.newPage();
    await page.addInitScript((doc) => {
      if (!localStorage.getItem('texglass:last')) {
        localStorage.setItem('texglass:last', doc);
        localStorage.setItem('texglass:last-name', 'gadgets.tex');
        localStorage.setItem('texglass:toc', 'on');
      }
    }, DOC);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview .theorem');

    const box = (id) => page.locator(`.features-dialog input[data-id="${id}"]`);
    const toggle = async (id) => {
      await page.click('#settings');
      await box(id).click();
      await page.click('.features-done');
    };
    const refLink = page.locator('#thm-main a.ref, .theorem a.ref').first();

    // a reference preview shows, then stops once switched off
    await refLink.hover();
    await page.waitForSelector('#ref-popover:not([hidden])');
    await page.mouse.move(5, 5);
    await page.waitForSelector('#ref-popover[hidden]', { state: 'attached' });
    await page.click('#settings');
    assert.equal(await page.locator('.features-dialog[open]').count(), 1);
    assert.equal(await box('refPreviews').isChecked(), true);
    assert.equal(await box('handwriting').isChecked(), false);
    await box('refPreviews').click();
    // the hypothesis checker works through reference previews: shown dimmed
    assert.equal(await page.locator('.feature[data-feature="hypotheses"].feature-blocked').count(), 1);
    await page.click('.features-done');
    assert.equal(await page.evaluate(() => localStorage.getItem('texglass:feature-refPreviews')), '0');
    await refLink.hover();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#ref-popover:not([hidden])').count(), 0);

    // footnote previews are separate and still on
    await page.locator('sup.fn a').first().hover();
    await page.waitForSelector('#ref-popover:not([hidden]) .fn-preview');
    await page.mouse.move(5, 5);

    // the Map and Notation tabs go away with their settings
    await toggle('dependencyMap');
    await toggle('notationIndex');
    assert.equal(await page.locator('[data-side-tab="deps"]').isHidden(), true);
    assert.equal(await page.locator('[data-side-tab="notation"]').isHidden(), true);
    await page.keyboard.press('m');
    assert.equal(await page.locator('.insight-dialog[open]').count(), 0);

    // "What does this use?" buttons
    await page.locator('#preview .theorem').first().hover();
    await page.waitForSelector('.uses-btn', { state: 'attached' });
    await toggle('usesButtons');
    assert.equal(await page.locator('.uses-btn').first().isVisible(), false);

    // the reading progress menu item and the panel are the same setting
    await toggle('progress');
    assert.equal(await page.getAttribute('#progress-toggle', 'aria-checked'), 'false');

    // the handwritten look follows the panel and the pen button
    await toggle('handwriting');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.look), 'notes');
    await page.click('#hand-toggle');
    await page.click('#settings');
    assert.equal(await box('handwriting').isChecked(), false);

    // kept after a reload, and all back on with one button
    await page.click('.features-done');
    await page.reload();
    await page.waitForSelector('#preview .theorem');
    assert.equal(await page.locator('[data-side-tab="deps"]').isHidden(), true);
    await page.click('#settings');
    assert.equal(await box('refPreviews').isChecked(), false);
    await page.click('.features-reset');
    assert.equal(await box('refPreviews').isChecked(), true);
    assert.equal(await box('dependencyMap').isChecked(), true);
    await page.click('.features-done');
    assert.equal(await page.locator('[data-side-tab="deps"]').isHidden(), false);
    await refLink.hover();
    await page.waitForSelector('#ref-popover:not([hidden])');
  } finally {
    await browser.close();
  }
});
