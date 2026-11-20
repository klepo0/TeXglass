'use strict';
// The text width grips in the Overleaf panel (browser/src/overleaf-panel.js), in a
// real browser. Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/** Serve the panel as the extension lays it out: its own files first, then the viewer's. */
async function openPanel(page) {
  await page.route('http://panel.test/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const file = [path.join(ROOT, 'browser/src', rel), path.join(ROOT, rel)].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://panel.test/overleaf.html');
  await page.evaluate(() => {
    document.getElementById('note').hidden = true;
    document.getElementById('preview').innerHTML = '<p>' + 'Some words to fill the column. '.repeat(60) + '</p>';
  });
}

test('the text width grips widen, narrow, fill, reset and are remembered', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
    await openPanel(page);
    const width = () => page.evaluate(() => Math.round(document.getElementById('preview').getBoundingClientRect().width));
    const saved = () => page.evaluate(() => localStorage.getItem('texglass:overleaf-text-width'));
    const drag = async (side, dx) => {
      const g = await page.locator('.text-resizer-' + side).boundingBox();
      await page.mouse.move(g.x + 5, 300);
      await page.mouse.down();
      await page.mouse.move(g.x + 5 + dx, 300, { steps: 4 });
      await page.mouse.up();
    };

    assert.equal(await width(), 760, 'the usual width');
    await drag('right', 50);
    assert.equal(await width(), 860, 'the column stays centred, so it grows by twice the drag');
    assert.equal(await saved(), '860');
    await drag('left', 150);
    assert.equal(await width(), 560);

    await page.reload();
    await page.evaluate(() => { document.getElementById('preview').innerHTML = '<p>Text.</p>'; });
    assert.equal(await width(), 560, 'remembered');

    await drag('right', 1000);
    assert.equal(await saved(), 'full');
    assert.equal(await width(), await page.evaluate(() => document.getElementById('preview-pane').clientWidth), 'fills the panel');

    await page.dblclick('.text-resizer-right');
    assert.equal(await width(), 760, 'double-click goes back to the usual width');
    assert.equal(await saved(), '');

    await page.focus('.text-resizer-left');
    await page.keyboard.press('ArrowRight');
    assert.equal(await width(), 720, 'arrow keys move the focused edge');
  } finally {
    await browser.close();
  }
});
