'use strict';
// Notation on hover, the notation index and the dependency map (src/insight.js).
// The page-reading parts run in a real browser and are skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const Insight = require('../src/insight.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

test('the symbol a formula defines is read from :=, =: and \\coloneqq', () => {
  assert.equal(Insight.definedSymbol('\\Phi(x) := \\int_0^x f'), '\\Phi(x)');
  assert.equal(Insight.definedSymbol('|k|_\\fs := 2k_0 + k_1'), '|k|_\\fs');
  assert.equal(Insight.definedSymbol('a+b =: s_n'), 's_n');
  assert.equal(Insight.definedSymbol('\\mathcal{N} \\coloneqq \\{1, 2\\}'), '\\mathcal{N}');
  assert.equal(Insight.definedSymbol('x > 0, \\quad G_t := e^{t\\Delta}'), 'G_t');
  assert.equal(Insight.definedSymbol('a = b'), null);
  assert.equal(Insight.definedSymbol('f \\le g := h'), null);
});

test('render returns the document\'s macros, and renderSnippets draws formulas with them', () => {
  const r = TeXglass.render('\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\norm}[1]{\\lVert #1\\rVert}\\begin{document}$x\\in\\R$\\end{document}', { renderMath });
  assert.equal(r.defs.macros.R.body, '\\mathbb{R}');
  assert.equal(r.defs.macros.norm.nargs, 1);
  const [a, b] = TeXglass.renderSnippets(r.defs, ['\\R', '\\norm{\\cdot}'], { renderMath });
  assert.match(a, /mathbb/);
  assert.match(b, /∥/);
  assert.doesNotMatch(b, /katex-error/);
});

const DOC = String.raw`\documentclass{article}
\newcommand{\R}{\mathbb{R}}
\newcommand{\cA}{\mathcal{A}}
\newcommand{\eg}{e.g.}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{definition}[theorem]{Definition}
\begin{document}
\section{Setting}
We work on $\R^d$, \eg on the line.
\begin{definition}\label{d:op}
Let $\cA f := f'' + f$ for smooth $f$.
\end{definition}
\begin{lemma}\label{l:one}
The operator $\cA$ is closed, and
\begin{equation}\label{e:bound} \|\cA f\| \le C \|f\|. \end{equation}
\end{lemma}
\begin{proof} By Definition~\ref{d:op}. \end{proof}
\begin{lemma}\label{l:two}
The operator $\cA$ generates a semigroup on $\R^d$.
\end{lemma}
\begin{proof} Combine Lemma~\ref{l:one} with \eqref{e:bound}. \end{proof}
\section{Main result}
\begin{theorem}\label{t:main}
Solutions exist.
\end{theorem}
\begin{lemma}\label{l:three}
A technical estimate on $\R$.
\end{lemma}
\begin{proof} Direct. \end{proof}
\begin{proof}[Proof of Theorem~\ref{t:main}]
By Lemmas~\ref{l:two} and~\ref{l:three}, and since $\cA f$ is defined everywhere.
\end{proof}
\end{document}`;

