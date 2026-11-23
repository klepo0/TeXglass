'use strict';
// The text width grips (src/textwidth.js) in the web viewer: beside the margin notes,
// remembered, never under the side panel's drawer, and not on phones. The Overleaf
// panel has its own test (overleaf-width-ui.test.js). Runs in a real browser and is
// skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PRECACHE } = require('../sw.js');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };

const DOC = String.raw`\documentclass{article}
\begin{document}
\section{One}
Some words.\marginpar{A margin note.} \label{a}See Section~\ref{a}.
${Array.from({ length: 20 }, (_, k) => `Filler paragraph ${k} with enough words to fill a line or two of the column.`).join('\n\n')}
\section{Two}
More words.
\end{document}`;

async function open(browser, ctxOpts, width) {
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
  await ctx.addInitScript(([d, w]) => {
    if (!localStorage.getItem('texglass:last')) {
      localStorage.setItem('texglass:last', d);
      localStorage.setItem('texglass:last-name', 'paper.tex');
      if (w) localStorage.setItem('texglass:text-width', w);
    }
  }, [DOC, width || '']);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
  await page.route(/^https?:\/\/(?!texglass\.test)/, (route) => route.fulfill({ status: 503, body: '' }));
  await page.goto('http://texglass.test/index.html');
  await page.waitForSelector('#preview a.ref');
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

/** The text's width on screen: the column without the margin notes' room. */
const textWidth = (page) => page.evaluate(() => {
  const p = document.getElementById('preview');
  const cs = getComputedStyle(p);
  return Math.round(p.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 32);
});

async function drag(page, side, dx) {
  const g = await page.locator('.text-resizer-' + side).boundingBox();
  await page.mouse.move(g.x + 5, 300);
  await page.mouse.down();
  await page.mouse.move(g.x + 5 + dx, 300, { steps: 4 });
  await page.mouse.up();
}

async function launch(t) {
  try { return await playwright.chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return null; }
}

test('textwidth.js is loaded by the viewer, the VS Code preview and the Overleaf panel, and cached offline', () => {
  assert.ok(PRECACHE.includes('src/textwidth.js'));
  assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /src="src\/textwidth\.js"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'browser/src/overleaf.html'), 'utf8'), /src="src\/textwidth\.js"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'vscode/extension.js'), 'utf8'), /res\('shared', 'textwidth\.js'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'vscode/scripts/copy-shared.js'), 'utf8'), /'src\/textwidth\.js'/);
});

test('the viewer: grips widen, narrow, fill and reset the text beside the margin notes, and are remembered', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const { page, errors } = await open(browser, { viewport: { width: 1500, height: 700 } });
    assert.ok(await page.evaluate(() => document.getElementById('preview').classList.contains('tg-with-margin')), 'the margin column is there');
    assert.equal(await textWidth(page), 760, 'the usual width');
    const marginGap = () => page.evaluate(() => {
      const text = document.getElementById('preview');
      const cs = getComputedStyle(text);
      const right = text.getBoundingClientRect().right - parseFloat(cs.paddingRight);
      return Math.round(document.querySelector('.tg-margin').getBoundingClientRect().left - right);
    });
    const gap = await marginGap();

    await drag(page, 'right', 50);
    assert.equal(await textWidth(page), 860, 'the column stays centred, so the text grows by twice the drag');
    assert.equal(await page.evaluate(() => localStorage.getItem('texglass:text-width')), '860');
    assert.equal(await marginGap(), gap, 'the margin notes move along with the text');
    await drag(page, 'left', 150);
    assert.equal(await textWidth(page), 560);

    await page.reload();
    await page.waitForSelector('#preview a.ref');
    assert.equal(await textWidth(page), 560, 'remembered');

    await drag(page, 'right', 1000);
    assert.equal(await page.evaluate(() => localStorage.getItem('texglass:text-width')), 'full');
    assert.ok(await page.evaluate(() => document.documentElement.classList.contains('tg-text-full')));
    const fill = await page.evaluate(() => [document.getElementById('preview').getBoundingClientRect().width, document.getElementById('preview-pane').clientWidth]);
    assert.ok(Math.abs(fill[0] - fill[1]) < 2, 'fills the pane');

    await page.dblclick('.text-resizer-right');
    assert.equal(await textWidth(page), 760, 'double-click goes back to the usual width');
    assert.equal(await page.evaluate(() => localStorage.getItem('texglass:text-width')), '');

    await page.focus('.text-resizer-left');
    await page.keyboard.press('ArrowRight');
    assert.equal(await textWidth(page), 720, 'arrow keys move the focused edge');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('the viewer: no grip under the side panel when it is a drawer over the text', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const { page } = await open(browser, { viewport: { width: 700, height: 700 } });
    assert.equal(await page.locator('.text-resizer-left').isVisible(), true, 'grips in a narrow window');
    await page.click('#more'); // in a narrow window Contents is in the "…" menu
    await page.click('#toc-toggle');
    await page.waitForSelector('#toc-pane:not([hidden])');
    await page.waitForTimeout(300);
    const under = await page.evaluate(() => {
      const toc = document.getElementById('toc-pane').getBoundingClientRect();
      return [...document.querySelectorAll('.text-resizer')].filter((g) => {
        if (g.hidden) return false;
        const r = g.getBoundingClientRect();
        return r.left < toc.right && r.right > toc.left;
      }).length;
    });
    assert.equal(under, 0, 'no grip inside the side panel');
  } finally {
    await browser.close();
  }
});

test('on a phone: no grips, and the text takes the screen whatever width was set', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const { page } = await open(browser, playwright.devices['iPhone 13'], '300');
    assert.equal(await page.locator('.text-resizer-left').isVisible(), false);
    const w = await page.evaluate(() => [document.getElementById('preview').getBoundingClientRect().width, document.getElementById('preview-pane').clientWidth]);
    assert.ok(Math.abs(w[0] - w[1]) < 2, `the text is as wide as the screen (${w})`);
  } finally {
    await browser.close();
  }
});
