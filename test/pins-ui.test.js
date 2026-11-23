'use strict';
// The pin in the toolbar (src/pins.js): one list of everything pinned — results
// and equations (the map's pins, also from a reference's preview), notation
// (the Notation tab's pins, also from a notation preview) and text pinned from
// the selection bar (src/margin.js). Also the toolbar's icon buttons (Open,
// Contents, Hide proofs) and OAI preprints in the "…" menu. Skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const DOC = '\\documentclass{article}\n\\title{Pins}\n\\newtheorem{lemma}{Lemma}[section]\n\\newtheorem{theorem}[lemma]{Theorem}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n\\maketitle\n\\section{Start}\n' +
  'Let $f\\colon \\R \\to \\R$ be smooth and write $\\Lambda := \\sup_x |f(x)|$.\n\\begin{equation}\\label{eq:a} \\Lambda = \\|f\\|_\\infty \\end{equation}\n' +
  '\\begin{lemma}[Bound]\\label{first} By \\eqref{eq:a}, $\\Lambda < \\infty$ on $\\R$.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  '\\begin{lemma}\\label{second} Second.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  'Middle words.\n\\begin{figure}\\centering A picture.\\caption{A figure}\\label{fig:one}\\end{figure}\nSee Figure~\\ref{fig:one}.\n\\begin{equation}\\label{eq:b} c = \\Lambda^2 \\end{equation}\n' +
  '\\begin{theorem}\\label{main} Last.\\end{theorem}\\begin{proof} By Lemmas~\\ref{first} and~\\ref{second}, and \\eqref{eq:b}.\\end{proof}\n\\end{document}';

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

