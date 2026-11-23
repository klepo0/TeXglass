'use strict';
// Search by use: the Navigate bar's Uses tab lists what uses a lemma, an
// assumption or an equation, and with "and", "or" or "but not" finds every
// result that uses some (and not others), directly or not
// (src/find.js parseUses + src/insight.js searchUses/showUses). The browser
// part is skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const { parseUses } = require('../src/find.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

test('parseUses reads what to use, what not to, any/all and directly', () => {
  assert.deepEqual(parseUses('Lemma 2'), { inc: ['Lemma 2'], exc: [], any: false, direct: false });
  assert.deepEqual(parseUses('uses Lemma 2 but not Assumption A'), { inc: ['Lemma 2'], exc: ['Assumption A'], any: false, direct: false });
  assert.deepEqual(parseUses('Lemma 2, (3.1) and Theorem 4'), { inc: ['Lemma 2', '(3.1)', 'Theorem 4'], exc: [], any: false, direct: false });
  assert.deepEqual(parseUses('Lemma 2 or Lemma 3'), { inc: ['Lemma 2', 'Lemma 3'], exc: [], any: true, direct: false });
  assert.deepEqual(parseUses('not Assumption A, Assumption B'), { inc: [], exc: ['Assumption A', 'Assumption B'], any: false, direct: false });
  assert.deepEqual(parseUses('Lemma 2 -Lemma 3'), { inc: ['Lemma 2'], exc: ['Lemma 3'], any: false, direct: false });
  assert.deepEqual(parseUses('results that directly use Lemma 2 without (3.1)'), { inc: ['Lemma 2'], exc: ['(3.1)'], any: false, direct: true });
  assert.deepEqual(parseUses('Notation 2'), { inc: ['Notation 2'], exc: [], any: false, direct: false }); // "not" only as a word
  assert.deepEqual(parseUses('  '), { inc: [], exc: [], any: false, direct: false });
});

// Assumption 1.1 <- Lemma 1.2 <- Theorem 2.1 <- Corollary 2.2; Lemma 1.3 uses
// equation (1.1); Proposition 2.3 uses Lemma 1.3 and, through \tguses only,
// Lemma 1.2; Lemma 1.4 stands alone.
const DOC = String.raw`\documentclass{article}
\usepackage{texglass}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{assumption}[theorem]{Assumption}
\newtheorem{corollary}[theorem]{Corollary}
\newtheorem{proposition}[theorem]{Proposition}
\begin{document}
\section{Setting}
\begin{assumption}\label{a:one} The data are smooth. \end{assumption}
\begin{lemma}\label{l:two} A bound under Assumption~\ref{a:one}. \end{lemma}
\begin{equation}\label{e:key} x \le y \end{equation}
\begin{lemma}\label{l:three} Another bound. \end{lemma}
\begin{proof} From \eqref{e:key}. \end{proof}
\begin{lemma}\label{l:four} Unrelated. \end{lemma}
\section{Main}
A paragraph of text.
\begin{theorem}\label{t:main} Solutions exist. \end{theorem}
\begin{proof} By Lemma~\ref{l:two}. \end{proof}
\begin{corollary}\label{c:one} They are unique. \end{corollary}
\begin{proof} From Theorem~\ref{t:main}. \end{proof}
\begin{proposition}\label{p:one} Something else. \end{proposition}
\begin{proof} By Lemma~\ref{l:three}.\tguses{l:two} \end{proof}
\end{document}`;

