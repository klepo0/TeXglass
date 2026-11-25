'use strict';
// The web viewer on phones and tablets: the compact toolbar, the side panel and
// the margin as drawers (swiped in from the edges), previews in a sheet at the
// bottom opened by a tap, display formulas that break onto more lines, writing
// in the margin with a pen, and the web app manifest. The browser parts run in
// emulated phones and tablets and are skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { inkPath, inkSvg } = require('../src/margin.js');
const { PRECACHE } = require('../sw.js');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const DOC = String.raw`\documentclass{article}
\usepackage{amsthm}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\begin{document}
\section{Introduction}
We study the heat equation $\partial_t u = \Delta u$ on a torus.\marginpar{An author's margin note.} The main result is Theorem~\ref{thm:main}, which relies on Lemma~\ref{lem:a}.
\begin{equation}\label{eq:est}
\|u(t)\|_{L^2} \le e^{-\lambda t}\|u(0)\|_{L^2} + \int_0^t e^{-\lambda(t-s)} \|f(s)\|_{L^2}\,ds + \sum_{k=1}^\infty \frac{1}{k^2} + \sum_{j=1}^\infty \frac{1}{j^3}.
\end{equation}
\section{Estimates}
\begin{lemma}\label{lem:a}
Let $u$ be a smooth solution. Then $\frac{d}{dt}\|u\|^2 \le -2\lambda \|u\|^2$.
\end{lemma}
${Array.from({ length: 12 }, (_, k) => `Filler paragraph ${k} with enough words to make the page scroll on a phone screen.`).join('\n\n')}
\section{Main result}
\begin{theorem}\label{thm:main}
Every solution decays exponentially, by Lemma~\ref{lem:a}.
\end{theorem}
\end{document}`;

test('pen strokes become one compact SVG path, and only well-formed ones are drawn', () => {
  assert.equal(inkPath([[1, 2, 3, 4, 3, 4, 6, 1]]), 'M1 2l2 2 3-3');
  assert.equal(inkPath([[5.4, 5.6]]), 'M5 6l0 0'); // a dot
  assert.equal(inkPath([[0, 0, 1, 1], [10, 10, 9, 12]]), 'M0 0l1 1M10 10l-1 2');
  const svg = inkSvg({ w: 40, h: 20, d: 'M0 0l1 1' });
  assert.match(svg, /^<svg class="tg-ink" viewBox="0 0 40 20"/);
  assert.match(svg, /d="M0 0l1 1"/);
  // notes come from files and gists: anything that is not a plain path is not drawn
  assert.equal(inkSvg({ w: 40, h: 20, d: 'M0 0"/><script>alert(1)</script>' }), '');
  assert.equal(inkSvg({ w: 40, h: 20 }), '');
  assert.equal(inkSvg(null), '');
  assert.match(inkSvg({ w: '1e9', h: -5, d: 'M0 0' }), /viewBox="0 0 4000 1"/);
});

test('the web app manifest names the viewer and its icons, and they are cached for offline use', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'TeXglass');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '192x192'));
  assert.ok(PRECACHE.includes('manifest.webmanifest'));
  for (const i of m.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src);
    assert.ok(PRECACHE.includes(i.src), `${i.src} is not in sw.js PRECACHE`);
  }
});

