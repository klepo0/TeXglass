'use strict';
// Clicking text in the Overleaf panel (browser/src/overleaf-panel.js) moves the
// editor's cursor; the editor's answering scroll must not move the preview.
// In a real browser; skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const TAG = 'texglass-overleaf';

/** Overleaf (a stand-in page) with the panel in an iframe, as the extension lays it out. */
async function openOverleaf(page) {
  await page.route('https://panel.test/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const file = [path.join(ROOT, 'browser/src', rel), path.join(ROOT, rel)].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.route('https://www.overleaf.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><body style="margin:0"><iframe id="f" src="https://panel.test/overleaf.html" style="width:900px;height:500px;border:0"></iframe>
<script>window.got = []; addEventListener('message', (e) => { if (e.data && e.data.texglass === '${TAG}') got.push(e.data); });</script></body>`,
  }));
  await page.goto('https://www.overleaf.com/project/x');
  const frame = page.frameLocator('#f');
  await frame.locator('#preview-pane').waitFor();
  return page.frames().find((f) => f.url().startsWith('https://panel.test/'));
}

const send = (page, msg) => page.evaluate(([m, tag]) => {
  document.getElementById('f').contentWindow.postMessage(Object.assign({ texglass: tag }, m), 'https://panel.test');
}, [msg, TAG]);

test('a click in the preview leaves it where it is when the editor scrolls to the cursor', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    const panel = await openOverleaf(page);
    const paras = Array.from({ length: 80 }, (_, i) => `Paragraph number${i} has some words in it to fill a line or two of the column.`);
    const text = `\\documentclass{article}\n\\begin{document}\n${paras.join('\n\n')}\n\\end{document}\n`;
    await send(page, { type: 'doc', name: 'main.tex', text });
    await panel.waitForFunction(() => document.querySelectorAll('#preview > .src-block').length > 40);
    await send(page, { type: 'scroll', top: 0 });
    await page.waitForTimeout(200); // showOffset settles over a few frames

    const scrollTop = () => panel.evaluate(() => document.getElementById('preview-pane').scrollTop);
    // The reader scrolls the preview down to paragraph 40 and clicks a word there.
    await panel.evaluate(() => {
      const p = Array.from(document.querySelectorAll('#preview p')).find((x) => x.textContent.includes('number40 '));
      const pane = document.getElementById('preview-pane');
      pane.scrollTop += p.getBoundingClientRect().top - pane.getBoundingClientRect().top - 100;
    });
    await panel.locator('#preview-pane').dispatchEvent('wheel'); // scrolling by hand
    await page.waitForTimeout(400); // off-screen blocks settle to their real heights
    const before = await scrollTop();
    assert.ok(before > 200, 'scrolled down');
    const word = panel.locator('#preview p', { hasText: 'number40 ' }).first();
    const box = await word.boundingBox();
    await page.mouse.click(box.x + 20, box.y + 5);
    await page.waitForFunction(() => got.some((m) => m.type === 'jump'));
    const jump = await page.evaluate(() => got.find((m) => m.type === 'jump'));
    assert.ok(Math.abs(jump.at - text.indexOf('number40')) < 40, 'the cursor goes to the clicked paragraph');

    // The editor centres the cursor, so its first line is well above paragraph 40.
    await send(page, { type: 'scroll', top: text.indexOf('number30') });
    await page.waitForTimeout(150);
    assert.equal(await scrollTop(), before, 'the preview did not jump');

    // Scrolling the editor later still moves the preview along.
    await page.waitForTimeout(600);
    await send(page, { type: 'scroll', top: text.indexOf('number10') });
    await panel.waitForFunction((b) => document.getElementById('preview-pane').scrollTop < b - 100, before);
  } finally {
    await browser.close();
  }
});
