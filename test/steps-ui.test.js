'use strict';
// Stepping through a proof (src/steps.js) in the web viewer: one piece at a
// time, nested parts folding once passed, references keeping their previews,
// and the page put back as it was afterwards. Skipped where Playwright and a
// browser are not installed.
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
  '\\newtheorem{theorem}{Theorem}',
  '\\newtheorem{lemma}[theorem]{Lemma}',
  '\\newtheorem{claim}{Claim}',
  '\\begin{document}',
  '\\begin{lemma}\\label{lem:a} Every bounded widget converges.\\end{lemma}',
  '\\begin{theorem}\\label{thm:b} Every widget converges.\\end{theorem}',
  '\\begin{proof}',
  'Fix a widget $w$. We show it is bounded, then apply Lemma~\\ref{lem:a}. The idea is from \\cite{K}.',
  '\\begin{claim} The widget is monotone.\\end{claim}',
  '\\begin{proof} Compare neighbours. Each is larger. Hence it is monotone.\\end{proof}',
  'We split into two cases.',
  '',
  '\\textbf{Case 1.} $w$ is small. Then it is bounded by one. So it is bounded.',
  '',
  '\\textbf{Case 2.} $w$ is large. Then it is bounded by two. So it is bounded.',
  '',
  'In both cases $w$ is bounded, so it converges.',
  '\\end{proof}',
  '\\begin{proof}[Short] Clear.\\end{proof}',
  '\\begin{thebibliography}{9}\\bibitem{K} A. Author, A book, 2000.\\end{thebibliography}',
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

async function open(browser, contextOpts) {
  const context = await browser.newContext(contextOpts);
  await serve(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((doc) => {
    if (!localStorage.getItem('texglass:last')) {
      localStorage.setItem('texglass:last', doc);
      localStorage.setItem('texglass:last-name', 'widgets.tex');
    }
  }, DOC);
  await page.goto('http://texglass.test/index.html');
  await page.waitForSelector('#preview .tg-step-btn');
  return { context, page, errors };
}

const state = (page) => page.evaluate(() => {
  const now = document.querySelector('.tg-step-now');
  return {
    count: (document.querySelector('.tg-step-count') || {}).textContent || null,
    now: now ? (() => { const c = now.cloneNode(true); c.querySelectorAll('.katex-mathml, .tg-step-fold').forEach((x) => x.remove()); return c.textContent; })().replace(/▾ fold|▸ \d+ more/g, '').replace(/\s+/g, ' ').trim() : null,
    folds: Array.from(document.querySelectorAll('.tg-step-fold')).map((f) => (f.hidden ? '' : f.textContent)),
    shown: Array.from(document.querySelectorAll('.tg-stepping .tg-step')).filter((el) => el.offsetParent || el.getClientRects().length).length,
  };
});

test('step through a proof in the web viewer', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, { viewport: { width: 1100, height: 800 } });
    // one button: the short proof has too few pieces
    assert.equal(await page.locator('.tg-step-btn').count(), 1);
    // (without the buttons other tools add when idle)
    const html = () => page.evaluate(() => {
      const c = document.querySelector('#preview .proof').cloneNode(true);
      c.querySelectorAll('button, .rp-marks').forEach((b) => b.remove());
      return c.innerHTML;
    });
    await page.waitForTimeout(300);
    const before = await html();

    await page.locator('.tg-step-btn').click();
    let s = await state(page);
    assert.match(s.count, /^1 \/ \d+$/);
    const total = Number(s.count.split('/')[1]);
    assert.equal(s.now, 'Fix a widget w.');
    assert.equal(s.shown, 1);

    await page.keyboard.press('ArrowRight');
    s = await state(page);
    assert.match(s.now, /^We show it is bounded, then apply Lemma/);
    // no extra chips: resting on the reference shows its usual preview
    assert.equal(await page.locator('.tg-why').count(), 0);
    await page.locator('.tg-step-now a.ref').hover();
    await page.waitForSelector('#ref-popover:not([hidden])');
    assert.match(await page.locator('#ref-popover').textContent(), /Every bounded widget converges/);
    // still at the same piece; Esc closes the preview first
    assert.equal((await state(page)).count, s.count);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#ref-popover').isHidden(), true);
    assert.ok(await page.locator('.tg-stepping').count());

    // the claim and its proof: one nested part, folded once passed
    await page.keyboard.press('ArrowRight'); // the citation sentence
    await page.keyboard.press('ArrowRight'); // the claim
    s = await state(page);
    assert.match(s.now, /^Claim 1\. The widget is monotone\./);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight'); // its proof's three sentences
    assert.match((await state(page)).now, /^Hence it is monotone/);
    await page.keyboard.press('ArrowRight');
    s = await state(page);
    assert.equal(s.now, 'We split into two cases.');
    assert.equal(s.folds[0], '▸ 3 more');
    // open it again, fold it again
    await page.locator('.tg-step-fold', { hasText: '3 more' }).click();
    assert.equal((await state(page)).folds[0], '▾ fold');
    await page.locator('.tg-step-fold', { hasText: 'fold' }).first().click();
    assert.equal((await state(page)).folds[0], '▸ 3 more');

    // "Case 1." and its sentences fold once Case 2 starts; the closing sentence is not part of Case 2
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    s = await state(page);
    assert.match(s.now, /^Case 2\./);
    assert.deepEqual(s.folds.filter(Boolean), ['▸ 3 more', '▸ 2 more']);
    // a click on the text shows the next piece; ← goes back
    await page.locator('.tg-step-now').click();
    assert.match((await state(page)).now, /^Then it is bounded by two/);
    await page.keyboard.press('ArrowLeft');
    assert.match((await state(page)).now, /^Case 2\./);
    await page.keyboard.press('End');
    s = await state(page);
    assert.equal(s.count, `${total} / ${total}`);
    assert.match(s.now, /^In both cases/);
    assert.equal(s.folds.filter((f) => f === '▸ 2 more').length, 2);
    assert.equal(await page.locator('.tg-step-next').textContent(), 'Done');

    // Done (or Esc, or Show all) puts the proof back exactly as it was
    await page.locator('.tg-step-next').click();
    assert.equal(await page.locator('.tg-stepping').count(), 0);
    assert.equal(await html(), before);

    // Settings switch
    await page.evaluate(() => { localStorage.setItem('texglass:feature-proofSteps', '0'); });
    await page.reload();
    await page.waitForSelector('#preview .proof .rp-marks, #preview .proof');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.tg-step-btn').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('a piece runs on to its full stop, over displayed equations', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const doc = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\begin{proof}',
      'Fix a widget $w$, and note that, by the bound,',
      '\\begin{equation} w \\le 1, \\end{equation}',
      'where $1$ is the unit. Then',
      '\\begin{equation*} w^2 \\le w. \\end{equation*}',
      'So $w$ is small, as $w \\le 1$. It follows.',
      '\\end{proof}',
      '\\end{document}',
    ].join('\n');
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await serve(context);
    const page = await context.newPage();
    await page.addInitScript((d) => { localStorage.setItem('texglass:last', d); }, doc);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview .tg-step-btn');
    await page.locator('.tg-step-btn').click();
    const piece = () => page.evaluate(() => Array.from(document.querySelectorAll('.tg-step-now')).map((el) => {
      if (el.matches('.math-display')) return '[' + el.dataset.tex.trim() + ']';
      const c = el.cloneNode(true);
      c.querySelectorAll('.katex-mathml, .tg-step-fold').forEach((x) => x.remove());
      return c.textContent.replace(/\s+/g, ' ').trim();
    }).join(' '));
    // no cut at the commas or at the first display, which ends with a comma
    assert.equal(await piece(), 'Fix a widget w, and note that, by the bound, [w \\le 1,] where 1 is the unit.');
    await page.keyboard.press('ArrowRight');
    // the second display ends with its own full stop
    assert.equal(await piece(), 'Then [w^2 \\le w.]');
    await page.keyboard.press('ArrowRight');
    assert.equal(await piece(), 'So w is small, as w≤1.');
    await page.keyboard.press('ArrowRight');
    assert.equal(await piece(), 'It follows.∎');
    assert.equal(await page.locator('.tg-step-count').textContent(), '4 / 4');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#preview .math-display:visible').count(), 1);
  } finally {
    await browser.close();
  }
});

