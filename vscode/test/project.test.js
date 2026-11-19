'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { assemble, locate, findRoot } = require('../project.js');
const { parseBib, makeBibliography, parseName } = require('../shared/bib.js');

const fsOf = (files) => (p) => (files[p] !== undefined ? files[p] : null);
const R = path.resolve('/proj');
const P = (n) => path.join(R, n);

test('pulls in \\input, \\include and \\import files and maps offsets back', () => {
  const files = {
    [P('main.tex')]: '\\documentclass{article}\n\\begin{document}\nIntro.\n\\input{chap1}\n% \\input{ignored}\n\\include{chap2}\n\\import{parts/}{p}\nEnd.\n\\end{document}\n',
    [P('chap1.tex')]: 'Chapter one text.\n',
    [P('chap2.tex')]: 'Chapter two \\input{chap1} again.\n',
    [P('parts/p.tex')]: 'Part P.\n',
  };
  const pr = assemble(P('main.tex'), fsOf(files));
  assert.match(pr.text, /Intro\.\nChapter one text\.\n\n/);
  assert.match(pr.text, /Chapter two Chapter one text\.\n again/);
  assert.match(pr.text, /Part P\./);
  assert.match(pr.text, /% \\input\{ignored\}/);
  const at = pr.text.indexOf('two');
  const loc = locate(pr, at);
  assert.strictEqual(pr.files[loc.file], P('chap2.tex'));
  assert.strictEqual(files[P('chap2.tex')].slice(loc.offset, loc.offset + 3), 'two');
  const end = locate(pr, pr.text.indexOf('End.'));
  assert.strictEqual(files[P('main.tex')].slice(end.offset, end.offset + 4), 'End.');
  assert.deepStrictEqual(pr.warnings, []);
});

test('warns about a missing \\input file and leaves the command', () => {
  const pr = assemble(P('m.tex'), fsOf({ [P('m.tex')]: 'a \\input{nope} b' }));
  assert.match(pr.text, /\\input\{nope\}/);
  assert.match(pr.warnings[0], /nope/);
});

