'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/github.js');

/** A fetch that serves { url: text | object } and 404s everything else. */
function fakeFetch(files) {
  const seen = [];
  const f = async (url) => {
    seen.push(url);
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => body,
      blob: async () => new Blob([body]),
    };
  };
  f.seen = seen;
  return f;
}

const RAW = 'https://raw.githubusercontent.com/o/r';

test('parseUrl reads file, folder, repo and raw links', () => {
  assert.deepEqual(G.parseUrl('https://github.com/o/r/blob/main/paper/main.tex'), { owner: 'o', repo: 'r', kind: 'file', rest: ['main', 'paper', 'main.tex'] });
  assert.deepEqual(G.parseUrl('github.com/o/r'), { owner: 'o', repo: 'r', kind: 'repo', rest: [] });
  assert.deepEqual(G.parseUrl('https://github.com/o/r.git'), { owner: 'o', repo: 'r', kind: 'repo', rest: [] });
  assert.deepEqual(G.parseUrl('https://github.com/o/r/tree/dev/notes?x=1#L3'), { owner: 'o', repo: 'r', kind: 'tree', rest: ['dev', 'notes'] });
  assert.deepEqual(G.parseUrl('https://github.dev/o/r/blob/main/a.tex'), { owner: 'o', repo: 'r', kind: 'file', rest: ['main', 'a.tex'] });
  assert.deepEqual(G.parseUrl('https://raw.githubusercontent.com/o/r/refs/heads/main/a%20b.tex'), { owner: 'o', repo: 'r', kind: 'file', rest: ['main', 'a b.tex'] });
  assert.deepEqual(G.parseUrl('o/r/blob/main/a.tex'), { owner: 'o', repo: 'r', kind: 'file', rest: ['main', 'a.tex'] });
  assert.equal(G.parseUrl('https://example.com/o/r/blob/main/a.tex'), null);
  assert.equal(G.parseUrl('https://github.com/o/r/issues/3'), null);
  assert.equal(G.parseUrl(''), null);
});

test('importFile inlines inputs, the .bbl and figures relative to the main file', async () => {
  const fetch = fakeFetch({
    [`${RAW}/main/paper/main.tex`]: '\\documentclass{article}\n\\graphicspath{{fig/}}\n\\begin{document}\n\\input{sec/intro}\n% \\input{skipped}\n\\includegraphics[width=3cm]{plot.pdf}\n\\bibliography{refs}\n\\end{document}\n',
    [`${RAW}/main/paper/sec/intro.tex`]: '\\section{Intro}\\include{sec/more}',
    [`${RAW}/main/paper/sec/more.tex`]: 'More text.',
    [`${RAW}/main/paper/main.bbl`]: '\\begin{thebibliography}{1}\\bibitem{a} A.\\end{thebibliography}',
    [`${RAW}/main/paper/fig/plot.png`]: 'PNG',
  });
  const r = await G.importFile('https://github.com/o/r/blob/main/paper/main.tex', { fetch });
  assert.equal(r.name, 'main.tex');
  assert.equal(r.ref, 'main');
  assert.equal(r.path, 'paper/main.tex');
  assert.match(r.source, /\\section\{Intro\}\nMore text\.\n/);
  assert.match(r.source, /\\begin\{thebibliography\}/);
  assert.doesNotMatch(r.source, /\\bibliography\{refs\}/);
  assert.ok(!fetch.seen.some((u) => /skipped/.test(u)), 'commented-out inputs are not fetched');
  assert.deepEqual(Object.keys(r.images), ['fig/plot.png']);
  assert.equal(r.images['fig/plot.png'].type, 'image/png');
  assert.equal(r.links.edit, 'https://github.com/o/r/edit/main/paper/main.tex');
  assert.equal(r.links.dev, 'https://github.dev/o/r/blob/main/paper/main.tex');
});

test('importFile opens a file on a branch name with slashes', async () => {
  const fetch = fakeFetch({ [`${RAW}/feature/x/a.tex`]: 'Hello' });
  const r = await G.importFile('https://github.com/o/r/blob/feature/x/a.tex', { fetch });
  assert.equal(r.source, 'Hello');
  assert.equal(r.links.edit, 'https://github.com/o/r/edit/feature/x/a.tex');
});

test('importFile picks the main file of a repo', async () => {
  const API = 'https://api.github.com/repos/o/r';
  const fetch = fakeFetch({
    [API]: { default_branch: 'trunk' },
    [`${API}/git/trees/trunk?recursive=1`]: { tree: [
      { type: 'blob', path: 'README.md' },
      { type: 'blob', path: 'chapters/one.tex' },
      { type: 'blob', path: 'thesis.tex' },
    ] },
    [`${RAW}/trunk/chapters/one.tex`]: 'Chapter one.',
    [`${RAW}/trunk/thesis.tex`]: '\\documentclass{book}\\begin{document}\\include{chapters/one}\\end{document}',
  });
  const r = await G.importFile('https://github.com/o/r', { fetch });
  assert.equal(r.path, 'thesis.tex');
  assert.match(r.source, /Chapter one\./);
});

test('importFile explains a missing or private file', async () => {
  await assert.rejects(G.importFile('https://github.com/o/r/blob/main/a.tex', { fetch: fakeFetch({}) }), /private/);
  await assert.rejects(G.importFile('https://example.com/x', { fetch: fakeFetch({}) }), /GitHub/);
});

test('bookmarklet opens the viewer with the current page', () => {
  const b = G.bookmarklet('https://klepo0.github.io/TeXdown/?arxiv=1#x');
  assert.match(b, /^javascript:/);
  assert.ok(b.includes('"https://klepo0.github.io/TeXdown/?gh="'));
});
