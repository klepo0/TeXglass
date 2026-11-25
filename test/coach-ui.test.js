'use strict';
// The first-run tour (src/coach.js): where its card goes, and in the web viewer:
// it shows once, points at real controls, can be skipped, and comes back from
// the … menu and Settings; on a phone its card is a sheet at the bottom.
// The browser parts are skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { place } = require('../src/coach.js');
const { PRECACHE } = require('../sw.js');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.tex': 'text/plain', '.md': 'text/plain', '.svg': 'image/svg+xml' };

const DOC = String.raw`\documentclass{article}
\usepackage{amsthm}
\newtheorem{theorem}{Theorem}
\newtheorem{lemma}[theorem]{Lemma}
\begin{document}
\section{Introduction}
The main result is Theorem~\ref{thm:main}, which relies on Lemma~\ref{lem:a}.
\begin{lemma}\label{lem:a}
Let $u$ be smooth. Then $u^2 \ge 0$.
\end{lemma}
\begin{proof}
Squares are not negative. Hence the claim.
\end{proof}
\begin{theorem}\label{thm:main}
Every solution decays, by Lemma~\ref{lem:a}.
\end{theorem}
\end{document}`;

test('the card goes below its control, above it, beside it, or in a sheet on a phone', () => {
  const win = { w: 1200, h: 800 };
  const card = { w: 360, h: 160 };
  const r = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const below = place(r(100, 10, 40, 30), card, win, false);
  assert.ok(below.top > 40 && below.left >= 10, 'below a toolbar button');
  const above = place(r(100, 700, 40, 30), card, win, false);
  assert.ok(above.top + card.h < 700, 'above a control near the bottom');
  const side = place(r(10, 100, 200, 650), card, win, false);
  assert.ok(side.left > 210, 'beside a tall panel');
  const mid = place(null, card, win, false);
  assert.equal(Math.round(mid.left), (1200 - 360) / 2, 'nothing to point at: in the middle');
  assert.ok(place(r(1180, 10, 20, 20), card, win, false).left + card.w <= 1190, 'kept inside the window');
  assert.equal(place(r(10, 10, 40, 40), card, { w: 390, h: 800 }, true).sheet, 'bottom');
  assert.equal(place(r(10, 700, 40, 40), card, { w: 390, h: 800 }, true).sheet, 'top', 'a control down there: the sheet goes to the top');
});

test('the tour is cached for offline use and loaded by the viewer and VS Code', () => {
  assert.ok(PRECACHE.includes('src/coach.js'));
  assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /<script defer src="src\/coach\.js"><\/script>/);
  assert.match(fs.readFileSync(path.join(ROOT, 'vscode/extension.js'), 'utf8'), /res\('shared', 'coach\.js'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'vscode/scripts/copy-shared.js'), 'utf8'), /'src\/coach\.js', 'coach\.js'/);
});

