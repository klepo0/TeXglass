'use strict';
// Symbols the text introduces in words ("let X be", "denote by X", "where X is"),
// found again in later formulas by notation on hover and listed in the notation
// index (src/insight.js). The example paper is made up.
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

// parts as proseDefinitions reads them: '$…' is a formula
const defsIn = (...parts) => Insight.proseDefinitions(parts.map((p) => (p.startsWith('$') ? { tex: p.slice(1) } : p)))
  .map((d) => `${d.tier}:${d.syms.join('|')}`);

test('phrases that introduce a symbol', () => {
  assert.deepEqual(defsIn('Let ', '$Q', ' be a compact set and denote by ', '$\\mathcal{G}_s', ' the flow, where ', '$\\kappa', ' is the decay rate.'),
    ['let:Q', 'strong:\\mathcal{G}_s', 'weak:\\kappa']);
  assert.deepEqual(defsIn('We write ', '$\\langle u \\rangle_\\flat', ' for the average of ', '$u', '.'), ['strong:\\langle u \\rangle_\\flat']);
  assert.deepEqual(defsIn('Here ', '$\\Theta_n', ' denotes the ', '$n', '-th cell.'), ['strong:\\Theta_n']);
  assert.deepEqual(defsIn('Then we set ', '$w = v + 1', '.'), ['strong:w']);
  assert.deepEqual(defsIn('The constant ', '$\\varkappa', ' stands for the gap.'), ['strong:\\varkappa']);
  assert.deepEqual(defsIn('Let ', '$(Y_r)_{r \\ge 0}', ' be a chain.'), ['let:Y_r']);
  assert.deepEqual(defsIn('Let ', '$P', ', ', '$R', ' and ', '$\\Omega', ' be fixed.'), ['let:P', 'let:R', 'let:\\Omega']);
  // a plain small letter needs a strong phrase; a single Latin letter is not enough after "where … is"
  assert.deepEqual(defsIn('Let ', '$m', ' be an integer, where ', '$K', ' is a constant.'), []);
  assert.deepEqual(defsIn('and ', '$m', ' denotes the mass.'), ['strong:m']);
  // not definitions: a relation being defined, an expression, a property
  assert.deepEqual(defsIn('We write ', '$a \\preccurlyeq b', ' if ', '$a \\le 2b', '.'), []);
  assert.deepEqual(defsIn('Let ', '$u + v', ' be small.'), []);
  assert.deepEqual(defsIn('The set ', '$Z', ' is open, and ', '$Z', ' is closed.'), []);
  assert.deepEqual(defsIn('Let ', '$\\Lambda := \\{1, 2\\}', '.'), []); // := is read from the formula itself
});

test('a symbol is found again by its tokens, not inside other symbols', () => {
  const at = (sym, tex) => Insight.occurrences(Insight.texTokens(tex), Insight.patternOf(sym)).length;
  assert.equal(at('\\mathcal{G}_s', '\\mathcal G_{s} f'), 1);
  assert.equal(at('\\mathcal{G}_s', '\\mathcal{G}_{s+1} f'), 1); // the index is a variable
  assert.equal(at('Q', '\\hat Q + \\mathcal{Q} + \\text{Q-set}'), 0);
  assert.equal(at('Q', 'x \\in Q'), 1);
  assert.equal(at('\\phi', '\\varphi'), 0);
  assert.equal(at('\\Phi(x)', '\\Phi(y) + 1'), 1);
  // a small letter between delimiters is an argument
  assert.equal(at('\\langle u \\rangle_\\flat', '\\langle \\mathcal{G}_t f \\rangle_\\flat + \\langle B \\rangle_\\flat'), 2);
  assert.equal(at('\\|u\\|_{H^1}', '\\|f + g\\|_{H^1} \\le \\|f\\|_{L^2}'), 1);
  assert.equal(at('\\lambda z', '\\lambda + 1'), 0); // a letter at the end is not an argument
});

