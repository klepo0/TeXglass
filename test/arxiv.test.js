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

// --- search -------------------------------------------------------------------

const openAlexPage = {
  meta: { count: 2 },
  results: [
    {
      id: 'https://openalex.org/W1',
      display_name: 'Rough paths and $\\alpha$-signatures',
      publication_year: 2023,
      authorships: [{ author: { display_name: 'Ada Lovelace' } }, { author: { display_name: 'Alan Turing' } }],
      abstract_inverted_index: { We: [0], study: [1], paths: [3], rough: [2] },
      locations: [{ landing_page_url: 'https://doi.org/10.1/x' }, { landing_page_url: 'https://arxiv.org/abs/2301.00001v2', pdf_url: 'https://arxiv.org/pdf/2301.00001v2' }],
      ids: { doi: 'https://doi.org/10.1/x' },
    },
    {
      id: 'https://openalex.org/W2',
      display_name: 'An old one',
      publication_year: 2002,
      authorships: [],
      locations: [],
      ids: { doi: 'https://doi.org/10.48550/arXiv.math/0211159' },
    },
    { id: 'https://openalex.org/W3', display_name: 'No arXiv link', locations: [{ landing_page_url: 'https://example.com' }] },
  ],
};

function fakeFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const [prefix, answer] of routes) {
      if (url.startsWith(prefix)) {
        if (answer instanceof Error) throw answer;
        return { ok: answer.status ? answer.status < 400 : true, status: answer.status || 200, json: async () => answer.body };
      }
    }
    throw new TypeError('Failed to fetch');
  };
  f.calls = calls;
  return f;
}

test('abstractFromIndex rebuilds the text in order', () => {
  assert.equal(A.abstractFromIndex({ b: [1], a: [0, 2] }), 'a b a');
  assert.equal(A.abstractFromIndex(null), '');
});

test('search asks DataCite first for arXiv DOIs', async () => {
  const f = fakeFetch([['https://api.datacite.org/', { body: { meta: { total: 30 }, data: [
    { id: '10.48550/arxiv.2301.00001', attributes: {
      doi: '10.48550/arxiv.2301.00001',
      identifiers: [{ identifier: '2301.00001', identifierType: 'arXiv' }],
      titles: [{ title: 'Rough paths' }],
      creators: [{ name: 'Lyons, Terry', givenName: 'Terry', familyName: 'Lyons' }, { name: 'Gubinelli, Massimiliano' }, { name: ':' }, { name: 'NVIDIA' }],
      publicationYear: 2023,
      descriptions: [{ description: 'Other', descriptionType: 'Other' }, { description: 'We  study\n paths.', descriptionType: 'Abstract' }],
    } },
    { id: '10.48550/arxiv.math/0211159', attributes: { doi: '10.48550/arxiv.math/0211159', titles: [{ title: 'Old' }] } },
    { id: '10.1/other', attributes: { doi: '10.1/other', titles: [{ title: 'Not arXiv' }] } },
  ] } }]]);
  const res = await A.search('rough paths', { fetch: f });
  assert.equal(res.source, 'datacite');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /client-id=arxiv\.content/);
  assert.match(f.calls[0], /sort=relevance/);
  assert.deepEqual(res.results.map((r) => r.id), ['2301.00001', 'math/0211159']);
  assert.deepEqual(res.results[0].authors, ['Terry Lyons', 'Massimiliano Gubinelli', 'NVIDIA']);
  assert.equal(res.results[0].abstract, 'We study paths.');
  assert.equal(res.results[0].year, 2023);
  assert.equal(res.more, false);
});

test('search falls back to OpenAlex when DataCite fails, and keeps papers with an arXiv id', async () => {
  const f = fakeFetch([['https://api.datacite.org/', { status: 503, body: {} }], ['https://api.openalex.org/', { body: openAlexPage }]]);
  const res = await A.search('rough paths', { fetch: f });
  assert.equal(res.source, 'openalex');
  assert.equal(res.total, 2);
  assert.equal(res.more, false);
  assert.deepEqual(res.results.map((r) => r.id), ['2301.00001', 'math/0211159']);
  assert.equal(res.results[0].abstract, 'We study rough paths');
  assert.deepEqual(res.results[0].authors, ['Ada Lovelace', 'Alan Turing']);
  assert.equal(res.results[0].year, 2023);
  assert.match(f.calls[1], /search=rough%20paths/);
  assert.match(f.calls[1], /filter=locations\.source\.id:S4306400194/);
  assert.match(f.calls[1], /page=1/);
});

