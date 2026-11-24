'use strict';
// The reader's own LaTeX for what TeXglass cannot draw: src/texfallback.js
// (finding failed pieces, the LaTeX for them, swapping in the drawings) and
// src/texfallback-node.js (running TeX). The TeX runs are skipped where no
// pdflatex is installed, the page tests where Playwright is not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const F = require('../src/texfallback.js');
const { createCompiler, which } = require('../src/texfallback-node.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }
const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });
const hasTex = !!which('pdflatex');

const DOC = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,tikz} % the usual
\newcommand{\Frob}{\mathcal{F}}
\begin{document}
\section{Start}
A good formula $a+b$ and one KaTeX does not know $\Frob \strangeop x$, and a broken one $\frac{1}{$.
\begin{align}
u &= \strangeop v \label{eq:u}\\
w &= 2 \nonumber
\end{align}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}

\begin{tikzpicture}\shade (0,0) circle (1);\draw (0,0) -- (1,0);\end{tikzpicture}
\end{document}`;

test('the preamble, without comments; none without \\documentclass', () => {
  const pre = F.preamble(DOC);
  assert.match(pre, /^\\documentclass\[11pt\]\{article\}/);
  assert.match(pre, /\\newcommand\{\\Frob\}/);
  assert.doesNotMatch(pre, /the usual|begin\{document\}/);
  assert.equal(F.preamble('just text \\begin{document} x'), null);
  assert.equal(F.preamble('\\documentclass{article}\n% \\begin{document}\n\\usepackage{x}\n\\begin{document}').trim(), '\\documentclass{article}\n\n\\usepackage{x}');
});

test('the engine follows the preamble', () => {
  assert.equal(F.engineFor('\\documentclass{article}\\usepackage{amsmath}'), 'pdflatex');
  assert.equal(F.engineFor('\\documentclass{article}\\usepackage{fontspec}'), 'xelatex');
  assert.equal(F.engineFor('\\documentclass{article}\\usepackage[math-style=ISO]{unicode-math}'), 'xelatex');
  assert.equal(F.engineFor('\\documentclass{article}\\usepackage{luacode}'), 'lualatex');
  assert.equal(F.engineFor('\\documentclass{article}%\\usepackage{fontspec}'), 'pdflatex');
});

test('formulas: inline in $…$, displays unnumbered by LaTeX but with the numbers TeXglass shows', () => {
  const pre = '\\documentclass{article}\\usepackage{amsmath}';
  assert.equal(F.mathTex('x^2', false, '', pre), '$x^2$');
  assert.equal(F.mathTex('\\weird x', true, '\\weird x\\tag{3.1}', pre), '\\[ \\weird x \\tag{3.1} \\]');
  assert.equal(F.mathTex('\\weird x', true, '\\weird x\\tag{3.1}', '\\documentclass{article}'), '\\[ \\weird x \\]', 'no \\tag without amsmath');
  const al = F.mathTex('\\begin{align}a &= b\\\\ c &= d\\end{align}', true, '\\begin{align}a &= b\\tag{1} \\\\ c &= d\\end{align}', pre);
  assert.equal(al, '\\begin{align*}a &= b \\tag{1} \\\\\n c &= d\\end{align*}');
  assert.equal(F.mathTex('\\begin{align*}a\\\\b\\end{align*}', true, '', pre), '\\begin{align*}a\\\\b\\end{align*}');
  assert.deepEqual(F.rows('a & {b \\\\ c} \\\\[2pt] \\begin{matrix}1\\\\2\\end{matrix} \\\\'), ['a & {b \\\\ c} ', ' \\begin{matrix}1\\\\2\\end{matrix} ']);
});

test('pictures drawn in part or not at all keep their source; pictures drawn in full do not', () => {
  const html = TeXglass.render(DOC, { renderMath }).html;
  const sources = [...html.matchAll(/data-tg-source="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(sources.length, 1);
  assert.match(sources[0], /^\\begin\{tikzpicture\}\\shade/);
  assert.match(sources[0], /\\end\{tikzpicture\}$/);
});

test('documentFor puts each piece on a page of its own; parseLog reads sizes and errors', () => {
  const tex = F.documentFor('\\documentclass{article}\n', [{ kind: 'math', tex: '$x$' }, { kind: 'math', display: true, tex: '\\[y\\]' }]);
  assert.match(tex, /\\usepackage\[active,tightpage\]\{preview\}/);
  assert.equal((tex.match(/\\begin\{preview\}/g) || []).length, 2);
  assert.match(tex, /\\begin\{minipage\}\{\\linewidth\}\\\[y\\\]\\end\{minipage\}/);
  const log = 'Preview: Fontsize 10.95pt\nTGPIECE 1\nTGBOX 9.1pt 2.7pt 13.3pt\nTGPIECE 2\n! Undefined control sequence.\nTGBOX 1.0pt 0.0pt 3.0pt\nTGPIECE END\nOutput written on x.pdf (2 pages, 100 bytes).';
  const r = F.parseLog(log, 2);
  assert.equal(r.fontSize, 10.95);
  assert.deepEqual(r.pieces[0], { ok: true, page: 1, height: 9.1, depth: 2.7, width: 13.3 });
  assert.equal(r.pieces[1].ok, false);
  assert.equal(F.parseLog('! LaTeX Error: File `nope.sty\' not found.\n! Emergency stop.', 2).fatal, true);
  assert.equal(F.parseLog(log.replace('(2 pages', '(3 pages'), 2).pieces[0].ok, false, 'pages and pieces apart');
});