const DOC = String.raw`\documentclass{article}
\newtheorem{lemma}{Lemma}[section]
\newtheorem{definition}[lemma]{Definition}
\begin{document}
\section{Setting}
Let $Q$ be a compact set and denote by $\mathcal{G}_s$ the flow on it, where $\kappa$ is the decay rate.
We write $\langle u \rangle_\flat$ for the average of $u$ over $Q$.
\begin{lemma}\label{l:a}
Let $B$ be a ball. Then $\mathcal{G}_{s} B \subset Q$ and $\langle B \rangle_\flat \le \kappa$.
\end{lemma}
\begin{proof}
Let $\eta$ be the cut-off. Then $\eta \mathcal{G}_s = \mathcal{G}_s \eta$, and $B$ is fine.
\end{proof}
\section{Estimates}
The flow obeys
\[ \|\mathcal{G}_t f\| \le e^{-\kappa t} \|f\|, \]
where $\hat Q$ is unrelated, and $B$ and $\eta$ mean nothing here.
\end{document}`;

test('resting on a formula names the sentence that introduced its symbols', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
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
      window.insight = TeXglassInsight.attach({
        root: document.getElementById('preview'),
        jump: (el) => { window.jumped = el.dataset.tex; },
        renderTex: (texs) => texs.map((x) => `<b class="sym">${x}</b>`),
        delay: 30,
      });
      window.insight.setDefinitions(defs);
    }, r.defs);

    // The index lists what the text introduced, not what a statement or a proof keeps to itself.
    const listed = await page.evaluate(() => window.insight.index().symbols.map((s) => s.tex));
    assert.deepEqual(listed, ['Q', '\\mathcal{G}_s', '\\kappa', '\\langle u \\rangle_\\flat']);

    // Which definitions hold at each formula, by its TeX.
    const used = await page.evaluate(() => {
      const idx = window.insight.index();
      const out = {};
      for (const el of document.querySelectorAll('#preview .math[data-tex]')) {
        const notes = window.insight.notesFor(el).filter((n) => n.kind === 'symbol').flatMap((n) => n.group.map((d) => d.tex));
        if (notes.length) out[el.dataset.tex.trim()] = notes;
      }
      return out;
    });
    assert.deepEqual(used['\\mathcal{G}_{s} B \\subset Q'], ['Q', '\\mathcal{G}_s', 'B']);
    assert.deepEqual(used['\\langle B \\rangle_\\flat \\le \\kappa'], ['\\kappa', '\\langle u \\rangle_\\flat', 'B']); // u is an argument
    assert.deepEqual(used['\\eta \\mathcal{G}_s = \\mathcal{G}_s \\eta'], ['\\mathcal{G}_s', '\\eta']);
    assert.deepEqual(used['\\|\\mathcal{G}_t f\\| \\le e^{-\\kappa t} \\|f\\|,'], ['\\mathcal{G}_s', '\\kappa']);
    assert.equal(used['\\hat Q'], undefined);
    assert.equal(used.B, undefined); // the lemma's B and the proof's η stay there
    assert.equal(used['\\eta'], undefined);

    // The popover shows the sentence itself, with the symbol marked, and jumps to it.
    await page.locator('.math-display').first().hover();
    await page.waitForSelector('.insight-popover:not([hidden]) .insight-sentence');
    const text = await page.textContent('.insight-popover');
    assert.match(text, /introduced in §1 Setting/);
    assert.match(text, /denote by/);
    assert.match(text, /decay rate\./);
    assert.ok(await page.locator('.insight-popover .insight-sentence .insight-defined').count() >= 1);
    assert.equal(await page.locator('.insight-popover [id]').count(), 0);
    await page.click('.insight-popover a[data-go]');
    assert.equal(await page.evaluate(() => window.jumped), '\\mathcal{G}_s');

    // The notation tab shows the sentences too, and filters by their words.
    await page.evaluate(() => window.insight.open('notation'));
    assert.equal(await page.locator('.insight-symbols li').count(), 4);
    assert.equal(await page.locator('.insight-symbols .insight-sentence').count(), 4);
    await page.fill('.insight-filter', 'average');
    assert.equal(await page.locator('.insight-symbols li:not([hidden])').count(), 1);
  } finally {
    await browser.close();
  }
});
