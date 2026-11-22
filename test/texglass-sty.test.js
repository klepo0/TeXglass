'use strict';
// texglass.sty (latex/texglass.sty): hints for TeXglass that ordinary LaTeX
// ignores. The converter reads them (src/texglass.js) and the reading tools
// use them (src/insight.js): \tgdefine feeds notation hovers and the notation
// index, \tguses adds dependency-map links, \tgstep marks proof steps,
// \tghide/\tgonly and \iftexglass pick what shows where. The example is made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const Arxiv = require('../src/arxiv.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const STY = fs.readFileSync(path.join(ROOT, 'latex/texglass.sty'), 'utf8');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });
const plain = (tex) => `<span class="m">${tex}</span>`;

const DOC = String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\usepackage{texglass}
\newtheorem{lemma}{Lemma}[section]
\newtheorem{theorem}[lemma]{Theorem}
\tgdefine{\mathcal{W}}{the set of admissible weights}
\begin{document}
\section{Setting}
Let $Q$ be a box and write $\Lambda_s$ for the flow.
\tgdefine{\Lambda_s}{the heat flow at time $s$, run backwards}
\begin{lemma}\label{l:base} For $w \in \mathcal{W}$ we have $\Lambda_s w \ge 0$. \end{lemma}
\begin{lemma}\label{l:other} Something else about $Q$. \end{lemma}
\begin{theorem}\label{t:main} $\Lambda_s Q \subset Q$.\tguses{l:other} \end{theorem}
\begin{proof}
\tgstep[Reduce to a ball] First, by Lemma~\ref{l:base}, it is enough to look at balls.
\tgstep Then $\Lambda_s$ shrinks them.
\end{proof}
Shown everywhere.\tghide{ Only in the PDF.}\tgonly{ Only on the web.}
\begin{tgonly}
A web-only paragraph with \textbf{bold} words.
\end{tgonly}
\begin{tghide}
A PDF-only paragraph.
\end{tghide}
\iftexglass Read in TeXglass.\else Read as a PDF.\fi
\tgparam[2]{p}{1}{4}
\end{document}`;

test('texglass.sty defines the commands TeXglass reads, and nothing it does not', () => {
  const defined = Array.from(STY.matchAll(/\\newcommand\*?\\(tg[A-Za-z]+)/g)).map((m) => m[1]).sort();
  assert.deepEqual(defined, ['tgdefine', 'tghide', 'tgonly', 'tgparam', 'tgstep', 'tguses']);
  assert.match(STY, /\\ProvidesPackage\{texglass\}/);
  assert.match(STY, /\\newif\\iftexglass/);
  // a paper that ships its own copy: TeXglass reads the commands itself, not the copy
  const out = Arxiv.flatten('paper.tex', { 'paper.tex': '\\documentclass{article}\\usepackage{texglass}\\begin{document}x\\end{document}', 'texglass.sty': STY });
  assert.doesNotMatch(out, /ProvidesPackage/);
  // the npm package carries it, for `npx texglass --sty`
  assert.ok(require('../package.json').files.includes('latex/texglass.sty'));
});

test('the converter reads each hint', () => {
  const r = TeXglass.render(DOC, { renderMath: plain });
  const h = r.html;
  // \tgdefine: an empty marker with the symbol and its meaning (as HTML)
  assert.match(h, /<span class="tg-define" data-tg-sym="\\Lambda_s" data-tg-meaning="the heat flow at time &lt;span class=&quot;math math-inline&quot;[^"]*"><\/span>/);
  assert.doesNotMatch(h, /<p><span class="tg-define"/); // a line of markers alone is no paragraph
  // ... and from the preamble, kept for the whole paper (at the end of the page)
  assert.match(h, /<span class="tg-define" data-tg-sym="\\mathcal\{W\}" data-tg-meaning="the set of admissible weights" data-tg-scope="document"><\/span>\s*$/);
  // \tguses: an empty link to the result, inside the theorem
  const other = /id="(thm-\d+)"[^>]*data-label="l:other"/.exec(h)[1];
  assert.match(h, new RegExp(`data-label="t:main"><p>.*<a class="ref tg-uses" href="#${other}" data-label="l:other" aria-hidden="true" tabindex="-1"></a></p></div>`));
  assert.equal(h.split('data-label="l:other"').length, 3); // the lemma and the \\tguses link
  // \tgstep: step marks for stepping through the proof (src/steps.js)
  assert.match(h, /<span class="tg-stepmark" data-tg-step="Reduce to a ball"><\/span>/);
  assert.match(h, /<span class="tg-stepmark" data-tg-step=""><\/span>/);
  // \tghide, \tgonly and \iftexglass
  assert.match(h, /Shown everywhere\. Only on the web\./);
  assert.doesNotMatch(h, /Only in the PDF|PDF-only|Read as a PDF/);
  assert.match(h, /<p>A web-only paragraph with <strong>bold<\/strong> words\.<\/p>/);
  assert.match(h, /Read in TeXglass\./);
  // \tgparam: recorded for live sliders
  assert.match(h, /<span class="tg-param" data-name="p" data-min="1" data-max="4" data-value="2" hidden><\/span>/);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.unknownCommands, []);

  const missing = TeXglass.render('\\begin{document}\\tguses{nope}\\end{document}', { renderMath: plain });
  assert.deepEqual(missing.warnings, ['Undefined reference "nope" in \\tguses.']);
  // the package's own definitions, if a copy gets read, change nothing
  const copied = TeXglass.render(`\\makeatletter\n${STY}\n\\makeatother\n\\begin{document}\\tgonly{web}\\iftexglass\\ yes\\fi\\end{document}`, { renderMath: plain });
  assert.match(copied.html, /web yes/);
  // $…$ around a \tgdefine symbol is optional
  assert.match(TeXglass.render('\\begin{document}\\tgdefine{$\\nu$}{a rate}\\end{document}', { renderMath: plain }).html, /data-tg-sym="\\nu"/);
});

let tex = null;
try { execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); tex = 'pdflatex'; } catch (e) { /* no TeX here */ }

test('a paper with texglass.sty compiles with pdflatex', { skip: !tex && 'pdflatex is not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texglass-sty-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'latex/texglass.sty'), path.join(dir, 'texglass.sty'));
    fs.writeFileSync(path.join(dir, 'paper.tex'), DOC);
    execFileSync(tex, ['-interaction=nonstopmode', '-halt-on-error', 'paper.tex'], { cwd: dir, stdio: 'ignore' });
    assert.ok(fs.existsSync(path.join(dir, 'paper.pdf')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hints leave the PDF byte for byte as without them, after a display too', { skip: !tex && 'pdflatex is not installed' }, () => {
  // After a displayed equation TeX skips the spaces that start the next line,
  // so "\tgstep[T] For" there must not leave the space after ] on the page.
  const withHints = String.raw`\pdftrailerid{}\documentclass{article}