test('in a page: failed formulas and pictures are found, drawn and swapped in, and asked for once', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const html = TeXglass.render(DOC, { renderMath }).html;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style></head><body><main id="p">${html}</main></body></html>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/texfallback.js') });
    const out = await page.evaluate(async ([pre, html]) => {
      // pdf.js stands in: a 20pt × 10pt image per page
      window.TeXglassPdf = { toImage: async (blob, o) => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="20pt" height="10pt" data-page="${o.page}"></svg>`], { type: 'image/svg+xml' }) };
      const asked = [];
      const fb = TeXglassTexFallback.create({
        root: document.getElementById('p'),
        preamble: () => pre,
        request: async (pieces) => {
          asked.push(pieces.map((p) => `${p.kind}:${p.tex}`));
          return pieces.map((p, k) => (p.tex.includes('frac{1}{') ? null : { pdf: 'JVBERg==', page: k + 1, depth: 2, fontSize: 10 }));
        },
      });
      await fb.refresh();
      const root = document.getElementById('p');
      const first = {
        imgs: root.querySelectorAll('img.tg-texfallback-img').length,
        inline: root.querySelector('.math-inline img') && root.querySelector('.math-inline img').style.cssText,
        failed: root.querySelectorAll('[data-tg-texfallback="failed"]').length,
        good: root.querySelector('.math[data-tex="a+b"] .katex') !== null,
        picture: root.querySelectorAll('.tg-texfallback-picture').length,
        tikzKept: root.querySelectorAll('.tg-tikz').length,
      };
      // the same blocks rendered again (an edit elsewhere): drawn from what is kept, without asking
      root.insertAdjacentHTML('beforeend', html);
      await fb.refresh();
      return { asked, first, second: root.querySelectorAll('img.tg-texfallback-img').length };
    }, [F.preamble(DOC), html]);
    assert.equal(out.asked.length, 1, 'asked once');
    assert.deepEqual(out.asked[0].map((s) => s.split(':')[0]), ['math', 'math', 'math', 'picture']);
    assert.ok(out.asked[0].some((s) => s.includes('\\begin{align*}') && s.includes('\\tag{1}')), out.asked[0].join('\n'));
    assert.equal(out.first.imgs, 3);
    assert.equal(out.second, 6);
    assert.equal(out.first.failed, 1, 'TeX failed too: TeXglass keeps its own');
    assert.ok(out.first.good, 'formulas KaTeX drew stay');
    assert.equal(out.first.picture, 1);
    assert.equal(out.first.tikzKept, 1, 'the picture tikz.js drew in full stays');
    assert.match(out.first.inline, /width: 2\.42em/);
    assert.match(out.first.inline, /vertical-align: -0\.30\d*em/);
  } finally {
    await browser.close();
  }
});

test('TeX draws the pieces in one run, keeps them, and skips what fails', { skip: !hasTex && 'pdflatex is not installed' }, async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tex-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doc-'));
  fs.writeFileSync(path.join(dir, 'mymacros.sty'), '\\newcommand{\\mine}{\\mathbf{M}}\n');
  const source = '\\documentclass{article}\n\\usepackage{amsmath,mymacros}\n\\begin{document}\nx\n\\end{document}\n';
  const pieces = [
    { kind: 'math', display: false, tex: '$\\mine_x$' },
    { kind: 'math', display: true, tex: '\\[ \\int_0^1 \\mine \\tag{2} \\]' },
    { kind: 'math', display: false, tex: '$\\nosuchcommand$' },
    { kind: 'picture', display: true, tex: '\\begin{picture}(20,10)\\put(0,0){\\line(1,0){20}}\\end{picture}' },
  ];
  try {
    const tex = createCompiler({ cacheDir });
    const info = await tex.available('');
    assert.equal(info.engine, 'pdflatex');
    assert.equal(info.missing, undefined, 'preview.sty is installed');
    const r = await tex.draw({ source, dir, pieces });
    assert.equal(r.length, 4);
    assert.ok(r[0] && r[1] && r[3], 'drawn, with the document folder\'s own package');
    assert.equal(r[2], null, 'a TeX error: no drawing');
    assert.equal(r[0].pdf, r[1].pdf, 'one run, one PDF');
    assert.deepEqual([r[0].page, r[1].page, r[3].page], [1, 2, 4]);
    assert.ok(r[0].depth > 0 && r[0].fontSize === 10);
    assert.equal(r[0].pdf.subarray(0, 4).toString(), '%PDF');
    // kept on disk: another session draws them without running TeX
    const t0 = Date.now();
    const again = await createCompiler({ cacheDir }).draw({ source, dir, pieces: [pieces[0], pieces[1]] });
    assert.ok(again[0] && again[1]);
    assert.ok(Date.now() - t0 < 1000);
    // no TeX at all: nothing, quietly
    const none = createCompiler({ cacheDir, engine: 'no-such-tex-engine' });
    assert.equal(await none.available(''), null);
    assert.deepEqual(await none.draw({ source, dir, pieces }), [null, null, null, null]);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