test('the Uses tab finds results by what they use, and lights them up', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
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
    await p.addScriptTag({ path: path.join(ROOT, 'src/pick.js') });
    await p.addScriptTag({ path: path.join(ROOT, 'src/find.js') });
    await p.evaluate(() => {
      const root = document.getElementById('preview');
      let finder = null;
      // what a search by use finds shows in Show only these
      const picker = TeXglassPick.attach({ root, jump: (el) => el.scrollIntoView() });
      const insight = TeXglassInsight.attach({ root, jump: (el) => el.scrollIntoView(), onEditSearch: () => finder.open('uses'), picker });
      window.insight = insight;
      finder = TeXglassFind.attach({
        root,
        scroller: document.getElementById('pane'),
        onFocus: (el, o) => insight.focus(el, (o && o.dir) || 'both', { at: o && o.at }),
        related: (el, o) => insight.related(el, o),
        uses: (q) => insight.searchUses(q),
        onUses: (q, el) => insight.showUses(q, { at: el }),
      });
      window.finder = finder;
      finder.open('uses');
    });
    const items = () => p.evaluate(() => Array.from(document.querySelectorAll('.goto-list li[data-k] .goto-name')).map((li) => li.textContent));
    const head = () => p.evaluate(() => { const h = document.querySelector('.goto-list .uses-head .uses-sum'); return h ? h.textContent : document.querySelector('.goto-list li').textContent; });
    assert.equal(await p.evaluate(() => document.querySelectorAll('.find-modes button').length), 3); // Find, Go to, Uses
    assert.match(await head(), /Combine names to search by use/);

    // One name: the result, what it uses, then what uses it. Directly or not:
    // Lemma 1.2 is used by Theorem 2.1, Corollary 2.2 (through it) and Proposition 2.3 (\tguses).
    await p.keyboard.type('Lemma 1.2');
    assert.deepEqual(await items(), ['Lemma 1.2', 'Assumption 1.1', 'Theorem 2.1', 'Corollary 2.2', 'Proposition 2.3']);
    assert.match(await head(), /Lemma 1\.2 uses 1 result, is used in 3 results/);
    await p.click('.uses-direct');
    assert.deepEqual(await items(), ['Lemma 1.2', 'Assumption 1.1', 'Theorem 2.1', 'Proposition 2.3']);
    assert.match(await head(), /is used in 2 results directly/);
    await p.click('.uses-direct');
    // Several names search by use.
    await p.fill('.find-input', 'Lemma 1.2, Assumption 1.1');
    assert.deepEqual(await items(), ['Theorem 2.1', 'Corollary 2.2', 'Proposition 2.3']);
    assert.match(await head(), /3 results use Lemma 1\.2 and Assumption 1\.1/);

    // An assumption, transitively; but not another result.
    await p.fill('.find-input', 'Assumption 1.1 but not Proposition 2.3');
    await p.evaluate(() => document.querySelector('.find-input').dispatchEvent(new Event('input')));
    assert.deepEqual(await items(), ['Lemma 1.2', 'Theorem 2.1', 'Corollary 2.2']);
    // An equation; and "or".
    await p.fill('.find-input', '(1)');
    assert.deepEqual(await items(), ['Equation (1)', 'Lemma 1.3', 'Proposition 2.3']);
    assert.match(await head(), /Equation \(1\) is used in 2 results/);
    await p.fill('.find-input', 'Theorem 2.1 or (1)');
    assert.deepEqual(await items(), ['Lemma 1.3', 'Corollary 2.2', 'Proposition 2.3']);
    // Only what to leave out: the results free of the assumption.
    await p.fill('.find-input', 'not Assumption 1.1');
    assert.deepEqual(await items(), ['Lemma 1.3', 'Lemma 1.4']);
    // Unknown names say so.
    await p.fill('.find-input', 'Lemma 9.9');
    assert.match(await head(), /No theorem, lemma or equation matches “Lemma 9\.9”/);

    // Picking one lights them all up and hides the rest.
    await p.fill('.find-input', 'Lemma 1.2');
    for (let k = 0; k < 3; k++) await p.keyboard.press('ArrowDown'); // Corollary 2.2, in Used by
    await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(() => window.finder.isOpen()), false);
    const state = () => p.evaluate(() => ({
      shown: Array.from(document.querySelectorAll('#preview .theorem')).filter((el) => el.offsetParent).map((el) => el.querySelector('.thm-name').textContent),
      bar: document.querySelector('.uses-bar:not([hidden])') && document.querySelector('.uses-bar .uses-what').textContent,
      step: document.querySelector('.uses-bar .uses-step') && document.querySelector('.uses-bar .uses-step').textContent,
    }));
    let s = await state();
    assert.deepEqual(s.shown, ['Lemma 1.2', 'Theorem 2.1', 'Corollary 2.2', 'Proposition 2.3']);
    assert.equal(s.bar, '3 results use Lemma 1.2');
    assert.equal(s.step, '2/3'); // started at the one picked
    // Change search reopens the search; Esc ends it.
    await p.click('.uses-bar [data-act="search"]');
    const f = await p.evaluate(() => window.finder.state());
    assert.deepEqual([f.open, f.mode, f.query], [true, 'uses', 'Lemma 1.2']);
    await p.keyboard.press('Escape');
    await p.keyboard.press('Escape');
    s = await state();
    assert.equal(s.bar, null);
    assert.equal(s.shown.length, 7);
  } finally {
    await browser.close();
  }
});

