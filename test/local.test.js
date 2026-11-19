'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Local = require('../src/local.js');

const enc = (s) => new TextEncoder().encode(s);

const MAIN = String.raw`\documentclass{article}
\usepackage{amsmath,mymacros}
\graphicspath{{figs/}}
\begin{document}
\input{sections/intro}
\include{proof}
% \input{commented-out}
\includegraphics[width=3cm]{plot}
\includegraphics{diagram.pdf}
\bibliography{refs}
\end{document}
`;

const FOLDER = {
  'main.tex': MAIN,
  'mymacros.sty': '\\newcommand{\\R}{\\mathbb{R}}',
  'sections/intro.tex': 'Intro text. \\input{sections/deeper}',
  'sections/deeper.tex': 'Deeper text with $\\R$.',
  'proof.tex': 'Proof text.',
  'figs/plot.png': '\x89PNG fake',
  'figs/diagram.png': '\x89PNG fake 2',
  'refs.bib': '@article{a, title={T}, author={A. Author}, year={2020}}',
  'unrelated.txt': 'not read',
};

test('references lists what a file pulls in, ignoring comments', () => {
  const refs = Local.references(MAIN, 'main.tex');
  const names = refs.map((r) => `${r.kind}:${r.name}`);
  assert.ok(names.includes('tex:sections/intro'));
  assert.ok(names.includes('tex:proof'));
  assert.ok(!names.some((n) => n.includes('commented-out')));
  assert.ok(names.includes('sty:mymacros'));
  assert.ok(names.includes('bib:refs'));
  assert.ok(names.includes('bib:main.bbl'));
  const plot = refs.find((r) => r.name === 'plot');
  assert.ok(plot.tries.includes('figs/plot.png'));
  const pdf = refs.find((r) => r.name === 'diagram.pdf');
  assert.ok(pdf.tries.includes('figs/diagram.png'), 'a .pdf figure looks for a picture of the same name');
});

test('gather follows \\input files, packages, bibliography and figures on demand', async () => {
  const asked = [];
  const read = async (p) => {
    asked.push(p);
    return FOLDER[p] != null ? enc(FOLDER[p]) : null;
  };
  const raw = await Local.gather('main.tex', read);
  assert.deepStrictEqual(Object.keys(raw).sort(), [
    'figs/diagram.png', 'figs/plot.png', 'main.tex', 'mymacros.sty', 'proof.tex', 'refs.bib', 'sections/deeper.tex', 'sections/intro.tex',
  ]);
  assert.ok(!asked.includes('unrelated.txt'));
  assert.strictEqual(new Set(asked).size, asked.length, 'never asks for the same path twice');
});

test('gather returns null when the main file cannot be read', async () => {
  assert.strictEqual(await Local.gather('main.tex', async () => null), null);
});

test('fromFolder finds the main file and inlines everything', () => {
  const raw = {};
  for (const [p, s] of Object.entries(FOLDER)) raw['paper/' + p] = enc(s);
  const doc = Local.fromFolder(raw);
  assert.strictEqual(doc.main, 'main.tex');
  assert.strictEqual(doc.name, 'main.tex');
  assert.match(doc.source, /Intro text\. Deeper text with/);
  assert.match(doc.source, /Proof text\./);
  assert.match(doc.source, /\\newcommand\{\\R\}/);
  assert.match(doc.source, /\\begin\{thebibliography\}/);
  assert.deepStrictEqual(Object.keys(doc.images).sort(), ['figs/diagram.png', 'figs/plot.png']);
});

test('fromFolder takes paths relative to a main file in a subfolder', () => {
  const doc = Local.fromFolder({
    'project/notes.txt': enc('x'),
    'project/tex/paper.tex': enc('\\documentclass{article}\\begin{document}\\input{part}\\end{document}'),
    'project/tex/part.tex': enc('The part.'),
    'project/other.tex': enc('Just a fragment.'),
  });
  assert.strictEqual(doc.main, 'paper.tex');
  assert.match(doc.source, /The part\./);
});

test('fromFolder honours a chosen main file', () => {
  const doc = Local.fromFolder({ 'a.tex': enc('\\documentclass{article}A'), 'b.tex': enc('B \\input{a}') }, { main: 'b.tex' });
  assert.strictEqual(doc.main, 'b.tex');
});

test('fromFolder refuses a folder without .tex files', () => {
  assert.throws(() => Local.fromFolder({ 'a.png': enc('x') }), /no \.tex file/);
});

test('missing names the inputs and figures of a lone file', () => {
  const m = Local.missing(MAIN);
  assert.deepStrictEqual(m.inputs, ['sections/intro', 'proof']);
  assert.deepStrictEqual(m.figures, ['plot', 'diagram.pdf']);
  assert.deepStrictEqual(Local.missing('Just $x$.'), { inputs: [], figures: [] });
});

test('wanted reads LaTeX files and figures only', () => {
  assert.ok(Local.wanted('a/b.tex') && Local.wanted('x.bib') && Local.wanted('f.PNG') && Local.wanted('m.sty'));
  assert.ok(!Local.wanted('paper.pdf') && !Local.wanted('main.log') && !Local.wanted('main.aux'));
});

test('files chosen without their folders still find each other by name', () => {
  const doc = Local.fromFolder({
    'main.tex': enc('\\documentclass{article}\\begin{document}\\input{sections/intro}\\includegraphics{figs/dot}\\end{document}'),
    'intro.tex': enc('The intro.'),
    'dot.png': enc('png'),
  });
  assert.match(doc.source, /The intro\./);
  assert.ok(doc.images['figs/dot.png']);
});