test('author step marks replace guessed sentences', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await open(browser, { viewport: { width: 1100, height: 800 } });
    await page.evaluate(() => {
      // texglass.sty's \tgstep renders as an empty marker
      const p = document.querySelector('#preview .proof > p:first-child');
      const text = Array.from(p.childNodes).find((n) => n.nodeType === 3 && /We show/.test(n.nodeValue));
      const at = text.nodeValue.indexOf('We show');
      const rest = text.splitText(at);
      const mark = document.createElement('span');
      mark.className = 'tg-stepmark';
      mark.dataset.tgStep = 'Bound';
      rest.before(mark);
    });
    await page.locator('.tg-step-btn').click();
    let s = await state(page);
    assert.equal(s.now, 'Fix a widget w.');
    await page.keyboard.press('ArrowRight');
    s = await state(page);
    // up to the end of the paragraph: no cut at "Lemma 1. The idea"
    assert.match(s.now, /^We show it is bounded.*The idea is from \[1\]\.$/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.tg-stepping').count(), 0);
  } finally {
    await browser.close();
  }
});

test('on a phone a tap steps, and a tap on a reference opens its sheet', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, { viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true });
    await page.locator('.tg-step-btn').tap();
    await page.locator('.tg-step-now').tap();
    assert.match((await state(page)).now, /^We show it is bounded/);
    const count = await page.locator('.tg-step-count').textContent();
    await page.locator('.tg-step-now a.ref').tap();
    await page.waitForSelector('#ref-popover:not([hidden])');
    assert.equal(await page.locator('.tg-step-count').textContent(), count, 'a tap on a reference does not step');
    const box = await page.locator('#ref-popover').boundingBox();
    assert.ok(box.y + box.height >= 760 - 2, 'the preview sits at the bottom of the screen');
    assert.equal(await page.locator('.tg-sheet-go').count(), 1);
    // the bar's buttons are large enough to tap
    const next = await page.locator('.tg-step-next').boundingBox();
    assert.ok(next.height >= 40);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
