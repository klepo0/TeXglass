'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const A = require('../src/arxiv.js');
const B = require('../src/bib.js');
const TeXglass = require('../src/texglass.js');

/** A minimal ustar archive from { path: string }. */
function tar(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const BIB = `
@article{FHL21, author = {Peter K. Friz and Antoine Hocquet and Khoa L{\\^e}}, title = {Rough stochastic differential equations},
  journal = {Preprint}, year = {2021}}
@book{Cohen2015, author = {Samuel N. Cohen and Robert J. Elliott}, title = {Stochastic Calculus and Applications}, publisher = {Birkh{\\"a}user}, date = {2015-06}}
@misc{unused, author = {No One}, title = {Never cited}, year = {2000}}
`;

// A paper like arXiv 2610.41664: biblatex with biber, and only the .bib in the source (no .bbl).
const BIBLATEX_MAIN = `\\documentclass{article}
\\usepackage[backend=biber, style=alphabetic, maxbibnames=99]{biblatex}
\\addbibresource{refs.bib}
\\begin{document}
See \\cite{FHL21} and \\parencite[Ch.~2]{Cohen2015}.
\\printbibliography
\\end{document}`;

test('an arXiv import with biblatex and only a .bib lists the cited entries', async () => {
  const tarball = zlib.gzipSync(tar({ 'main.tex': BIBLATEX_MAIN, 'refs.bib': BIB }));
  const p = await A.importPaper('2610.41664', { fetch: async () => new Response(tarball) });
  assert.match(p.source, /\\begin\{thebibliography\}/);
  assert.doesNotMatch(p.source, /\\printbibliography/);
  assert.match(p.source, /\\bibitem\[FHL21\]\{FHL21\}/);
  assert.match(p.source, /\\bibitem\[CE15\]\{Cohen2015\}/, 'the year comes from date =');
  assert.doesNotMatch(p.source, /unused/);
  const html = TeXglass.render(p.source).html;
  assert.doesNotMatch(html, /cite-key/, 'every citation resolves');
  assert.match(html, /class="bibliography"/);
});

test('\\bibliography{name} without extension finds name.bib in a subfolder', () => {
  const files = {
    'paper/main.tex': '\\documentclass{article}\\begin{document}\\cite{FHL21}\\bibliographystyle{plain}\\bibliography{refs}\\end{document}',
    'paper/refs.bib': BIB,
  };
  const out = A.flatten('paper/main.tex', files);
  assert.match(out, /\\bibitem\{FHL21\}/);
  assert.doesNotMatch(out, /\\bibliography\{/);
});

test('a BibTeX .bbl still goes in as it is', () => {
  const files = {
    'main.tex': '\\documentclass{article}\\begin{document}\\cite{a}\\bibliography{refs}\\end{document}',
    'main.bbl': '\\begin{thebibliography}{1}\\bibitem{a} A.\\end{thebibliography}',
    'refs.bib': BIB,
  };
  assert.match(A.flatten('main.tex', files), /\\bibitem\{a\} A\./);
});

// What biber 2.x writes for biblatex 3.x.
const BIBER_BBL = `% $ biblatex auxiliary file $
\\begingroup
\\makeatletter
\\@ifundefined{ver@biblatex.sty}
  {\\@latex@error{Missing 'biblatex' package}{}}
  {}
\\endgroup

\\refsection{0}
  \\datalist[entry]{anyt/global//global/global/global}
    \\entry{FHL21}{article}{}{}
      \\name{author}{3}{}{%
        {{un=0,uniquepart=base,hash=1a}{%
           family={Friz},
           familyi={F\\bibinitperiod},
           given={Peter\\bibnamedelima K.},
           giveni={P\\bibinitperiod\\bibinitdelim K\\bibinitperiod}}}%
        {{un=0,uniquepart=base,hash=2b}{%
           family={Hocquet},
           familyi={H\\bibinitperiod},
           given={Antoine},
           giveni={A\\bibinitperiod}}}%
        {{un=0,uniquepart=base,hash=3c}{%
           family={Lê},
           familyi={L\\bibinitperiod},
           given={Khoa},
           giveni={K\\bibinitperiod}}}%
      }
      \\strng{namehash}{abc}
      \\field{sortinit}{F}
      \\field{labelalpha}{FHL21}
      \\field{extraalpha}{1}
      \\field{journaltitle}{Ann. Probab.}
      \\field{title}{Rough stochastic differential equations}
      \\field{volume}{52}
      \\field{year}{2021}
      \\field{pages}{1\\bibrangedash 30}
      \\range{pages}{30}
      \\verb{doi}
      \\verb 10.1000/xyz
      \\endverb
    \\endentry
    \\entry{Cohen2015}{book}{}{}
      \\name{author}{2}{}{%
        {{hash=4d}{family={Cohen}, familyi={C\\bibinitperiod}, given={Samuel\\bibnamedelima N.}, giveni={S\\bibinitperiod}}}%
        {{hash=5e}{family={Elliott}, familyi={E\\bibinitperiod}, given={Robert\\bibnamedelima J.}, giveni={R\\bibinitperiod}}}%
      }
      \\list{publisher}{1}{%
        {Birkhäuser}%
      }
      \\list{location}{1}{%
        {Basel}%
      }
      \\field{labelalpha}{CE15}
      \\field{title}{Stochastic Calculus and Applications}
      \\field{year}{2015}
    \\endentry
  \\enddatalist
\\endrefsection
\\endinput
`;

test('parseBbl reads biber\'s entries, names, lists, verbatim fields and labels', () => {
  assert.ok(B.isBiblatexBbl(BIBER_BBL));
  const e = B.parseBbl(BIBER_BBL);
  assert.deepEqual(Object.keys(e), ['FHL21', 'Cohen2015']);
  assert.equal(e.FHL21.type, 'article');
  assert.equal(e.FHL21.label, 'FHL21a');
  assert.equal(e.FHL21.fields.author, 'Friz, Peter K. and Hocquet, Antoine and Lê, Khoa');
  assert.equal(e.FHL21.fields.journal, 'Ann. Probab.');
  assert.equal(e.FHL21.fields.pages, '1--30');
  assert.equal(e.FHL21.fields.doi, '10.1000/xyz');
  assert.equal(e.Cohen2015.fields.publisher, 'Birkhäuser');
  assert.equal(e.Cohen2015.fields.address, 'Basel');
  assert.equal(e.Cohen2015.label, 'CE15');
});

test('an arXiv import with a biber .bbl builds the bibliography from it', () => {
  const files = { 'main.tex': BIBLATEX_MAIN.replace('\\cite{FHL21}', '\\textcite{FHL21}'), 'main.bbl': BIBER_BBL };
  const out = A.flatten('main.tex', files);
  assert.doesNotMatch(out, /\\entry\{/, 'the raw .bbl is not pasted in');
  assert.match(out, /\\bibitem\[FHL21a\]\{FHL21\} Peter K\. Friz, Antoine Hocquet, and Khoa Lê, \\emph\{Rough stochastic differential equations\}, Ann\. Probab\. \\textbf\{52\} \(2021\), 1--30\./);
  assert.match(out, /\\bibitem\[CE15\]\{Cohen2015\}.*Birkhäuser, Basel, 2015\./);
  assert.ok(out.indexOf('{FHL21}') < out.indexOf('{Cohen2015}'), 'the .bbl order is kept');
  const html = TeXglass.render(out).html;
  assert.doesNotMatch(html, /cite-key/);
});

test('styleOf reads \\bibliographystyle and biblatex options', () => {
  assert.equal(B.styleOf('\\bibliographystyle{amsalpha}'), 'amsalpha');
  assert.equal(B.styleOf('\\usepackage[backend=biber,style=alphabetic]{biblatex}'), 'alphabetic');
  assert.equal(B.styleOf('\\usepackage[sorting=none]{biblatex}'), 'numeric,sorting=none');
  assert.equal(B.styleOf('\\usepackage{biblatex}'), 'numeric');
  assert.equal(B.styleOf(''), '');
  assert.deepEqual(B.bibResources('\\addbibresource[location=local]{a.bib}\\bibliography{b, c}% \\bibliography{d}'), ['b', 'c', 'a.bib']);
});
