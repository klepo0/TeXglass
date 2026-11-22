'use strict';
// Comparing two versions block by block (src/diff.js), and the arXiv version list (src/arxiv.js).
const test = require('node:test');
const assert = require('node:assert/strict');
global.katex = require('katex');
const TeXglass = require('../src/texglass.js');
const Diff = require('../src/diff.js');
const Arxiv = require('../src/arxiv.js');

const PRE = '\\documentclass{article}\n\\newtheorem{theorem}{Theorem}[section]\n\\newtheorem{lemma}[theorem]{Lemma}\n\\begin{document}\n';
const run = (a, b) => {
  const ra = TeXglass.render(a, { sourceMap: true });
  const rb = TeXglass.render(b, { sourceMap: true });
  const r = Diff.compareRenders(ra.blocks, a, rb.blocks, b);
  return r.items.map((it) => [it.status, it.b != null ? r.news[it.b].text.slice(0, 24) : r.olds[it.a].text.slice(0, 24)]);
};

test('keys: labels, headings, proofs and environments', () => {
  assert.equal(Diff.keyOf('\\begin{lemma}\\label{lem:a} X\\end{lemma}').key, 'L:lem:a');
  assert.equal(Diff.keyOf('\\begin{lemma}\\label[lemma]{lem:a} X\\end{lemma}').key, 'L:lem:a');
  assert.equal(Diff.keyOf('\\begin{theorem}[Main] X\\end{theorem}').key, 'T:theorem:main');
  assert.equal(Diff.keyOf('\\section{The Setting}').key, 'S:section:the setting');
  assert.equal(Diff.keyOf('\\begin{proof}[Proof of \\cref{thm:x}] Y\\end{proof}').key, 'P:L:thm:x');
  assert.equal(Diff.keyOf('\\begin{abstract} Z\\end{abstract}').key, 'E:abstract');
  assert.equal(Diff.keyOf('\\begin{equation}\\label{e} a\\end{equation}').kind, 'equation');
  assert.equal(Diff.keyOf('Some text. % a comment\nmore').key, null);
});

test('changed, added, removed and moved blocks', () => {
  const a = PRE + [
    '\\section{Intro}', 'Some text with $x^2$ here.', '',
    'This paragraph goes away entirely in the next version.', '',
    '\\begin{lemma}\\label{l:a} Let $x>0$. Then $x^2>0$.\\end{lemma}',
    '\\begin{proof} Clear.\\end{proof}',
    '\\begin{theorem}\\label{t:main} The main result holds for all $n$.\\end{theorem}',
    '\\end{document}'].join('\n');
  const b = PRE + [
    '\\section{Intro}', 'Some text with $x^3$ here, and more.', '',
    '\\begin{theorem}\\label{t:main} The main result holds for all $n \\ge 1$.\\end{theorem}',
    '\\begin{lemma}\\label{l:a} Let $x>0$. Then $x^2>0$.\\end{lemma}',
    '\\begin{proof} Clear.\\end{proof}',
    'A brand new paragraph.',
    '\\end{document}'].join('\n');
  assert.deepEqual(run(a, b), [
    ['same', '\\section{Intro}'],
    ['changed', 'Some text with $x^3$ her'],
    ['moved', '\\begin{theorem}\\label{t:'],
    ['removed', 'This paragraph goes away'],
    ['same', '\\begin{lemma}\\label{l:a}'],
    ['same', '\\begin{proof} Clear.\\end'],
    ['added', 'A brand new paragraph.'],
  ]);
});

test('a block that only looks different in its source is the same', () => {
  const a = PRE + '\\begin{lemma}\\label{l:a} Let $x>0$.\\end{lemma}\n\\end{document}';
  const b = PRE + '\\begin{lemma}\\label[lemma]{l:a}\nLet  $x>0$.   % tidied\n\\end{lemma}\n\\end{document}';
  assert.deepEqual(run(a, b).map((x) => x[0]), ['same']);
});

test('Windows line endings: source ranges still fit', () => {
  const a = (PRE + 'One.\n\nTwo.\n\\end{document}').replace(/\n/g, '\r\n');
  const b = PRE + 'One.\n\nTwo!\n\\end{document}';
  assert.deepEqual(run(a, b), [['same', 'One.'], ['changed', 'Two!']]);
});

test('word diff keeps what both share, in order', () => {
  const d = Diff.wordDiff('a b c d'.split(' '), 'a x c d e'.split(' '));
  assert.deepEqual(d.a, [true, false, true, true]);
  assert.deepEqual(d.b, [true, false, true, true, false]);
});

test('arXiv versions from a DataCite record', async () => {
  const json = { data: { attributes: { version: '3', dates: [
    { date: '2021-06-18T20:08:43Z', dateType: 'Submitted', dateInformation: 'v1' },
    { date: '2021-06-22T00:02:32Z', dateType: 'Updated', dateInformation: 'v1' },
    { date: '2022-01-19T12:09:04Z', dateType: 'Submitted', dateInformation: 'v2' },
    { date: '2021-06', dateType: 'Available', dateInformation: 'v1' },
  ] } } };
  assert.deepEqual(Arxiv.versionsFromDataCite(json), [{ v: 1, date: '2021-06-18' }, { v: 2, date: '2022-01-19' }, { v: 3, date: '' }]);
  let asked = null;
  const list = await Arxiv.versions('arxiv.org/abs/2106.10340v2', { fetch: async (u) => { asked = u; return { ok: true, json: async () => json }; } });
  assert.equal(asked, 'https://api.datacite.org/dois/10.48550/arXiv.2106.10340');
  assert.equal(list.length, 3);
  assert.equal(Arxiv.versionOf('2106.10340v2'), 2);
  assert.equal(Arxiv.versionOf('2106.10340'), null);
  assert.equal(Arxiv.baseId('math/0601001v3'), 'math/0601001');
});