\usepackage{amsmath}
\usepackage{texglass}
\tgdefine{X}{a thing}
\begin{document}
Some text with a display
\begin{align}
  a &= b
\end{align}
	\tgstep[After a display] For the next step, see.\tgstep[After a full stop] Then more,
and a mark mid-line \tgstep after a space.
\[ x \]
\tguses{x} After a display, again.
\end{document}
`;
  const without = withHints.replace(/\\usepackage\{texglass\}\n|\\tgdefine\{X\}\{a thing\}\n/g, '')
    .replace(/\\tgstep\[After a display\] |\\tgstep\[After a full stop\]|\\tgstep |\\tguses\{x\} /g, '');
  assert.doesNotMatch(without, /\\tg/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texglass-sty-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'latex/texglass.sty'), path.join(dir, 'texglass.sty'));
    const pdf = (name, body) => {
      fs.writeFileSync(path.join(dir, `${name}.tex`), body);
      execFileSync(tex, ['-interaction=nonstopmode', '-halt-on-error', `${name}.tex`], {
        cwd: dir, stdio: 'ignore', env: { ...process.env, SOURCE_DATE_EPOCH: '0', FORCE_SOURCE_DATE: '1' },
      });
      return fs.readFileSync(path.join(dir, `${name}.pdf`));
    };
    assert.ok(pdf('with', withHints).equals(pdf('without', without)), 'the PDFs differ');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notation hovers and the index use \\tgdefine; the map uses \\tguses', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
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
        jump: () => {},
        renderTex: (texs) => texs.map((x) => `<b class="sym">${x}</b>`),
        delay: 30,
      });
      window.insight.setDefinitions(defs);
    }, r.defs);

    // \tguses{l:other} adds a link the text doesn't state; \ref{l:base} in the proof stays
    const deps = await page.evaluate(() => window.insight.graph().nodes.map((n) => [n.name, Array.from(n.uses).map((m) => m.name).sort()]));
    assert.deepEqual(deps, [['Lemma 1.1', []], ['Lemma 1.2', []], ['Theorem 1.3', ['Lemma 1.1', 'Lemma 1.2']]]);
    const edge = await page.evaluate(() => {
      const g = window.insight.graph();
      const [main, other] = [g.nodes[2], g.nodes[1]];
      return main.edges.get(other);
    });
    assert.equal(edge.statement, true);
    assert.equal(edge.guessed, false);

    // The author's meaning wins over the sentence ("write Λ_s for the flow"),
    // and a preamble \tgdefine holds from the start.
    const idx = await page.evaluate(() => window.insight.index().symbols.map((s) => [s.tex, !!s.author]));
    assert.deepEqual(idx, [['Q', false], ['\\Lambda_s', true], ['\\mathcal{W}', true]]);
    const notes = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('#preview .math[data-tex]')) {
        const ns = window.insight.notesFor(el).filter((n) => n.kind === 'symbol').map((n) => n.s.tex + (n.s.author ? ' (author)' : ''));
        if (ns.length) out[el.dataset.tex.trim()] = ns;
      }
      return out;
    });
    assert.deepEqual(notes['w \\in \\mathcal{W}'], ['\\mathcal{W} (author)']);
    assert.deepEqual(notes['\\Lambda_s w \\ge 0'], ['\\Lambda_s (author)']);

    // The popover shows the meaning the author gave
    const box = await page.locator('#preview .theorem .math[data-tex]').nth(1).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('.insight-popover:not([hidden]) .insight-author-def');
    const text = await page.textContent('.insight-popover');
    assert.match(text, /heat flow at time/);
    assert.match(text, /run backwards/);
    assert.match(text, /The author's description, in §1/);

    // The notation tab lists it, and finds it by its words
    await page.evaluate(() => window.insight.open('notation'));
    await page.fill('.insight-filter', 'admissible');
    assert.equal(await page.locator('.insight-symbols li:not([hidden])').count(), 1);
    assert.match(await page.locator('.insight-symbols li:not([hidden])').textContent(), /admissible weights/);
  } finally {
    await browser.close();
  }
});