test('"What does this use?" is a temporary pin set: change it, save it as a set or add it to the pins; Done leaves the pins as they were', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
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
    await p.addScriptTag({ path: path.join(ROOT, 'src/pick.js') });
    await p.evaluate(() => {
      const root = document.getElementById('preview');
      let edits = {};
      let insight = null;
      // as the viewer wires them: the pins are the map's, Show only these shows them
      const picker = TeXglassPick.attach({
        root,
        jump: () => {},
        items: () => insight.pinnedEls(),
        isOn: (el) => insight.isPinned(el),
        toggle: (el) => insight.togglePin(el),
        proofsOf: (el) => { const n = insight.graph().byEl.get(el); return n ? n.proofs : null; },
      });
      insight = TeXglassInsight.attach({
        root, jump: () => {}, picker,
        edits: { get: () => edits, set: (e) => { edits = e; } },
        onPinsChange: () => picker.pinsChanged(),
      });
      window.insight = insight;
      window.pick = picker;
    });
    const byName = (name) => `#preview .theorem:has(.thm-name:text-is("${name}"))`;
    const shown = () => p.evaluate(() => (document.getElementById('preview').classList.contains('pick-view')
      ? Array.from(document.querySelectorAll('#preview .theorem')).filter((el) => el.offsetParent).map((el) => el.querySelector('.thm-name').textContent)
      : null));
    const pins = () => p.evaluate(() => window.insight.pinEntries().map(([k, d]) => `${k} ${d}`).sort());
    // The reader has a pin of their own.
    await p.evaluate(() => window.insight.pin(document.querySelector('#preview .theorem[data-label="l:four"]')));
    assert.deepEqual(await pins(), ['label:l:four self']);
    // What does Theorem 2.1 use? Only that shows, not the reader's pin.
    await p.hover(byName('Theorem 2.1'));
    await p.click(`${byName('Theorem 2.1')} .uses-btn`);
    assert.deepEqual(await shown(), ['Assumption 1.1', 'Lemma 1.2', 'Theorem 2.1']);
    assert.deepEqual(await pins(), ['label:l:four self']);
    // Change: take Assumption 1.1 away (from this view only), then show these again.
    await p.click('.pick-bar [data-act="edit"]');
    assert.equal(await p.evaluate(() => window.pick.mode()), 'pick');
    await p.click(`${byName('Assumption 1.1')} .pick-box`);
    await p.click('.pick-bar [data-act="show"]');
    assert.deepEqual(await shown(), ['Lemma 1.2', 'Theorem 2.1']);
    assert.match(await p.textContent('.pick-bar .uses-what'), /Theorem 2\.1 with what it uses, changed/);
    assert.deepEqual(await pins(), ['label:l:four self']);
    // Keep → Save as pin set: a set of its own; the pins stay as they are.
    await p.click('.pick-bar [data-act="keep-menu"]');
    await p.click('.pick-bar [data-act="save"]');
    assert.match(await p.textContent('.pick-bar .uses-what'), /Saved as “Theorem 2\.1 with what it uses \(changed\)”/);
    const sets = await p.evaluate(() => window.insight.pinSets().map((s) => `${s.name}: ${s.size}`));
    assert.deepEqual(sets, ['Theorem 2.1 with what it uses (changed): 2']);
    assert.deepEqual(await pins(), ['label:l:four self']);
    // Done: the whole paper, and the reader's pins as they were.
    await p.click('.pick-bar [data-act="done"]');
    assert.equal(await shown(), null);
    assert.equal(await p.evaluate(() => window.insight.focused()), null);
    assert.deepEqual(await pins(), ['label:l:four self']);
    // Again, unchanged: Keep → Add to my pins pins it with what it uses.
    await p.evaluate(() => window.insight.focus(document.querySelector('#preview .theorem[data-label="t:main"]'), 'uses'));
    await p.click('.pick-bar [data-act="keep-menu"]');
    await p.click('.pick-bar [data-act="keep"]');
    assert.match(await p.textContent('.pick-bar .uses-what'), /Added to your pins/);
    assert.deepEqual(await pins(), ['label:l:four self', 'label:t:main uses']);
    assert.deepEqual(await shown(), ['Assumption 1.1', 'Lemma 1.2', 'Theorem 2.1']); // still the temporary view
    // Show only these (the reader's own pins) takes over from it.
    await p.evaluate(() => window.pick.show());
    assert.equal(await p.evaluate(() => window.insight.focused()), null);
    assert.deepEqual(await shown(), ['Assumption 1.1', 'Lemma 1.2', 'Lemma 1.4', 'Theorem 2.1']);
  } finally {
    await browser.close();
  }
});
