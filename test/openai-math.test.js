'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/openai-math.js');

const RAW = 'https://raw.githubusercontent.com/openai/math/main';
const API = 'https://api.github.com/repos/openai/math';

/** A fetch that serves { url: text | object } and 404s everything else. */
function fakeFetch(files) {
  const seen = [];
  const f = async (url) => {
    seen.push(url);
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404 };
    if (typeof body === 'number') return { ok: false, status: body };
    return { ok: true, status: 200, text: async () => body, json: async () => body, blob: async () => new Blob([body]) };
  };
  f.seen = seen;
  return f;
}

const CONTENTS = `# Mathematics manuscript collection

<table>
<tbody><tr>
<td>

**001. Milne’s rationality conjecture.** Proves it over $\`\\overline{\\mathbb Q}\`$ for every <i>p</i>.

</td>
</tr></tbody>
<tbody><tr>
<td>

&emsp;[Milne's rationality conjecture for abelian varieties](preprints/Milne-October-7-2026/paper.pdf)

We prove Milne's rationality conjecture
for abelian varieties.

</td>
</tr></tbody>
<tbody><tr>
<td>

**002. Fillings.** Sharp fillings.

</td>
</tr></tbody>
<tbody><tr>
<td>

&emsp;[Sharp integral fillings in CAT(0) spaces](preprints/Sharp-integral-fillings-in-CAT(0)-spaces-September-23-2026/main.pdf)

Abstract two.

</td>
</tr></tbody>
<tbody><tr>
<td>

&emsp;[Matrix multiplication](preprints/Matrix-September-24-2026/Matrix-September-24-2026.pdf) — secondary writeup

Abstract three.

</td>
</tr></tbody>
</table>
`;

const OVERVIEW = `\\cataloguesection{Number theory}{1}
\\resultentry{001}{Milne}{…}{…}
\\cataloguesection{Topology}{2}
\\resultentry{002}{Fillings}{…}{…}`;

test('parseContents reads families, manuscripts, folders with parentheses and notes', () => {
  const fams = O.parseContents(CONTENTS);
  assert.equal(fams.length, 2);
  assert.equal(fams[0].number, '001');
  assert.equal(fams[0].title, 'Milne’s rationality conjecture');
  assert.match(fams[0].description, /^Proves it over \$`\\overline/);
  assert.deepEqual(fams[0].manuscripts, [{
    title: "Milne's rationality conjecture for abelian varieties",
    folder: 'Milne-October-7-2026',
    pdf: 'paper.pdf',
    abstract: "We prove Milne's rationality conjecture for abelian varieties.",
  }]);
  assert.equal(fams[1].manuscripts.length, 2);
  assert.equal(fams[1].manuscripts[0].folder, 'Sharp-integral-fillings-in-CAT(0)-spaces-September-23-2026');
  assert.equal(fams[1].manuscripts[1].note, 'secondary writeup');
  assert.equal(fams[1].manuscripts[1].abstract, 'Abstract three.');
});

test('loadCatalogue adds disciplines from overview.tex, and copes without it', async () => {
  const cat = await O.loadCatalogue({ fetch: fakeFetch({ [`${RAW}/CONTENTS.md`]: CONTENTS, [`${RAW}/overview.tex`]: OVERVIEW }) });
  assert.deepEqual(cat.disciplines, ['Number theory', 'Topology']);
  assert.equal(cat.families[1].discipline, 'Topology');
  const bare = await O.loadCatalogue({ fetch: fakeFetch({ [`${RAW}/CONTENTS.md`]: CONTENTS }) });
  assert.deepEqual(bare.disciplines, []);
  await assert.rejects(O.loadCatalogue({ fetch: fakeFetch({}) }), /catalogue/);
});

test('openManuscript finds build/<name>.tex without the API and pulls in its inputs', async () => {
  const dir = `${RAW}/preprints/Milne-October-7-2026/build`;
  const f = fakeFetch({
    [`${dir}/paper.tex`]: '\\input{preamble}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n',
    [`${dir}/preamble.tex`]: '\\documentclass{amsart}\n',
    [`${dir}/sections/intro.tex`]: '\\section{Intro} $x^2$\n',
  });
  const m = { title: 'Milne', folder: 'Milne-October-7-2026', pdf: 'paper.pdf' };
  const file = await O.openManuscript(m, { fetch: f });
  assert.equal(file.path, 'preprints/Milne-October-7-2026/build/paper.tex');
  assert.match(file.source, /\\documentclass\{amsart\}/);
  assert.match(file.source, /\\section\{Intro\}/);
  assert.equal(file.paperLinks.pdf, 'https://github.com/openai/math/blob/main/preprints/Milne-October-7-2026/paper.pdf');
  assert.ok(!f.seen.some((u) => u.startsWith('https://api.github.com')), 'no API call');
});

test('openManuscript lists the folder with the API when the usual names miss', async () => {
  const folder = 'Odd-(name)-2026';
  const f = fakeFetch({
    [`${API}/git/trees/${encodeURIComponent('main:preprints/' + folder)}?recursive=1`]: { tree: [
      { type: 'blob', path: 'build/critical.tex' },
      { type: 'blob', path: 'build/verification/check.tex' },
      { type: 'blob', path: 'README.md' },
    ] },
    [`${RAW}/preprints/${encodeURIComponent(folder)}/build/critical.tex`]: '\\documentclass{article}\\begin{document}Hi\\end{document}',
  });
  const file = await O.openManuscript({ title: 'Odd', folder, pdf: 'other.pdf' }, { fetch: f });
  assert.equal(file.path, `preprints/${folder}/build/critical.tex`);
  assert.ok(!f.seen.some((u) => u.includes('verification')));
});

test('openManuscript explains a rate limit', async () => {
  const folder = 'X-2026';
  const f = fakeFetch({ [`${API}/git/trees/${encodeURIComponent('main:preprints/' + folder)}?recursive=1`]: 403 });
  await assert.rejects(O.openManuscript({ title: 'X', folder, pdf: 'x.pdf' }, { fetch: f }), /limits how often/);
});