test('builds the bibliography from a .bib file, sorted, cited entries only', () => {
  const files = {
    [P('m.tex')]: 'See \\cite{zeta,alpha} and \\citep[p.~2]{beta}.\n\\bibliographystyle{amsplain}\n\\bibliography{refs}\n',
    [P('refs.bib')]: `@string{ann = "Annals of Math."}
@article{alpha, author = {Lurie, Jacob and Gaitsgory, Dennis}, title = {Weil's {Conjecture}}, journal = ann, volume = 3, year = 2019, pages = {1--20}}
@book{zeta, author = "A. Zeta", title = {A Book}, publisher = {Springer}, year = {2001}}
@misc{beta, author = {Beta, B.}, title = {Notes}, eprint = {2101.00001}, year = 2021}
@misc{unused, title = {Unused}}`,
  };
  const pr = assemble(P('m.tex'), fsOf(files));
  const bib = pr.text.slice(pr.text.indexOf('\\begin{thebibliography}'));
  assert.ok(bib.indexOf('{beta}') < bib.indexOf('{alpha}') && bib.indexOf('{alpha}') < bib.indexOf('{zeta}'), bib);
  assert.match(bib, /Jacob Lurie and Dennis Gaitsgory, \\emph\{Weil's \{Conjecture\}\}, Annals of Math\. \\textbf\{3\} \(2019\), 1--20\./);
  assert.match(bib, /arXiv:2101\.00001/);
  assert.ok(!/Unused/.test(bib));
  // The generated text maps back to the \bibliography command.
  const loc = locate(pr, pr.text.indexOf('A Book'));
  assert.strictEqual(files[P('m.tex')].slice(loc.offset, loc.offset + 13), '\\bibliography');
});

test('uses the .bbl when it covers every citation, else the .bib', () => {
  const tex = 'x \\cite{a}\n\\bibliography{refs}\n';
  const bbl = '\\begin{thebibliography}{1}\n\\bibitem{a} From the bbl.\n\\end{thebibliography}\n';
  const bibf = '@misc{a, title={From the bib}} @misc{b, title={B}}';
  let pr = assemble(P('m.tex'), fsOf({ [P('m.tex')]: tex, [P('m.bbl')]: bbl, [P('refs.bib')]: bibf }));
  assert.match(pr.text, /From the bbl/);
  pr = assemble(P('m.tex'), fsOf({ [P('m.tex')]: tex + '\\cite{b}', [P('m.bbl')]: bbl, [P('refs.bib')]: bibf }));
  assert.match(pr.text, /From the bib/);
});

test('an amsrefs .bbl (\\bib records in a bibdiv) is used as it is', () => {
  const tex = 'x \\cite{a}\n\\bibliography{refs}\n';
  const bbl = '\\begin{bibdiv}\n\\begin{biblist}\n\\bib{a}{article}{\n  author={Writer, Ada},\n  title={From the amsrefs bbl},\n}\n\\end{biblist}\n\\end{bibdiv}\n';
  const pr = assemble(P('m.tex'), fsOf({ [P('m.tex')]: tex, [P('m.bbl')]: bbl }));
  assert.match(pr.text, /\\begin\{bibdiv\}[\s\S]*From the amsrefs bbl/);
  assert.doesNotMatch(pr.text, /\\bibliography\{refs\}/);
});

test('biblatex: \\addbibresource and \\printbibliography, alpha labels', () => {
  const files = {
    [P('m.tex')]: '\\addbibresource{refs.bib}\n\\bibliographystyle{alpha}\n\\textcite{x} \\nocite{y}\n\\printbibliography[title=Refs]\n',
    [P('refs.bib')]: '@article{x, author={Scholze, Peter}, title={P}, journal={J}, year={2012}} @article{y, author={Bhatt, B. and Morrow, M. and Scholze, P.}, title={I}, journal={J}, year={2018}}',
  };
  const pr = assemble(P('m.tex'), fsOf(files));
  assert.match(pr.text, /\\bibitem\[BMS18\]\{y\}/);
  assert.match(pr.text, /\\bibitem\[Sch12\]\{x\}/);
});

test('names and the project root', () => {
  assert.deepStrictEqual(parseName('van der Waals, Johannes'), { first: 'Johannes', last: 'van der Waals' });
  assert.deepStrictEqual(parseName('Johannes van der Waals'), { first: 'Johannes', last: 'van der Waals' });
  assert.deepStrictEqual(parseName('{Bourbaki Group}'), { first: '', last: '{Bourbaki Group}' });
  const files = { [P('main.tex')]: '\\documentclass{book}\\include{ch/one}', [P('ch/one.tex')]: 'One.', [P('ch/two.tex')]: '% !TEX root = ../main.tex\nTwo.' };
  const list = (d) => Object.keys(files).filter((f) => path.dirname(f) === d);
  assert.strictEqual(findRoot(P('ch/one.tex'), files[P('ch/one.tex')], list, fsOf(files)), P('main.tex'));
  assert.strictEqual(findRoot(P('ch/two.tex'), files[P('ch/two.tex')], list, fsOf(files)), P('main.tex'));
  assert.strictEqual(findRoot(P('main.tex'), files[P('main.tex')], list, fsOf(files)), P('main.tex'));
  const e = parseBib('@Article{k, Title = "A " # {B}, Month = jan, Year = 2000}');
  assert.strictEqual(e.k.fields.title, 'A B');
  assert.strictEqual(e.k.fields.month, 'January');
  assert.match(makeBibliography(e, ['k', 'missing'], '').text, /\\bibitem\{k\}/);
});

test('\\includeonly leaves out the other \\include files but not \\input ones', () => {
  const files = {
    [P('main.tex')]: '\\documentclass{book}\n\\includeonly{ch/two}\n\\begin{document}\n\\include{ch/one}\n\\include{./ch/two.tex}\n\\input{ch/three}\n\\end{document}\n',
    [P('ch/one.tex')]: 'One.',
    [P('ch/two.tex')]: 'Two.',
    [P('ch/three.tex')]: 'Three.',
  };
  const pr = assemble(P('main.tex'), fsOf(files));
  assert.doesNotMatch(pr.text, /One\./);
  assert.match(pr.text, /Two\./);
  assert.match(pr.text, /Three\./);
  assert.doesNotMatch(pr.text, /\\include\{ch\/one\}/);
  assert.deepStrictEqual(pr.warnings, []);
});

test('findRoot searches up through folders and nested inputs, and reads subfiles', () => {
  const files = {
    [P('thesis.tex')]: '\\documentclass{book}\\begin{document}\\include{parts/part1}\\subfile{ch/sub}\\end{document}',
    [P('notes.tex')]: '\\documentclass{article}\\begin{document}Other.\\end{document}',
    [P('parts/part1.tex')]: '\\input{parts/deep/sec}',
    [P('parts/deep/sec.tex')]: 'A section.',
    [P('parts/deep/orphan.tex')]: 'Nobody includes me.',
    [P('ch/sub.tex')]: '\\documentclass[../thesis.tex]{subfiles}\n\\begin{document}Sub.\\end{document}',
  };
  const list = (d) => Object.keys(files).filter((f) => path.dirname(f) === d);
  const root = (n, top) => findRoot(P(n), files[P(n)], list, fsOf(files), path, top);
  assert.strictEqual(root('parts/deep/sec.tex'), P('thesis.tex'));
  assert.strictEqual(root('parts/part1.tex'), P('thesis.tex'));
  assert.strictEqual(root('ch/sub.tex'), P('thesis.tex'));
  assert.strictEqual(root('parts/deep/orphan.tex'), P('parts/deep/orphan.tex'));
  // Not above the workspace folder.
  assert.strictEqual(root('parts/deep/sec.tex', P('parts')), P('parts/deep/sec.tex'));
});