test('search falls back to Semantic Scholar when OpenAlex refuses', async () => {
  const f = fakeFetch([
    ['https://api.openalex.org/', { status: 429, body: {} }],
    ['https://api.semanticscholar.org/', { body: { total: 60, data: [
      { title: 'With arXiv', year: 2020, authors: [{ name: 'E. Noether' }], abstract: 'Hi', externalIds: { ArXiv: '2001.01234' } },
      { title: 'Without', externalIds: { DOI: '10.1/y' } },
    ] } }],
  ]);
  const res = await A.search('noether', { fetch: f, page: 2 });
  assert.equal(res.source, 'semanticscholar');
  assert.deepEqual(res.results.map((r) => r.id), ['2001.01234']);
  assert.match(f.calls[2], /offset=25/);
});

test('a source that finds nothing passes to the next, and an empty answer is kept if all are empty', async () => {
  const empty = fakeFetch([['https://api.datacite.org/', { body: { meta: { total: 0 }, data: [] } }], ['https://api.openalex.org/', { body: openAlexPage }]]);
  assert.equal((await A.search('x', { fetch: empty })).source, 'openalex');
  const none = fakeFetch([['https://api.datacite.org/', { body: { meta: { total: 0 }, data: [] } }]]);
  const res = await A.search('x', { fetch: none });
  assert.equal(res.source, 'datacite');
  assert.deepEqual(res.results, []);
});

test('search reports the last error when every source fails, and skips empty queries', async () => {
  await assert.rejects(A.search('x', { fetch: fakeFetch([]) }), /Failed to fetch/);
  const f = fakeFetch([]);
  assert.deepEqual((await A.search('   ', { fetch: f })).results, []);
  assert.equal(f.calls.length, 0);
});

test('search says there is more when a full page came back', async () => {
  const results = Array.from({ length: 25 }, (_, i) => ({
    display_name: 'P' + i, locations: [{ landing_page_url: `https://arxiv.org/abs/2301.${String(10000 + i)}` }],
  }));
  const res = await A.search('p', { source: 'openalex', fetch: fakeFetch([['https://api.openalex.org/', { body: { meta: { count: 80 }, results } }]]) });
  assert.equal(res.results.length, 25);
  assert.equal(res.more, true);
});

test('flatten puts the authors\' own .sty files where they are loaded, but not packages TeXglass knows', () => {
  const files = {
    'p.tex': '\\documentclass{article}\n\\usepackage{amsmath,mymacros}\n\\usepackage{mhequ}\n\\begin{document}x\\end{document}',
    'mymacros.sty': '\\ProvidesPackage{mymacros}\n\\newcommand{\\R}{\\mathbb{R}} % reals',
    'mhequ.sty': '\\def\\tag{oops}',
  };
  const out = A.flatten('p.tex', files);
  assert.match(out, /\\usepackage\{amsmath\}\n\\makeatletter\n\\ProvidesPackage\{mymacros\}\n\\newcommand\{\\R\}\{\\mathbb\{R\}\}/);
  assert.match(out, /\\usepackage\{mhequ\}/);
  assert.doesNotMatch(out, /oops/);
});

test('flatten leaves out an author\'s own copy of a standard package', () => {
  const files = {
    'p.tex': '\\documentclass{article}\n\\usepackage{footmisc,enumitem}\n\\begin{document}x\\end{document}',
    'footmisc.sty': '\\def\\footnoterule{low-level}',
    'enumitem.sty': '\\def\\enit@x{low-level}',
  };
  const out = A.flatten('p.tex', files);
  assert.doesNotMatch(out, /low-level/);
  assert.match(out, /\\usepackage\{footmisc,enumitem\}/);
});

test('an amsrefs .bbl (no .bib in the source) takes the place of \\bibliography', () => {
  const files = {
    'p.tex': '\\documentclass{amsart}\n\\usepackage[alphabetic]{amsrefs}\n\\begin{document}\nSee \\cite{w}.\n\\bibliography{refs}\n\\end{document}',
    'p.bbl': '% \\bib, bibdiv, biblist are defined by the amsrefs package.\n\\begin{bibdiv}\n\\begin{biblist}\n\\bib{w}{article}{\n  author={Writer, Ada},\n  title={{On imaginary paths}},\n  date={2020},\n}\n\\end{biblist}\n\\end{bibdiv}\n',
  };
  const out = A.flatten('p.tex', files);
  assert.match(out, /\\begin\{bibdiv\}[\s\S]*On imaginary paths[\s\S]*\\end\{bibdiv\}\s*\\end\{document\}/);
  assert.doesNotMatch(out, /\\bibliography\{refs\}/);
  const html = require('../src/texglass.js').render(out, { renderMath: (t) => t }).html;
  assert.match(html, /class="bibliography"/);
  assert.match(html, /<a href="#bib-[^"]+">Wri20<\/a>/);
});
