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
  const b = G.bookmarklet('https://texglass.js.org/?arxiv=1#x');
  assert.match(b, /^javascript:/);
  assert.ok(b.includes('"https://texglass.js.org/?gh="'));
});

test('importFile opens a chapter as part of the document that includes it', async () => {
  const API = 'https://api.github.com/repos/o/r';
  const fetch = fakeFetch({
    [`${API}/git/trees/main?recursive=1`]: { tree: [
      { type: 'blob', path: 'thesis/thesis.tex' },
      { type: 'blob', path: 'thesis/other.tex' },
      { type: 'blob', path: 'thesis/parts/one.tex' },
      { type: 'blob', path: 'thesis/parts/ch/intro.tex' },
    ] },
    [`${RAW}/main/thesis/thesis.tex`]: '\\documentclass{book}\n\\begin{document}\nFront.\n\\include{parts/one}\n\\end{document}\n',
    [`${RAW}/main/thesis/other.tex`]: '\\documentclass{article}\\begin{document}Other.\\end{document}',
    [`${RAW}/main/thesis/parts/one.tex`]: 'Part one.\n\\input{parts/ch/intro}\n',
    [`${RAW}/main/thesis/parts/ch/intro.tex`]: '\\chapter{Intro}\nHello.',
  });
  const r = await G.importFile('https://github.com/o/r/blob/main/thesis/parts/ch/intro.tex', { fetch });
  assert.equal(r.path, 'thesis/thesis.tex');
  assert.equal(r.opened, 'thesis/parts/ch/intro.tex');
  assert.match(r.source, /Front\.\n\nPart one\.\n\\chapter\{Intro\}\nHello\./);
  assert.equal(r.source.slice(r.start, r.start + 15), '\\chapter{Intro}');
  assert.equal(r.links.edit, 'https://github.com/o/r/edit/main/thesis/parts/ch/intro.tex');
  assert.deepEqual(r.files.sort(), ['thesis/parts/ch/intro.tex', 'thesis/parts/one.tex', 'thesis/thesis.tex']);
});

test('importFile follows % !TEX root and subfiles, and guesses the main file when listing is refused', async () => {
  const fetch = fakeFetch({
    [`${RAW}/main/doc/main.tex`]: '\\documentclass{article}\n\\includeonly{a}\n\\begin{document}\n\\include{a}\n\\include{b}\n\\subfile{s/c}\n\\end{document}\n',
    [`${RAW}/main/doc/a.tex`]: '% !TEX root = main.tex\nAAA',
    [`${RAW}/main/doc/b.tex`]: 'BBB',
    [`${RAW}/main/doc/s/c.tex`]: '\\documentclass[../main]{subfiles}\n\\begin{document}\nCCC\n\\end{document}\n',
  });
  const viaMagic = await G.importFile('https://github.com/o/r/blob/main/doc/a.tex', { fetch });
  assert.equal(viaMagic.path, 'doc/main.tex');
  assert.match(viaMagic.source, /AAA/);
  assert.doesNotMatch(viaMagic.source, /BBB/, '\\includeonly leaves b out');
  assert.match(viaMagic.source, /\nCCC\n/);
  assert.doesNotMatch(viaMagic.source, /subfiles/);
  const viaSubfile = await G.importFile('https://github.com/o/r/blob/main/doc/s/c.tex', { fetch });
  assert.equal(viaSubfile.path, 'doc/main.tex');
  assert.equal(viaSubfile.source.slice(viaSubfile.start).trim().slice(0, 3), 'CCC');
  // b.tex has no root line; the tree API 404s here, so the usual names are tried.
  const viaGuess = await G.importFile('https://github.com/o/r/blob/main/doc/b.tex', { fetch });
  assert.equal(viaGuess.path, 'doc/main.tex');
  // A file that is a whole document stays on its own.
  const own = await G.importFile('https://github.com/o/r/blob/main/doc/main.tex', { fetch });
  assert.equal(own.path, 'doc/main.tex');
  assert.equal(own.start, null);
});

test('search asks GitHub for LaTeX repositories, then any repository if none match', async () => {
  const asked = [];
  const answer = (items, total) => ({ ok: true, status: 200, json: async () => ({ total_count: total, items }) });
  const repo = { name: 'notes', full_name: 'ada/notes', owner: { login: 'ada' }, description: 'Notes', stargazers_count: 3, pushed_at: '2026-01-02T00:00:00Z', html_url: 'https://github.com/ada/notes' };
  const fetch = async (url) => {
    const q = new URL(url).searchParams.get('q');
    asked.push(q);
    return /language:TeX/.test(q) ? answer([], 0) : answer([repo], 1);
  };
  const res = await G.search('rough paths', { fetch });
  assert.deepEqual(asked, ['rough paths language:TeX', 'rough paths']);
  assert.equal(res.anyLanguage, true);
  assert.equal(res.more, false);
  assert.deepEqual(res.results[0], { owner: 'ada', repo: 'notes', name: 'ada/notes', description: 'Notes', stars: 3, updated: '2026-01-02T00:00:00Z', url: 'https://github.com/ada/notes' });

  await assert.rejects(G.search('x', { fetch: async () => ({ ok: false, status: 403 }) }), /few searches a minute/);
  assert.deepEqual((await G.search('  ', { fetch })).results, []);
});