async function open(browser, device) {
  const ctx = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await ctx.addInitScript((d) => {
    if (!localStorage.getItem('texglass:last')) {
      localStorage.setItem('texglass:last', d);
      localStorage.setItem('texglass:last-name', 'heat.tex');
    }
  }, DOC);
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

async function launch(t) {
  try {
    return await playwright.chromium.launch();
  } catch (e) {
    t.skip('no browser: ' + e.message.split('\n')[0]);
    return null;
  }
}

test('on a phone: one row of large buttons, drawers, formulas that fit, previews in a sheet', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const { page, errors } = await open(browser, playwright.devices['iPhone 13']);

    // the toolbar: one row; the rest is at the top of the "…" menu
    const bar = await page.evaluate(() => ({
      h: document.querySelector('.toolbar').offsetHeight,
      inMenu: !!document.querySelector('#more-compact #mode-split') && !!document.querySelector('#more-compact .zoom-group'),
      wide: document.documentElement.scrollWidth > innerWidth,
      small: [...document.querySelectorAll('.toolbar > button:not([hidden]), .toolbar .more-button')].filter((b) => b.offsetParent && b.offsetHeight < 44).map((b) => b.id),
    }));
    assert.ok(bar.h < 70, `toolbar is one row (${bar.h}px)`);
    assert.ok(bar.inMenu, 'mode switch and zoom moved into the menu');
    assert.equal(bar.wide, false, 'nothing runs off the side of the page');
    assert.deepEqual(bar.small, [], 'toolbar buttons are at least 44px tall');
    await page.tap('#more');
    assert.equal(await page.locator('#more-compact #mode-split').isVisible(), true);
    await page.tap('#more-compact #mode-edit');
    assert.equal(await page.locator('#more-menu').isHidden(), true, 'choosing a mode closes the menu');
    assert.equal(await page.getAttribute('#mode-edit', 'aria-pressed'), 'true');
    await page.tap('#more');
    await page.tap('#more-compact #mode-preview');

    // the long display formula breaks onto more lines and fits the screen
    const math = await page.evaluate(() => {
      const el = document.querySelector('#preview .math-display');
      return { reflow: el.classList.contains('tg-reflow'), fits: el.scrollWidth <= el.clientWidth + 1 };
    });
    assert.ok(math.reflow && math.fits, 'the wide display breaks and fits');

    // the margin: a closed drawer over the text, opened by its button, closed by a tap outside
    const before = await page.evaluate(() => document.querySelector('#preview').classList.contains('tg-margin-overlay'));
    assert.ok(before, 'margin is a drawer');
    await page.tap('.tg-margin-toggle');
    await page.waitForSelector('.tg-margin.tg-margin-drawer .tg-mcard-par:not([hidden])');
    await page.waitForTimeout(400); // it slides in
    const drawer = await page.evaluate(() => {
      const r = document.querySelector('.tg-margin').getBoundingClientRect();
      return { right: r.right, vw: document.documentElement.clientWidth };
    });
    assert.ok(Math.abs(drawer.right - drawer.vw) < 2, 'the drawer sits at the right edge ' + JSON.stringify(drawer));
    await page.tap('#preview h2 >> nth=1', { position: { x: 20, y: 5 } });
    assert.equal(await page.locator('.tg-margin-drawer').count(), 0, 'a tap outside closes it');

    // a tap on a reference opens a sheet at the bottom, not a jump
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    const link = page.locator('#preview a.ref', { hasText: '3.1' }).first();
    await link.tap();
    await page.waitForSelector('#ref-popover.tg-sheet:not([hidden]) .theorem');
    await page.waitForTimeout(400); // it slides up
    const sheet = await page.evaluate(() => {
      const r = document.querySelector('#ref-popover').getBoundingClientRect();
      return { bottom: r.bottom, left: r.left, width: r.width, vh: innerHeight, vw: document.documentElement.clientWidth, scroll: document.getElementById('preview-pane').scrollTop };
    });
    assert.ok(Math.abs(sheet.bottom - sheet.vh) < 2 && sheet.left === 0 && Math.abs(sheet.width - sheet.vw) < 2, 'a sheet across the bottom');
    assert.equal(sheet.scroll, 0, 'the tap did not jump');
    await page.tap('.tg-sheet-go');
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#ref-popover').isHidden(), true, 'Go there closes the sheet');
    assert.ok(await page.evaluate(() => document.getElementById('preview-pane').scrollTop > 0), 'and goes to the theorem');

    // a tap outside the sheet closes it
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    await link.tap();
    await page.waitForSelector('#ref-popover.tg-sheet:not([hidden])');
    await page.tap('#preview h2 >> nth=0', { position: { x: 60, y: 5 } });
    assert.equal(await page.locator('#ref-popover').isHidden(), true, 'a tap outside closes the sheet');

    // a swipe in from the left edge opens the side panel; a swipe back closes it
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (x0, x1, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
      for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * k) / 8, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    assert.equal(await page.locator('#toc-pane').isHidden(), true);
    await swipe(4, 200, 400);
    await page.waitForSelector('#toc-pane:not([hidden])');
    await swipe(250, 40, 400);
    await page.waitForSelector('#toc-pane', { state: 'hidden' });
    // from the right edge: the margin
    await swipe(386, 180, 400);
    await page.waitForSelector('.tg-margin.tg-margin-drawer');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('on a tablet: a pen writes a note in the margin; the page keeps its layout', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const { page, errors } = await open(browser, playwright.devices['iPad Mini']);
    // wider than a phone: the toolbar keeps its buttons and the margin is a column
    assert.equal(await page.locator('.toolbar > .mode-switch').count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector('#preview').classList.contains('tg-margin-overlay')), false);

    const at = await page.evaluate(() => {
      const r = document.querySelector('.tg-margin').getBoundingClientRect();
      const c = document.querySelector('.tg-mcard').getBoundingClientRect();
      return { x: r.left + 20, y: c.bottom + 60 };
    });
    const cdp = await page.context().newCDPSession(page);
    const pen = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen' });
    const scroll = await page.evaluate(() => document.getElementById('preview-pane').scrollTop);
    await pen('mousePressed', at.x, at.y);
    for (let k = 1; k <= 12; k++) await pen('mouseMoved', at.x + k * 5, at.y + (k % 4) * 4);
    await pen('mouseReleased', at.x + 60, at.y);
    await page.waitForSelector('.tg-ink-live path[d^="M"]');
    // written strokes become one note after a pause
    await page.waitForSelector('.tg-mcard-user .tg-ink', { timeout: 4000 });
    const saved = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((n) => n.startsWith('texglass:notes:'));
      return JSON.parse(localStorage.getItem(k)).notes;
    });
    assert.equal(saved.length, 1);
    assert.match(saved[0].ink.d, /^M\d+ \d+l/);
    assert.equal(saved[0].note, '');
    assert.equal(await page.evaluate(() => document.getElementById('preview-pane').scrollTop), scroll, 'the pen did not scroll the page');
    // a mouse in the margin does not draw
    await page.mouse.move(at.x, at.y + 120);
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y + 140);
    await page.mouse.up();
    await page.waitForTimeout(1600);
    assert.equal(await page.locator('.tg-mcard-user').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('on a phone: Settings ends with About TeXglass, linking to the repository', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const { page, errors } = await open(browser, playwright.devices['iPhone 13']);
    await page.tap('#more');
    await page.tap('#settings');
    const repo = page.locator('.features-dialog .features-about #about-repo');
    await repo.scrollIntoViewIfNeeded();
    assert.equal(await repo.isVisible(), true, 'the repository link can be reached');
    assert.equal(await repo.getAttribute('href'), 'https://github.com/klepo0/TeXglass');
    assert.equal(await repo.getAttribute('target'), '_blank');
    const version = require('../vscode/package.json').version;
    await page.waitForFunction((v) => document.querySelector('.features-about .about-version').textContent === `Version ${v}.`, version);
    const links = await page.locator('.features-about a').evaluateAll((as) => as.map((a) => a.href));
    assert.ok(links.some((h) => h.endsWith('/docs/GUIDE.md')), 'the guide');
    assert.ok(links.includes('https://buymeacoffee.com/texglass'), 'the support page');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
