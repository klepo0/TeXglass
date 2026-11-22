'use strict';
// The find bar's Uses tab, picking one result: its two lists (what it uses,
// what uses it), and lighting up all of it or one side (src/find.js +
// src/insight.js). The search by use in the same tab: uses-ui.test.js. Runs in a real browser and is
// skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

// A chain: Lemma 1.1 <- Lemma 1.2 <- Theorem 2.1 <- Corollary 2.2, and an unrelated Lemma 1.3.
const DOC = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{corollary}[theorem]{Corollary}
\begin{document}
\section{Setting}
Some words before.
\begin{lemma}\label{l:one} A first bound. \end{lemma}
\begin{lemma}[Second bound]\label{l:two} Another bound. \end{lemma}
\begin{proof} Use Lemma~\ref{l:one}. \end{proof}
\begin{lemma}\label{l:three} Unrelated. \end{lemma}
\section{Main}
A paragraph of text.
\begin{theorem}\label{t:main} Solutions exist. \end{theorem}
\begin{proof} By Lemma~\ref{l:two}. \end{proof}
\begin{corollary}\label{c:one} They are unique. \end{corollary}
\begin{proof} From Theorem~\ref{t:main}. \end{proof}
\end{document}`;

test('the Uses tab picks a result, lists what it uses and what uses it, and hides the rest', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath, sourceMap: true });
    const p = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await p.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<section class="pane" id="pane" style="height:100vh;overflow:auto"><article id="preview" class="document">${r.blocks.join('\n')}</article></section>`
    );
    await p.addScriptTag({ path: path.join(ROOT, 'src/insight.js') });
    await p.addScriptTag({ path: path.join(ROOT, 'src/find.js') });
    await p.evaluate(() => {
      const root = document.getElementById('preview');
      const insight = TeXglassInsight.attach({ root, jump: (el) => el.scrollIntoView() });
      window.finder = TeXglassFind.attach({
        root,
        scroller: document.getElementById('pane'),
        onFocus: (el, o) => insight.focus(el, (o && o.dir) || 'both', { scroll: true, collapse: true, at: o && o.at }),
        related: (el, o) => insight.related(el, o),
        uses: (q) => insight.searchUses(q),
        onUses: (q, el) => insight.showUses(q, { at: el, scroll: true, collapse: true }),
      });
      window.finder.open('trace'); // the old Trace tab's name opens Uses
    });
    assert.equal(await p.evaluate(() => window.finder.state().mode), 'uses');
    assert.deepEqual(await p.evaluate(() => Array.from(document.querySelectorAll('.find-modes button')).map((b) => b.textContent)), ['Find', 'Go to', 'Uses']);
    // With nothing typed, every result, with how many they use and are used in.
    const items = () => p.evaluate(() => Array.from(document.querySelectorAll('.goto-list li[data-k]')).map((li) => li.textContent));
    const rows = () => p.evaluate(() => Array.from(document.querySelectorAll('.goto-list li:not(.uses-help)')).map((li) => (li.matches('.uses-group') ? '# ' : '') + (li.querySelector('.goto-name, .uses-sum') || li).textContent));
    assert.match(await p.evaluate(() => document.querySelector('.goto-list li').textContent), /Pick or type a result/);
    assert.deepEqual(await items(), [
      'Lemma 1.1used in 3',
      'Lemma 1.2Second bounduses 1 · used in 2',
      'Lemma 1.3stands alone',
      'Theorem 2.1uses 2 · used in 1',
      'Corollary 2.2uses 3',
    ]);
    // Picking one shows its two lists.
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(() => window.finder.state().query), 'Lemma 1.3');
    assert.deepEqual(await rows(), ['Lemma 1.3 uses no result, is used in no result', 'Lemma 1.3', '# Uses', 'Nothing', '# Used by', 'Nothing']);
    // Typing a name does the same.
    await p.fill('.find-input', '');
    await p.keyboard.type('second');
    assert.deepEqual(await rows(), [
      'Lemma 1.2 uses 1 result, is used in 2 results',
      'Lemma 1.2', '# Uses', 'Lemma 1.1', '# Used by', 'Theorem 2.1', 'Corollary 2.2',
    ]);
    // Directly: only links written in the result itself.
    await p.click('.uses-direct');
    assert.deepEqual(await rows(), [
      'Lemma 1.2 uses 1 result, is used in 1 result directly',
      'Lemma 1.2', '# Uses', 'Lemma 1.1', '# Used by', 'Theorem 2.1',
    ]);
    await p.click('.uses-direct');
    await p.locator('.find-input').focus();
    await p.keyboard.press('Enter'); // the result itself: all of it
    assert.equal(await p.evaluate(() => window.finder.isOpen()), false);
    const state = () => p.evaluate(() => ({
      shown: Array.from(document.querySelectorAll('#preview .theorem')).filter((el) => el.offsetParent).map((el) => el.querySelector('.thm-name').textContent),
      paras: Array.from(document.querySelectorAll('#preview > p, #preview section > p')).filter((el) => el.offsetParent).length,
      heads: Array.from(document.querySelectorAll('#preview h2')).filter((el) => el.offsetParent).length,
      bar: document.querySelector('.uses-bar:not([hidden])') && document.querySelector('.uses-bar').textContent,
      both: document.querySelector('.uses-bar [data-dir="both"]').getAttribute('aria-pressed'),
      collapse: document.querySelector('.uses-bar [data-act="collapse"]').getAttribute('aria-pressed'),
    }));
    let s = await state();
    // Lemma 1.2, what it uses (Lemma 1.1) and what uses it (Theorem 2.1, Corollary 2.2); not Lemma 1.3, no paragraphs.
    assert.deepEqual(s.shown, ['Lemma 1.1', 'Lemma 1.2', 'Theorem 2.1', 'Corollary 2.2']);
    assert.equal(s.paras, 0);
    assert.equal(s.heads, 2); // headings stay
    assert.match(s.bar, /Lemma 1\.2 uses 1 result, is used in 2 results/);
    assert.equal(s.both, 'true');
    assert.equal(s.collapse, 'true');
    // The proofs of the other results stay, folded to their first line; a click opens one, its arrow folds it again.
    const proofs = () => p.evaluate(() => Array.from(document.querySelectorAll('#preview .proof')).map((el) => {
      if (!el.offsetParent) return 'hidden';
      const rest = Array.from(el.children).slice(1);
      return rest.length && rest.every((c) => !c.offsetParent) || getComputedStyle(el.firstElementChild).whiteSpace === 'nowrap' ? 'folded' : 'open';
    }));
    // Lemma 1.2's own proof is open; Theorem 2.1's and Corollary 2.2's are folded.
    assert.deepEqual(await proofs(), ['open', 'folded', 'folded']);
    await p.click('#preview .proof.uses-proof >> nth=0');
    assert.deepEqual(await proofs(), ['open', 'open', 'folded']);
    await p.evaluate(() => {
      const b = document.createElement('button');
      b.className = 'fold-toggle';
      b.textContent = 'v';
      document.querySelectorAll('#preview .proof')[1].firstElementChild.prepend(b);
    });
    await p.click('#preview .proof.uses-proof >> nth=0 >> .fold-toggle');
    assert.deepEqual(await proofs(), ['open', 'folded', 'folded']);
    // Faded instead of hidden, they are not folded.
    await p.click('.uses-bar [data-act="collapse"]');
    assert.deepEqual(await proofs(), ['open', 'open', 'open']);
    await p.click('.uses-bar [data-act="collapse"]');
    // The bar switches to one side.
    await p.click('.uses-bar [data-dir="uses"]');
    s = await state();
    assert.deepEqual(s.shown, ['Lemma 1.1', 'Lemma 1.2']);
    await p.click('.uses-bar [data-dir="both"]');
    s = await state();
    assert.deepEqual(s.shown, ['Lemma 1.1', 'Lemma 1.2', 'Theorem 2.1', 'Corollary 2.2']);
    // Picking from a list lights up that side and starts at the one picked.
    await p.evaluate(() => window.finder.open('uses', 'Theorem 2.1'));
    await p.click('.goto-list li[data-k] >> text=Lemma 1.1');
    s = await state();
    assert.deepEqual(s.shown, ['Lemma 1.1', 'Lemma 1.2', 'Theorem 2.1']);
    assert.equal(await p.evaluate(() => document.querySelector('.uses-bar [data-dir="uses"]').getAttribute('aria-pressed')), 'true');
    assert.equal(await p.evaluate(() => document.querySelector('.uses-bar .uses-step').textContent), '2/3'); // Theorem 2.1, then Lemma 1.1
    await p.evaluate(() => window.finder.open('uses', 'Lemma 1.1'));
    await p.click('.goto-list li[data-k] >> text=Theorem 2.1');
    assert.equal(await p.evaluate(() => document.querySelector('.uses-bar .uses-what').textContent), '3 results use Lemma 1.1');
    assert.equal(await p.evaluate(() => document.querySelector('.uses-bar .uses-step').textContent), '2/3');
    // A result on its own.
    await p.evaluate(() => window.finder.open('trace', 'lemma 1.3'));
    await p.keyboard.press('Enter');
    s = await state();
    assert.deepEqual(s.shown, ['Lemma 1.3']);
    assert.match(s.bar, /neither uses nor is used/);
    await p.keyboard.press('Escape');
    s = await state();
    assert.equal(s.bar, null);
    assert.equal(s.shown.length, 5);
  } finally {
    await browser.close();
  }
});

test('without onFocus or uses there is no Uses tab', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const p = await browser.newPage();
    await p.setContent('<section id="pane"><article id="doc"><p>Text</p></article></section>');
    await p.addScriptTag({ path: path.join(ROOT, 'src/find.js') });
    const out = await p.evaluate(() => {
      const f = TeXglassFind.attach({ root: document.getElementById('doc'), scroller: document.getElementById('pane') });
      f.open('trace');
      return { tabs: document.querySelectorAll('.find-modes button').length, mode: f.state().mode };
    });
    assert.deepEqual(out, { tabs: 2, mode: 'goto' });
  } finally {
    await browser.close();
  }
});