async function open(browser, device, query, person) {
  const ctx = await browser.newContext({ ...device, serviceWorkers: 'block' });
  // a person's browser, not an automated one: the tour shows on its own
  if (person) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
  await ctx.addInitScript((d) => {
    if (!localStorage.getItem('texglass:last')) {
      localStorage.setItem('texglass:last', d);
      localStorage.setItem('texglass:last-name', 'decay.tex');
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
  await page.goto('http://texglass.test/index.html' + (query || ''));
  await page.waitForSelector('#preview a.ref');
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

const title = (page) => page.locator('.tg-coach-title').textContent();
// the lit-up rectangle covers the element (once it has slid there)
const lit = async (page, sel) => (await page.waitForTimeout(300), page.evaluate((s) => {
  const spot = document.querySelector('.tg-coach-spot');
  const el = document.querySelector(s);
  if (!spot || spot.hidden || !el) return false;
  const a = spot.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1;
}, sel));

test('web viewer: the tour points at the controls, ends with Esc or Skip, and comes back from the … menu and Settings', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    // automated browsers (every other test) don't get it unasked
    {
      const { ctx, page } = await open(browser, { viewport: { width: 1280, height: 800 } });
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('.tg-coach-card').count(), 0, 'no tour in an automated browser unless asked');
      await ctx.close();
    }
    // a first visit
    const { ctx, page, errors } = await open(browser, { viewport: { width: 1280, height: 800 } }, '', true);
    await page.waitForSelector('.tg-coach-card');
    assert.equal(await title(page), 'Open a paper');
    assert.ok(await lit(page, '#open'), 'Open is lit up');
    assert.equal(await page.evaluate(() => localStorage.getItem('texglass:coach')), 'seen', 'remembered at once');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.coach), 'next', 'Next has the focus');

    // the page's own keys don't fire under the tour
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('#arxiv-dialog[open]').count(), 0, 'Ctrl+K does not open the dialog under the tour');

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    assert.equal(await title(page), 'The side panel');
    assert.ok(await lit(page, '#toc-pane'));
    await page.click('[data-coach="next"]');
    await page.waitForTimeout(100);
    assert.equal(await title(page), 'Navigate');
    assert.ok(await lit(page, '#find'));
    await page.click('[data-coach="next"]');
    await page.waitForTimeout(100);
    assert.equal(await title(page), 'Reading the paper');
    assert.ok(await lit(page, '#preview .theorem'), 'a result in the text');
    const opac = await page.evaluate(() => [...document.querySelectorAll('.tg-coach-hot .tg-pin-btn, .tg-coach-hot .uses-btn')].map((b) => getComputedStyle(b).opacity));
    assert.ok(opac.length && opac.every((o) => o === '1'), `its buttons show (${opac})`);
    await page.click('[data-coach="back"]');
    await page.waitForTimeout(100);
    assert.equal(await title(page), 'Navigate', 'Back');
    assert.equal(await page.locator('.tg-coach-hot').count(), 0, 'the result lets go of its buttons');
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(80); }
    assert.equal(await title(page), 'Share, save, go back');
    assert.ok(await lit(page, '#share'));
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    assert.ok(await lit(page, '#settings'), 'the last card points at Settings');
    assert.equal(await page.locator('[data-coach="extra"]').textContent(), 'Try it on a paper');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.tg-coach-card, .tg-coach-veil, .tg-coach-spot').count(), 0, 'Esc ends it, nothing left behind');

    // not again on the next visit
    await page.reload();
    await page.waitForSelector('#preview a.ref');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.tg-coach-card').count(), 0);

    // again from the … menu, and Skip ends it
    await page.click('#more');
    await page.click('#coach-open');
    await page.waitForSelector('.tg-coach-card');
    assert.equal(await page.locator('#more-menu').isHidden(), true, 'the menu closes');
    await page.click('[data-coach="skip"]');
    assert.equal(await page.locator('.tg-coach-card').count(), 0);

    // and from Settings
    await page.click('#settings');
    await page.click('.features-dialog .features-extra .link-button');
    await page.waitForSelector('.tg-coach-card');
    assert.equal(await page.locator('.features-dialog[open]').count(), 0, 'Settings closes');
    assert.equal(await title(page), 'Open a paper');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
  }
});

test('web viewer on a phone: cards in a sheet, the side panel as its drawer, … for the rest', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const { ctx, page, errors } = await open(browser, playwright.devices['iPhone 13'], '?coach');
    await page.waitForSelector('.tg-coach-card');
    const sheet = await page.evaluate(() => {
      const c = document.querySelector('.tg-coach-card').getBoundingClientRect();
      return { sheet: document.querySelector('.tg-coach-card').dataset.sheet, bottom: Math.round(c.bottom), w: Math.round(c.width), H: innerHeight, W: innerWidth };
    });
    assert.equal(sheet.sheet, 'bottom');
    assert.equal(sheet.bottom, sheet.H);
    assert.equal(sheet.w, sheet.W, 'full width');
    assert.ok(await lit(page, '#more'), 'Open is in …, so the first card points there');
    await page.tap('[data-coach="next"]');
    await page.waitForTimeout(250);
    assert.equal(await title(page), 'The side panel');
    assert.equal(await page.locator('#toc-pane').isVisible(), true, 'the drawer opens for its card');
    await page.tap('[data-coach="next"]');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#toc-pane').isVisible(), false, 'and closes after');
    for (let i = 0; i < 4; i++) { await page.tap('[data-coach="next"]'); await page.waitForTimeout(150); }
    assert.ok(await lit(page, '#settings'), 'the last card points at the gear, first in the toolbar');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'nothing runs off the side');
    await page.tap('[data-coach="next"]');
    assert.equal(await page.locator('.tg-coach-card').count(), 0, 'Done ends it');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
  }
});
