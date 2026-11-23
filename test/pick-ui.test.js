'use strict';
// Show pinned results (src/pick.js): pin results and numbered equations,
// see only those with their proofs folded, and print exactly that; also the
// print of "What does this use?" with Hide the rest, and the same view
// applied to a page rendered again for printing (src/export.js, VS Code).
// Runs in a real browser and is skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const TeXglassExport = require('../src/export.js');
const TeXglassPick = require('../src/pick.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

const DOC = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}
\newtheorem{lemma}{Lemma}
\numberwithin{equation}{section}
\title{A made-up paper}
\begin{document}
\maketitle
\section{Start}
Opening words.
\begin{equation}\label{e:a} a = b \end{equation}
\begin{theorem}\label{t:one} Every widget is blue. \end{theorem}
\begin{proof} First step of the proof.

Second step of the proof, using \eqref{e:a}. \end{proof}
\begin{lemma}\label{l:one} An unrelated lemma. \end{lemma}
\begin{proof} Lemma proof. \end{proof}
\section{Middle}
Nothing picked here.
\begin{equation} c = d \end{equation}
\section{End}
More words.
\begin{equation}\label{e:b} x + y = z \end{equation}
\begin{equation*} \text{unnumbered} \end{equation*}
\end{document}`;

test('the view blocks are counted the same way by pick.js and export.js', () => {
  assert.equal(TeXglassPick.BLOCKS, TeXglassExport.VIEW_BLOCKS);
  const src = fs.readFileSync(path.join(ROOT, 'src/pick.js'), 'utf8');
  assert.ok(src.includes(`const OUTSIDE = '${TeXglassExport.VIEW_OUTSIDE}'`));
});

test('a printed page carries the view only when one is given', () => {
  assert.ok(!TeXglassExport.page({ body: '<p>x</p>', print: true }).includes('tg-view-hide\')'));
  const html = TeXglassExport.page({ body: '<p>x</p>', print: true, view: { n: 1, keep: [0] } });
  assert.ok(html.includes('{"n":1,"keep":[0]}'));
  // nothing from the view can break out of the script
  const odd = TeXglassExport.page({ body: '', print: true, view: { n: '</script>', keep: ['<b>'] } });
  assert.ok(!/<\/script><b>/.test(odd) && odd.includes('{"n":0,"keep":[0]}'));
});

test('Show pinned results shows only the pinned items, proofs folded, and prints that', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath, sourceMap: true });
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const p = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await p.setContent(
      `<style>${css}</style>` +
      `<section class="pane" id="pane" style="height:100vh;overflow:auto"><article id="preview" class="document">${r.blocks.join('\n')}</article></section>`
    );
    await p.addScriptTag({ path: path.join(ROOT, 'src/insight.js') });
    await p.addScriptTag({ path: path.join(ROOT, 'src/pick.js') });
    await p.evaluate(() => {
      const root = document.getElementById('preview');
      window.printed = 0;
      window.insight = TeXglassInsight.attach({ root, jump: () => {}, print: () => window.printed++, onFocusStart: () => window.pick.stop() });
      window.pick = TeXglassPick.attach({
        root,
        jump: () => {},
        proofsOf: (el) => { const n = window.insight.graph().byEl.get(el); return n ? n.proofs : null; },
        print: () => window.printed++,
        onStart: () => window.insight.unfocus(),
      });
      window.pick.start();
    });
    // Every result and numbered equation can be ticked; the unnumbered one cannot.
    const boxes = await p.evaluate(() => Array.from(document.querySelectorAll('.pick-box')).map((b) => b.getAttribute('aria-label')));
    assert.deepEqual(boxes, ['Pin (1.1)', 'Pin Theorem 1', 'Pin Lemma 1', 'Pin (2.1)', 'Pin (3.1)']);

    // Tick Theorem 1 and (3.1) by clicking them; a link inside does not jump.
    await p.click('#preview .theorem:not(.thm-env-lemma)');
    await p.click('.math-display:has(.tag) >> nth=2');
    assert.match(await p.textContent('.pick-bar'), /2 items pinned.*Theorem 1, \(3\.1\)/);
    await p.click('.pick-bar [data-act="show"]');

    const state = (media) => p.evaluate(() => {
      const shown = (el) => el.getClientRects().length > 0;
      return {
        thms: Array.from(document.querySelectorAll('#preview .theorem')).filter(shown).map((el) => el.querySelector('.thm-name').textContent),
        eqs: Array.from(document.querySelectorAll('#preview .math-display')).filter(shown).map((el) => (el.querySelector('.tag') || {}).textContent || '*'),
        heads: Array.from(document.querySelectorAll('#preview h2')).filter(shown).map((h) => h.textContent.replace(/\s+/g, ' ').trim()),
        title: shown(document.querySelector('.doc-title')),
        proofParas: Array.from(document.querySelectorAll('#preview .proof p')).filter(shown).length,
        words: /Opening words|Nothing picked|More words/.test(Array.from(document.querySelectorAll('#preview p')).filter(shown).map((x) => x.textContent).join(' ')),
        boxes: document.querySelectorAll('.pick-box').length,
      };
    });
    let s = await state();
    assert.deepEqual(s.thms, ['Theorem 1']);
    assert.deepEqual(s.eqs, ['(3.1)']);
    assert.deepEqual(s.heads, ['1Start', '3End']);
    assert.equal(s.title, true);
    assert.equal(s.proofParas, 1, 'the proof shows folded to its first line');
    assert.equal(s.words, false);
    assert.equal(s.boxes, 0);

    // Printing: the folded proof stays out.
    await p.emulateMedia({ media: 'print' });
    s = await state();
    assert.deepEqual(s.thms, ['Theorem 1']);
    assert.deepEqual(s.eqs, ['(3.1)']);
    assert.equal(s.proofParas, 0);
    await p.emulateMedia({ media: 'screen' });

    // Open the proof: all of it shows, and prints.
    await p.click('#preview .proof >> nth=0');
    s = await state();
    assert.equal(s.proofParas, 2);
    assert.deepEqual(s.eqs, ['(3.1)'], 'the equation cited in the proof is not added');
    await p.emulateMedia({ media: 'print' });
    s = await state();
    assert.equal(s.proofParas, 2);
    await p.emulateMedia({ media: 'screen' });

    // The same view on a page rendered again (how VS Code prints).
    const view = await p.evaluate(() => window.pick.snapshot());
    assert.ok(view && view.keep.length > 0 && view.keep.length < view.n);
    await p.click('.pick-bar [data-act="out"]');
    await p.click('.pick-bar [data-act="print"]');
    assert.equal(await p.evaluate(() => window.printed), 1);

    // Esc: the whole document again.
    await p.keyboard.press('Escape');
    s = await state();
    assert.equal(s.thms.length, 2);
    assert.equal(await p.evaluate(() => window.pick.snapshot()), null);

    // "What does this use?" with Hide the rest prints what it shows.
    await p.evaluate(() => window.insight.focus(document.getElementById('t:one') || document.querySelector('.theorem'), 'uses', { collapse: true }));
    await p.emulateMedia({ media: 'print' });
    s = await state();
    assert.deepEqual(s.thms, ['Theorem 1']);
    assert.equal(s.words, false);
    await p.emulateMedia({ media: 'screen' });
    assert.ok(await p.evaluate(() => window.pick.snapshot() && document.querySelector('.uses-bar:not(.pick-bar) [data-act="print"]') !== null));
    await p.click('.uses-bar:not(.pick-bar) [data-act="print"]');
    assert.equal(await p.evaluate(() => window.printed), 2);
    // starting a selection ends it
    await p.evaluate(() => window.pick.start());
    assert.equal(await p.evaluate(() => window.insight.focused()), null);
    await p.keyboard.press('Escape');

    // The exported page, given the snapshot, shows the same.
    const html = TeXglassExport.page({ body: TeXglassExport.joinBlocks(r.blocks), css, view });
    const q = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await q.setContent(html);
    const e = await q.evaluate(() => {
      const shown = (el) => el.getClientRects().length > 0;
      return {
        thms: Array.from(document.querySelectorAll('#preview .theorem')).filter(shown).map((el) => el.querySelector('.thm-name').textContent),
        eqs: Array.from(document.querySelectorAll('#preview .math-display')).filter(shown).map((el) => (el.querySelector('.tag') || {}).textContent || '*'),
        proofParas: Array.from(document.querySelectorAll('#preview .proof p')).filter(shown).length,
      };
    });
    assert.deepEqual(e, { thms: ['Theorem 1'], eqs: ['(3.1)'], proofParas: 2 });
    // A page whose blocks do not match prints whole.
    const r2 = TeXglass.render(DOC.replace('More words.', 'More words.\n\nAnother paragraph.'), { renderMath, sourceMap: true });
    await q.setContent(TeXglassExport.page({ body: TeXglassExport.joinBlocks(r2.blocks), css, view }));
    assert.equal(await q.evaluate(() => document.querySelectorAll('.tg-view-hide').length), 0);
  } finally {
    await browser.close();
  }
});
