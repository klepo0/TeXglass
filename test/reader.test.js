'use strict';
// Exported pages with the reading tools (src/export.js page({ reader }), src/reader.js):
// `texglass paper.tex --reader` writes one page that shows reference previews,
// notation on hover, the side panel and Navigate, with nothing loaded from
// elsewhere. The browser parts are skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const TeXglassExport = require('../src/export.js');
const { PRECACHE } = require('../sw.js');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');

function cliPage(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reader-'));
  fs.copyFileSync(path.join(ROOT, 'examples/tour.tex'), path.join(dir, 'paper.tex'));
  execFileSync(process.execPath, [path.join(ROOT, 'bin/texglass.js'), path.join(dir, 'paper.tex'), ...extra], { stdio: 'pipe' });
  return path.join(dir, 'paper.html');
}

test('every reader script exists, and the web viewer can fetch it offline', () => {
  for (const f of TeXglassExport.READER_SCRIPTS) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    assert.ok(PRECACHE.includes(f), f + ' is precached in sw.js');
  }
});

test('the reader page keeps data and scripts from closing their elements', () => {
  const html = TeXglassExport.page({
    body: '<p>x</p>',
    title: 'T',
    reader: { scripts: ['var s = "</script>";'], data: { toc: [{ level: 2, num: '1', title: '</script><b>', id: 's' }], defs: null } },
  });
  assert.equal((html.match(/<\/script>/g) || []).length, (html.match(/<script\b/g) || []).length);
  assert.ok(html.includes('id="toc-pane"') && html.includes('id="preview-pane"'));
  // without reader, the plain page is unchanged
  assert.ok(!TeXglassExport.page({ body: '<p>x</p>' }).includes('tg-reader-data'));
});

test('--reader adds the tools; without it the page stays plain', () => {
  const plain = fs.readFileSync(cliPage([]), 'utf8');
  const reader = fs.readFileSync(cliPage(['--reader']), 'utf8');
  assert.ok(!plain.includes('TeXglassInsight'));
  assert.ok(reader.includes('TeXglassInsight') && reader.includes('tg-reader-data'));
  assert.ok(!/<script[^>]+src=|<link[^>]+href="http/.test(reader), 'nothing loaded from elsewhere');
});

test('the reader page: previews, notation, side panel, Navigate', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await playwright.chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + cliPage(['--reader']));
    await page.waitForSelector('#toc-pane:not([hidden])');

    // the side panel's tabs, with the document's contents
    const tabs = await page.$$eval('#toc-pane [role=tab]', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(tabs, ['Contents', 'Map', 'Notation']);
    assert.ok((await page.$$('#toc-list a[data-id]')).length >= 3);

    // a reference previews its target, with what it uses
    // (scroll first: scrolling closes previews)
    await page.$eval('#preview a.ref[data-label="thm:stability"]', (a) => a.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.hover('#preview a.ref[data-label="thm:stability"]');
    await page.waitForSelector('#ref-popover:not([hidden])');
    assert.match(await page.textContent('#ref-popover'), /Theorem 2\.3/);
    await page.mouse.move(2, 400);

    // notation on hover, from the paper's own macros
    const norm = await page.$$eval('#preview .math[data-tex]', (els) => els.findIndex((e) => e.dataset.tex.includes('\\Id')));
    assert.ok(norm >= 0);
    await (await page.$$('#preview .math[data-tex]'))[norm].hover();
    await page.waitForSelector('.insight-popover:not([hidden])');
    assert.match(await page.textContent('.insight-popover'), /\\Id/);

    // the notation index draws its symbols with the converter inside the page
    await page.click('#toc-pane [role=tab]:has-text("Notation")');
    await page.waitForFunction(() => document.querySelector('#toc-pane .katex'));

    // Go to: Ctrl+G, a number, Enter, then Back
    await page.keyboard.press('Control+g');
    await page.keyboard.type('2.1');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('preview-pane').scrollTop > 200);
    await page.waitForSelector('.tg-history:not([hidden])');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