test('the pin lists everything pinned, from previews, the Notation tab and a selection', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.setInputFiles('#file-input', { name: 'pins.tex', mimeType: 'text/x-tex', buffer: Buffer.from(DOC) });
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 3);
    const badge = () => page.$eval('#pins .tg-pins-badge', (b) => (b.hidden ? '' : b.textContent));

    // icons: Open, Contents, Hide proofs and the pin show no words, only their names for screen readers
    for (const id of ['open', 'toc-toggle', 'fold-proofs', 'pins']) {
      assert.equal(await page.isVisible(`#${id} .tb-icon`), true, id + ' shows its icon');
      assert.equal(await page.isVisible(`#${id} .tb-label`), false, id + ' hides its words');
      assert.ok(await page.getAttribute('#' + id, 'aria-label'), id + ' has a name');
    }
    assert.equal(await page.getAttribute('#fold-proofs', 'aria-label'), 'Hide proofs');
    await page.click('#fold-proofs');
    assert.equal(await page.getAttribute('#fold-proofs', 'aria-label'), 'Show proofs');
    await page.click('#fold-proofs');
    // OAI preprints moved into the "…" menu
    assert.equal(await page.isVisible('#preprints'), false);
    await page.click('#more');
    assert.equal(await page.isVisible('#preprints'), true);
    await page.keyboard.press('Escape');

    // nothing pinned: no count, and the list says how to pin
    assert.equal(await badge(), '');
    await page.click('#pins');
    assert.match(await page.textContent('.tg-pins-menu'), /Nothing pinned yet/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('.tg-pins-menu'), false);

    // a result from its reference's preview
    await page.locator('#preview .proof a.ref', { hasText: '1.1' }).first().hover();
    await page.waitForSelector('#ref-popover:not([hidden]) .tg-ref-pin');
    await page.click('#ref-popover .tg-ref-pin');
    assert.equal(await page.getAttribute('#ref-popover .tg-ref-pin', 'aria-pressed'), 'true');
    assert.equal(await badge(), '1');
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);
    // an equation from its preview
    await page.locator('#preview .proof a.ref', { hasText: '(2)' }).first().hover();
    await page.waitForSelector('#ref-popover:not([hidden]) .tg-ref-pin');
    await page.click('#ref-popover .tg-ref-pin');
    assert.equal(await badge(), '2');
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);

    // a figure, from its pin on hover; a preview's copy of the text has no dead second pin
    await page.locator('#preview figure.float').hover();
    await page.click('#preview figure.float > .tg-pin-btn');
    assert.equal(await badge(), '3');
    await page.mouse.move(5, 500);
    await page.locator('#preview a.ref', { hasText: '1.1' }).first().hover();
    await page.waitForSelector('#ref-popover:not([hidden])');
    const visiblePins = await page.$$eval('#ref-popover button', (bs) => bs.filter((b) => /pin/i.test(b.className) && b.getClientRects().length).length);
    assert.equal(visiblePins, 1, 'one pin on a preview');
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);
    // a proof, from its pin on hover: listed, and shown in full under Show only these
    const proof = page.locator('#preview .proof', { hasText: 'By Lemmas' });
    await proof.scrollIntoViewIfNeeded();
    await proof.hover();
    await page.click('#preview .proof:has-text("By Lemmas") > .tg-pin-btn');
    assert.equal(await badge(), '4');
    await page.mouse.move(5, 500);
    await page.click('#pins');
    assert.match(await page.textContent('.tg-pins-menu'), /Proof of Theorem 1\.3/);
    await page.click('.tg-pins-actions [data-pins-act="show"]');
    await page.waitForSelector('#preview.pick-view');
    assert.equal(await page.$eval('#preview .proof:has-text("By Lemmas")', (p) => p.classList.contains('pick-on') && !p.classList.contains('pick-proof')), true, 'a pinned proof shows in full');
    await page.keyboard.press('Escape');
    await page.click('#pins');
    await page.click('.tg-pins-row:has-text("Proof of") .tg-pins-x');
    await page.click('.tg-pins-row:has-text("Figure 1") .tg-pins-x');
    await page.keyboard.press('Escape');
    assert.equal(await badge(), '2');

        // a symbol from its notation preview
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    await page.waitForTimeout(200);
    const f = await page.locator('#preview .theorem .katex').first().boundingBox();
    await page.mouse.move(f.x + 2, f.y + f.height / 2);
    await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2, { steps: 3 });
    await page.waitForSelector('.insight-popover:not([hidden]) .insight-pop-pin', { timeout: 5000 });
    await page.click('.insight-popover:not([hidden]) .insight-pop-pin');
    assert.equal(await badge(), '3');
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);

    // text, from the selection bar
    await page.locator('#preview p', { hasText: 'Middle words' }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const mid = await page.locator('#preview p', { hasText: 'Middle words' }).first().boundingBox();
    await page.mouse.move(mid.x + 2, mid.y + mid.height / 2);
    await page.mouse.down();
    await page.mouse.move(mid.x + 150, mid.y + mid.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForSelector('.tg-hlbar:not([hidden])');
    await page.click('.tg-hlbar-pin');
    assert.equal(await badge(), '4');

    // the list: grouped, jump on click, × unpins
    await page.click('#pins');
    const titles = await page.$$eval('.tg-pins-title', (els) => els.map((e) => e.textContent));
    assert.deepEqual(titles, ['Results', 'Equations', 'Notation', 'Text']);
    const text = await page.textContent('.tg-pins-menu');
    assert.match(text, /Lemma 1\.1/);
    assert.match(text, /\(2\)/);
    assert.match(text, /Middle words/);
    assert.equal(await page.isVisible('.tg-pins-actions [data-pins-act="show"]'), true, 'Show only these');
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    await page.click('.tg-pins-row:has-text("Middle words") .tg-pins-go');
    assert.equal(await page.isVisible('.tg-pins-menu'), false, 'a jump closes the list');
    await page.click('#pins');
    await page.click('.tg-pins-row:has-text("Lemma 1.1") .tg-pins-x');
    assert.equal(await badge(), '3');
    assert.doesNotMatch(await page.textContent('.tg-pins-menu'), /Lemma 1\.1/, 'the list follows');
    // Show only these keeps the paragraph holding the pinned text in view
    await page.keyboard.press('Escape');
    await page.click('#pins');
    await page.click('.tg-pins-actions [data-pins-act="show"]');
    await page.waitForSelector('#preview.pick-view');
    assert.equal(await page.isVisible('#preview p:has-text("Middle words")'), true, 'the pinned text\'s paragraph shows');
    assert.equal(await page.isVisible('#preview .math-display:has-text("(2)")'), true, 'the pinned equation shows');
    assert.equal(await page.isVisible('#preview .theorem:has-text("Second")'), false, 'the rest is hidden');
    await page.keyboard.press('Escape');
    // the text pin is a highlight marked pin, kept with the notes
    const pinned = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'));
    assert.match(pinned, /"quote":"Middle words\."[^}]*\}[^}]*"pin":true/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('on a phone the pin moves into the "…" menu and the list opens as a sheet', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    assert.equal(await page.isVisible('#pins'), false);
    // Contents is not in the phone toolbar either: it is in the "…" menu (and a swipe opens it)
    assert.equal(await page.isVisible('#toc-toggle'), false);
    await page.click('#more');
    assert.equal(await page.isVisible('#more-compact #toc-toggle .tb-label'), true);
    await page.click('#toc-toggle');
    await page.waitForTimeout(300);
    assert.equal(await page.isVisible('#toc-pane'), true, 'Contents opens the side panel');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.click('#more');
    assert.equal(await page.isVisible('#more-compact #pins'), true);
    assert.equal(await page.isVisible('#more-compact #pins .tb-label'), true, 'with its name in the menu');
    await page.click('#pins');
    assert.equal(await page.isVisible('.tg-pins-menu.tg-pins-sheet'), true);
    const box = await page.locator('.tg-pins-menu').boundingBox();
    assert.ok(Math.abs(box.y + box.height - 800) < 2, 'at the bottom of the screen');
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(scroll, true, 'no sideways scrolling');
  } finally {
    await browser.close();
  }
});
