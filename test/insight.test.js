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

test('the side panel has Contents, Notation and Map tabs and a divider that resizes it', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
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
      window.side = TeXglassInsight.sidePanel({
        pane: document.getElementById('toc-pane'),
        head: document.querySelector('.toc-pane-head'),
        list: document.getElementById('toc-list'),
        insight,
        store,
      });
    }, r.defs);
    const width = () => page.evaluate(() => Math.round(document.getElementById('toc-pane').getBoundingClientRect().width));
    // The saved tab and width come back, without being saved again.
    assert.equal(await width(), 300);
    assert.equal(await page.locator('#toc-list').isHidden(), true);
    assert.equal(await page.locator('.side-insight .insight-table tr').count(), 2);
    await page.click('[data-side-tab="deps"]');
    assert.equal(await page.locator('.side-insight .dep-node').count(), 5);
    assert.equal(await page.evaluate(() => window.saved['texglass:side-tab']), 'deps');
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
    await page.dblclick('.side-resizer');
    assert.equal(await width(), 280);
  } finally {
    await browser.close();
  }
});