test('the dependency map, the notation index and notation on hover read the rendered page', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath, sourceMap: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'vendor/katex/katex.min.css'), 'utf8')}${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<section class="pane" id="pane" style="height:100vh;overflow:auto"><article id="preview" class="document">${r.blocks.join('\n')}</article></section>`
    );
    await page.addScriptTag({ path: path.join(ROOT, 'src/insight.js') });
    await page.evaluate((defs) => {
      window.jumped = null;
      window.insight = TeXglassInsight.attach({
        root: document.getElementById('preview'),
        jump: (el) => { window.jumped = el.id || el.className; },
        renderTex: (texs) => texs.map((t) => `<b class="sym">${t}</b>`),
        delay: 50,
      });
      window.insight.setDefinitions(defs);
    }, r.defs);

    // Which result uses which, read from statements and proofs.
    const deps = await page.evaluate(() => {
      const g = window.insight.graph();
      return g.nodes.map((n) => [n.name, Array.from(n.uses).map((m) => m.name).sort()]);
    });
    assert.deepEqual(deps, [
      ['Definition 1.1', []],
      ['Lemma 1.2', ['Definition 1.1']],
      ['Lemma 1.3', ['Lemma 1.2']], // \eqref to an equation inside Lemma 1.2 counts as Lemma 1.2
      ['Theorem 2.1', ['Lemma 1.3', 'Lemma 2.2']], // its proof comes after Lemma 2.2 but names it
      ['Lemma 2.2', []],
    ]);

    // The notation index: macros used in formulas, in order of first use; text macros left out.
    const idx = await page.evaluate(() => {
      const i = window.insight.index();
      return { macros: i.macros.map((e) => [e.name, e.count]), symbols: i.symbols.map((s) => s.tex) };
    });
    assert.deepEqual(idx.macros, [['R', 3], ['cA', 5]]);
    assert.deepEqual(idx.symbols, ['\\cA f']);

    // Resting on a formula that uses \cA f names the definition and the macro.
    const later = page.locator('#preview .proof').last().locator('.math[data-tex]').first();
    await later.hover();
    await page.waitForSelector('.insight-popover:not([hidden])');
    const text = await page.textContent('.insight-popover');
    assert.match(text, /Defined in Definition 1\.1/);
    assert.match(text, /\\cA → \\mathcal\{A\}/);
    await page.click('.insight-popover a[data-go]');
    assert.ok(await page.evaluate(() => window.jumped));

    // A reference preview of Lemma 1.2 can say where it is used.
    const note = await page.evaluate(() => {
      const el = document.querySelectorAll('#preview .theorem')[1];
      const n = window.insight.usedByNote(el);
      return n && n.textContent;
    });
    assert.match(note, /Uses Definition 1\.1/);
    assert.match(note, /Used in Lemma 1\.3/);

    // The panel: the notation tab, then the map, where picking a result lights up what it rests on.
    await page.evaluate(() => window.insight.open('notation'));
    assert.equal(await page.locator('.insight-table tr').count(), 2);
    assert.equal(await page.locator('.insight-dialog .insight-sym .sym').first().textContent(), '\\R');
    await page.fill('.insight-filter', 'mathcal');
    assert.equal(await page.locator('.insight-table tr:not([hidden])').count(), 1);
    await page.click('.insight-tabs [data-tab="deps"]');
    assert.equal(await page.locator('.dep-node').count(), 5);
    await page.click('.dep-node[data-n="3"]');
    assert.equal(await page.locator('.dep-node.dep-up').count(), 4); // Theorem 2.1 rests on everything else
    assert.match(await page.textContent('.dep-detail'), /Indirectly/);
    // Resting on a node of the larger map previews that result, inside the dialog.
    await page.mouse.move(0, 0); // off the node just picked, whose preview may be up
    await page.waitForSelector('.insight-popover', { state: 'hidden' });
    await page.hover('.dep-node[data-n="1"]');
    await page.waitForSelector('.insight-dialog .insight-popover:not([hidden]) .dep-preview');
    const shown = await page.textContent('.insight-dialog .insight-popover');
    assert.match(shown, /Lemma 1\.2/);
    assert.match(shown, /is closed/);
    assert.equal(await page.locator('.dep-node title').count(), 0); // no browser tooltip on top of it
    await page.mouse.move(0, 0);
    await page.waitForSelector('.insight-popover', { state: 'hidden' });
    await page.click('.dep-go');
    assert.equal(await page.evaluate(() => document.querySelector('.insight-dialog').open), false);

    // Hover can be switched off.
    await page.evaluate(() => window.insight.setHover(false));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await later.hover();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.insight-popover:not([hidden])').count(), 0);
  } finally {
    await browser.close();
  }
});

test('the side panel has Contents, Map and Notation tabs, in that order, and a divider that resizes it', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath, sourceMap: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      '<main class="panes"><nav class="toc-pane" id="toc-pane"><div class="toc-pane-head"><div class="toc-pane-title">Contents</div></div><ol id="toc-list" class="toc-list"><li><a href="#">1 Setting</a></li></ol></nav>' +
      `<section class="pane" id="preview-pane"><article id="preview" class="document">${r.blocks.join('\n')}</article></section></main>`
    );
    await page.addScriptTag({ path: path.join(ROOT, 'src/insight.js') });
    await page.evaluate((defs) => {
      window.saved = { 'texglass:side-tab': 'notation', 'texglass:side-width': '300' };
      const store = { get: (k) => window.saved[k] || null, set: (k, v) => { window.saved[k] = v; } };
      const insight = TeXglassInsight.attach({ root: document.getElementById('preview'), jump() {} });
      insight.setDefinitions(defs);
      window.ins = insight;
      window.side = TeXglassInsight.sidePanel({
        pane: document.getElementById('toc-pane'),
        head: document.querySelector('.toc-pane-head'),
        list: document.getElementById('toc-list'),
        insight,
        store,
      });
    }, r.defs);
    assert.deepEqual(await page.$$eval('.side-tabs button', (bs) => bs.map((b) => b.textContent)), ['Contents', 'Map', 'Notation']);
    const width = () => page.evaluate(() => Math.round(document.getElementById('toc-pane').getBoundingClientRect().width));
    // The saved tab and width come back, without being saved again.
    assert.equal(await width(), 300);
    assert.equal(await page.locator('#toc-list').isHidden(), true);
    assert.equal(await page.locator('.side-insight .insight-table tr').count(), 2);
    await page.click('[data-side-tab="deps"]');
    assert.equal(await page.locator('.side-insight .dep-node').count(), 5);
    assert.equal(await page.evaluate(() => window.saved['texglass:side-tab']), 'deps');
    // Resting on a node of the panel's map previews that result too.
    await page.hover('.side-insight .dep-node[data-n="3"]');
    await page.waitForSelector('body > .insight-popover:not([hidden]) .dep-preview');
    assert.match(await page.textContent('.insight-popover'), /Theorem 2\.1/);
    await page.mouse.move(600, 700);
    await page.waitForSelector('.insight-popover', { state: 'hidden' });
    // "What does this use?" lights up the same results on the panel's map; picking there moves it.
    await page.evaluate(() => window.ins.focus(document.querySelectorAll('#preview .theorem')[3], 'uses'));
    assert.match(await page.textContent('.side-insight .dep-node.dep-sel'), /Theorem 2\.1/);
    assert.equal(await page.locator('.side-insight .dep-node.dep-up').count(), 4);
    await page.click('.side-insight .dep-node[data-n="1"]');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#preview .theorem')[1].classList.contains('uses-sel')), true);
    assert.match(await page.textContent('.side-insight .dep-node.dep-sel'), /Lemma 1\.2/);
    await page.evaluate(() => window.ins.unfocus());
    assert.equal(await page.locator('.side-insight .dep-map.dep-picked').count(), 0);
    await page.click('[data-side-tab="toc"]');
    assert.equal(await page.locator('#toc-list').isVisible(), true);
    // Drag the divider; the width is kept.
    const box = await page.locator('.side-resizer').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + 100, { steps: 5 });
    await page.mouse.up();
    assert.ok(Math.abs((await width()) - 420) <= 2, String(await width()));
    assert.equal(await page.evaluate(() => window.saved['texglass:side-width']), String(await width()));
    await page.focus('.side-resizer');
    await page.keyboard.press('ArrowLeft');
    assert.ok(Math.abs((await width()) - 400) <= 2);
    // Narrow, the tabs stack instead of being cut off.
    const tabsAt = () => page.evaluate(() => Array.from(document.querySelectorAll('.side-tabs button')).map((b) => {
      const r = b.getBoundingClientRect();
      const pane = document.getElementById('toc-pane').getBoundingClientRect();
      return { top: Math.round(r.top), inside: r.right <= pane.right + 0.5 };
    }));
    let tabs = await tabsAt();
    assert.equal(new Set(tabs.map((b) => b.top)).size, 1, 'wide: one row');
    await page.evaluate(() => window.side.setWidth(180));
    tabs = await tabsAt();
    assert.equal(new Set(tabs.map((b) => b.top)).size, 3, 'narrow: stacked');
    assert.ok(tabs.every((b) => b.inside), 'every tab is inside the panel');
    // The tabs stay at the top while the panel scrolls, stacked or not, on either side.
    await page.evaluate(() => {
      document.getElementById('toc-list').innerHTML = Array.from({ length: 120 }, (_, i) => `<li><a href="#">${i + 1} Section</a></li>`).join('');
    });
    const stuck = () => page.evaluate(() => {
      const pane = document.getElementById('toc-pane');
      pane.scrollTop = pane.scrollHeight;
      const p = pane.getBoundingClientRect();
      const head = document.querySelector('.toc-pane-head').getBoundingClientRect();
      const tab = document.querySelector('[data-side-tab="toc"]').getBoundingClientRect();
      const hit = document.elementFromPoint(tab.left + tab.width / 2, tab.top + tab.height / 2);
      return { scrolled: pane.scrollTop > 500, top: Math.round(head.top - p.top), left: Math.round(head.left - p.left), right: Math.round(p.right - head.right), tabOnTop: !!(hit && hit.closest('[data-side-tab="toc"]')) };
    });
    for (const right of [false, true]) {
      await page.evaluate((r) => document.body.classList.toggle('toc-right', r), right);
      for (const w of [180, 400]) {
        await page.evaluate((x) => window.side.setWidth(x), w);
        const s = await stuck();
        assert.ok(s.scrolled && s.top <= 0 && s.tabOnTop, JSON.stringify({ right, w, s }));
        assert.ok(s.left <= 1 && s.right <= 1, 'the head covers the panel\'s full width ' + JSON.stringify(s));
      }
    }
    await page.evaluate(() => document.body.classList.remove('toc-right'));
    await page.click('[data-side-tab="notation"]');
    assert.equal(await page.locator('#toc-list').isHidden(), true);
    await page.click('[data-side-tab="toc"]');
    await page.dblclick('.side-resizer');
    assert.equal(await width(), 280);
  } finally {
    await browser.close();
  }
});

test('mentions without a link are guessed; a mention of another paper\'s result is not', () => {
  const a = { name: 'Lemma 2.1' };
  const b = { name: 'Proposition 2.2' };
  const c = { name: 'Theorem 3' };
  const byNumber = new Map([['2.1', a], ['2.2', b], ['3', c]]);
  const names = (text, at) => Insight.mentionsIn(text, byNumber, at || (() => null)).map((m) => m.node.name);
  assert.deepEqual(names('By Lemma 2.1 and Prop. 2.2 we get it.'), ['Lemma 2.1', 'Proposition 2.2']);
  assert.deepEqual(names('By Lemmas 2.1 and 2.2'), ['Lemma 2.1']); // 2.2 is a proposition
  assert.deepEqual(names('Combine Thm 3 with Corollary 2.1.'), ['Theorem 3']);
  assert.deepEqual(names('By Theorem 3 of †, and Theorem 3 in Smith\'s paper.'), []);
  assert.deepEqual(names('By †, Theorem 3.'), []);
  assert.deepEqual(names('see Section 2.1 and Figure 3'), []);
  assert.deepEqual(names('By the previous lemma, and the proposition below.', (dir, w) => (dir === 'back' && /lemma/i.test(w) ? a : dir === 'on' && /prop/i.test(w) ? b : null)), ['Lemma 2.1', 'Proposition 2.2']);
});

const PAPER = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\begin{document}
\section{Tools}
\begin{lemma}\label{l:a}
A first estimate.
\end{lemma}
\begin{proof} We show
\begin{equation}\label{e:key} a \le b \end{equation}
as in \cite{Smith}. \end{proof}
\begin{lemma}
By the previous lemma, a second estimate holds.
\end{lemma}
\section{Building up}
\begin{proposition}\label{p:b}
Something bigger.
\end{proposition}
\begin{proof} By \eqref{e:key} and Lemma 1.2. Theorem 1.1 of \cite{Jones} is not ours. \end{proof}
\section{The main result}
\begin{lemma}\label{l:c} A step. \end{lemma}
\begin{lemma}\label{l:d} Another step, from Lemma~\ref{l:c}. \end{lemma}
\begin{lemma}\label{l:e} A last step. \end{lemma}
\begin{proof} By Lemma~\ref{l:d}. \end{proof}
\begin{theorem}\label{t:main}
Under Proposition~\ref{p:b}, the main claim holds.
\end{theorem}
\begin{proof}[Proof of Theorem 3.4]
Combine Lemma~\ref{l:e} with \cite{Smith}.
\end{proof}
\begin{thebibliography}{9}
\bibitem{Smith} A. Smith, Estimates.
\bibitem{Jones} B. Jones, Other things.
\end{thebibliography}
\end{document}`;

test('the map reads equations, mentions and citations, groups by section and folds lemmas', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(PAPER, { renderMath, sourceMap: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<section class="pane" id="pane" style="height:100vh;overflow:auto"><article id="preview" class="document">${r.blocks.join('\n')}</article></section>`
    );
    await page.addScriptTag({ path: path.join(ROOT, 'src/insight.js') });
    await page.evaluate(() => {
      window.insight = TeXglassInsight.attach({ root: document.getElementById('preview'), jump() {} });
    });
    const g = await page.evaluate(() => {
      const graph = window.insight.graph();
      return {
        edges: graph.nodes.map((n) => [n.name, Array.from(n.edges, ([m, e]) => `${m.name}:${e.guessed ? 'guessed' : e.proof ? 'proof' : 'statement'}`).sort()]),
        cites: graph.nodes.map((n) => Array.from(n.cites.keys(), (c) => `${c.label} ${c.who}`)).filter((l) => l.length),
        sections: graph.nodes.map((n) => n.section && n.section.num),
        groups: Array.from(TeXglassInsight.foldGroups(graph), ([root, list]) => [root.name, list.map((m) => m.name)]),
      };
    });
    assert.deepEqual(g.edges, [
      ['Lemma 1.1', []],
      ['Lemma 1.2', ['Lemma 1.1:guessed']], // "the previous lemma"
      ['Proposition 2.1', ['Lemma 1.1:proof', 'Lemma 1.2:guessed']], // (1) sits in the proof of Lemma 1.1; "Theorem 1.1 of [2]" is someone else's
      ['Lemma 3.1', []],
      ['Lemma 3.2', ['Lemma 3.1:statement']],
      ['Lemma 3.3', ['Lemma 3.2:proof']],
      ['Theorem 3.4', ['Lemma 3.3:proof', 'Proposition 2.1:statement']], // "Proof of Theorem 3.4" typed by hand
    ]);
    assert.deepEqual(g.cites, [['[1] Smith'], ['[2] Jones'], ['[1] Smith']]);
    assert.deepEqual(g.sections, ['1', '1', '2', '3', '3', '3', '3']);
    assert.deepEqual(g.groups, [
      ['Proposition 2.1', ['Lemma 1.1', 'Lemma 1.2']], // Lemma 1.1 serves Lemma 1.2 and Proposition 2.1, which come to the same
      ['Theorem 3.4', ['Lemma 3.1', 'Lemma 3.2', 'Lemma 3.3']],
    ]);

    // The larger map: bands for sections, kinds of line, cited works as leaves.
    await page.evaluate(() => window.insight.open('deps'));
    assert.deepEqual(await page.$$eval('.dep-band text', (els) => els.map((e) => e.textContent)), ['§1 Tools', '§2 Building up', '§3 The main result']);
    assert.equal(await page.locator('.dep-map .dep-edge.dep-guess').count(), 2);
    assert.equal(await page.locator('.dep-map .dep-edge.dep-stmt:not(.dep-guess)').count(), 2);
    assert.equal(await page.locator('.dep-map .dep-edge.dep-proof:not(.dep-guess)').count(), 3);
    assert.deepEqual(await page.$$eval('.dep-citenode', (els) => els.map((e) => e.textContent)), ['[1] Smith', '[2] Jones']);
    assert.match(await page.textContent('.insight-dialog .dep-legend'), /used in a proof.*named in a statement.*guessed.*cited work/);
    // Small maps are not folded until asked.
    assert.equal(await page.locator('.dep-fold').count(), 0);
    await page.check('.dep-opts input[data-opt="fold"]');
    assert.equal(await page.locator('.dep-node[data-n]').count(), 2); // the lemmas folded into Proposition 2.1 and Theorem 3.4
    assert.deepEqual(await page.$$eval('.dep-fold', (els) => els.map((e) => e.textContent)), ['+2', '+3']);
    // Picking a folded lemma unfolds it there.
    await page.click('.dep-node:has-text("Theorem 3.4")');
    assert.match(await page.textContent('.dep-detail'), /Folded in Lemma 3\.1, Lemma 3\.2, Lemma 3\.3/);
    await page.click('.dep-detail [data-pick="4"]');
    assert.equal(await page.locator('.dep-node[data-n]').count(), 5);
    assert.match(await page.textContent('.dep-node.dep-sel'), /Lemma 3\.2/);
    await page.click('.dep-unfold');
    assert.equal(await page.locator('.dep-node[data-n]').count(), 2);
    // The guessed link says so, and where it came from.
    await page.click('.dep-node[data-n="2"]');
    assert.match(await page.getAttribute('.dep-detail .dep-tag-guess', 'title'), /Lemma 1\.2/); // typed by hand in the proof
    await page.click('.dep-detail [data-pick="1"]');
    assert.match(await page.getAttribute('.dep-detail .dep-tag-guess', 'title'), /the previous lemma/);
    // A cited work lights up what rests on it.
    await page.click('.dep-citenode[data-c="0"]');
    assert.match(await page.textContent('.dep-detail'), /Cited in Lemma 1\.1, Theorem 3\.4/);
    assert.ok(await page.locator('.dep-node[data-n="2"].dep-down').count()); // Proposition 2.1 rests on Lemma 1.1
    // Switching citations and sections off.
    await page.uncheck('.dep-opts input[data-opt="cites"]');
    await page.uncheck('.dep-opts input[data-opt="sections"]');
    assert.equal(await page.locator('.dep-citenode').count(), 0);
    assert.equal(await page.locator('.dep-band').count(), 0);
    await page.evaluate(() => document.querySelector('.insight-dialog').close());

    // "What does this use?": a result reached only through a guess is marked so; cited entries light up.
    await page.evaluate(() => window.insight.focus(document.querySelectorAll('#preview .theorem')[2], 'uses'));
    const lit = await page.evaluate(() => Array.from(document.querySelectorAll('#preview .theorem'), (el) => (el.className.match(/uses-\w+/g) || []).join(' ')));
    assert.deepEqual(lit.slice(0, 3), ['uses-on', 'uses-on uses-guess', 'uses-sel']);
    assert.match(await page.textContent('.uses-bar'), /uses 2 results \(1 guessed\)/);
    // its own citation [2] lights up; [1], cited in the proof of Lemma 1.1, does not
    assert.deepEqual(await page.$$eval('.bibliography li', (els) => els.map((e) => e.classList.contains('uses-ref'))), [false, true]);
  } finally {
    await browser.close();
  }
});
