'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const A = require('../src/arxiv.js');

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

test('parseId accepts links, prefixes and old-style ids', () => {
  assert.equal(A.parseId('https://arxiv.org/abs/2301.00001'), '2301.00001');
  assert.equal(A.parseId('https://arxiv.org/pdf/2106.09685v2'), '2106.09685v2');
  assert.equal(A.parseId('https://arxiv.org/pdf/2106.09685v2.pdf'), '2106.09685v2');
  assert.equal(A.parseId('arXiv:1706.03762'), '1706.03762');
  assert.equal(A.parseId('2401.12345'), '2401.12345');
  assert.equal(A.parseId('https://arxiv.org/abs/math/0211159v1'), 'math/0211159v1');
  assert.equal(A.parseId('hep-th/9711200'), 'hep-th/9711200');
  assert.equal(A.parseId('https://arxiv.org/abs/math.AG/0601001'), 'math.AG/0601001');
  assert.equal(A.parseId('https://example.com/hello'), null);
  assert.equal(A.parseId(''), null);
});

test('untar, pickMain and flatten build one document', () => {
  const files = A.untar(new Uint8Array(tar({
    'macros.tex': '\\newcommand{\\R}{\\mathbb{R}}',
    'paper.tex': '\\documentclass{article}\n\\input{macros}\n\\begin{document}\n\\include{sections/intro}\n% \\input{missing}\n\\bibliography{refs}\n\\end{document}',
    'sections/intro.tex': '\\section{Intro}\nSee \\input sections/detail.tex',
    'sections/detail.tex': 'DETAIL',
    'paper.bbl': '\\begin{thebibliography}{1}\\bibitem{a} A.\\end{thebibliography}',
  })));
  assert.deepEqual(Object.keys(files).sort(), ['macros.tex', 'paper.bbl', 'paper.tex', 'sections/detail.tex', 'sections/intro.tex']);
  const text = {};
  for (const [k, v] of Object.entries(files)) text[k] = new TextDecoder().decode(v);
  const tex = Object.fromEntries(Object.entries(text).filter(([k]) => k.endsWith('.tex')));
  assert.equal(A.pickMain(tex), 'paper.tex');
  const out = A.flatten('paper.tex', text);
  assert.match(out, /\\newcommand\{\\R\}/);
  assert.match(out, /\\section\{Intro\}\nSee DETAIL/);
  assert.match(out, /% \\input\{missing\}/);
  assert.match(out, /\\begin\{thebibliography\}/);
  assert.doesNotMatch(out, /\\bibliography\{refs\}/);
});

test('importPaper handles a tarball, a single gzipped file and PDF-only papers', async () => {
  const respond = (body, type) => async () => new Response(body, { status: 200, headers: { 'content-type': type || 'application/gzip' } });
  const tarball = zlib.gzipSync(tar({ 'a.tex': '\\documentclass{article}\\begin{document}\\includegraphics{fig}\\end{document}', 'fig.png': 'PNG' }));
  const p = await A.importPaper('arXiv:2301.00001', { fetch: respond(tarball) });
  assert.equal(p.id, '2301.00001');
  assert.equal(p.main, 'a.tex');
  assert.deepEqual(Object.keys(p.images), ['fig.png']);
  const resolve = A.imageResolver({ 'fig.png': 'blob:fig' }, p.source);
  assert.equal(resolve('fig'), 'blob:fig');
  assert.equal(resolve('./fig.pdf'), 'blob:fig');

  const single = await A.importPaper('math/0211159', { fetch: respond(zlib.gzipSync('\\documentclass{amsart}\\begin{document}Hi\\end{document}')) });
  assert.match(single.source, /Hi/);
  assert.equal(single.name, 'arXiv-math-0211159.tex');

  await assert.rejects(A.importPaper('2301.00002', { fetch: respond('%PDF-1.4', 'application/pdf') }), /only a PDF/);
  await assert.rejects(A.importPaper('nonsense'), /does not look like/);
});

test('imageResolver follows \\graphicspath', () => {
  const r = A.imageResolver({ 'figs/plot.jpg': 'blob:p' }, '\\graphicspath{{figs/}{other/}}');
  assert.equal(r('plot'), 'blob:p');
  assert.equal(r('nothing'), null);
});

test('flatten honours \\includeonly, keeps only a subfile\'s body and reports where files start', () => {
  const files = {
    'm.tex': '\\documentclass{book}\n\\includeonly{b}\n\\begin{document}\n\\include{a}\n\\include{b}\n\\subfile{s}\n\\end{document}',
    'a.tex': 'AAA',
    'b.tex': 'BBB',
    's.tex': '\\documentclass[m]{subfiles}\n\\begin{document}\nSSS\n\\end{document}',
  };
  const starts = {};
  const out = A.flatten('m.tex', files, { starts });
  assert.doesNotMatch(out, /AAA/);
  assert.match(out, /BBB/);
  assert.match(out, /\nSSS\n/);
  assert.doesNotMatch(out, /subfiles|\u0000/);
  assert.equal(out.slice(starts['b.tex'], starts['b.tex'] + 3), 'BBB');
  assert.ok(!('a.tex' in starts));
});
