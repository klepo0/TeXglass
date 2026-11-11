'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withFiles } = require('../vfs.js');
const { imageResolver, figureNames } = require('../images.js');
const { assemble } = require('../project.js');

test('withFiles runs synchronous code over an asynchronous file system', async () => {
  const disk = {
    '/r/main.tex': '\\documentclass{article}\\begin{document}\\input{a}\\cite{k}\\bibliography{refs}\\end{document}',
    '/r/a.tex': 'A \\input{sub/b}',
    '/r/sub/b.tex': 'B',
    '/r/refs.bib': '@book{k, author={Ann Author}, title={T}, year={2000}}',
  };
  const loads = [];
  const cache = new Map();
  const load = async (p) => {
    loads.push(p);
    return disk[p] == null ? null : disk[p];
  };
  const run = () => withFiles((get) => assemble('/r/main.tex', get, path.posix), load, cache);
  const project = await run();
  assert.match(project.text, /A B/);
  assert.match(project.text, /Ann Author/);
  for (const f of ['/r/main.tex', '/r/a.tex', '/r/sub/b.tex']) assert.ok(project.files.includes(f), f);
  const n = loads.length;
  await run();
  assert.strictEqual(loads.length, n, 'the second run is served from the cache');
});

test('images: figure names and a resolver over known files', () => {
  const text = '\\graphicspath{{figs/}}\n\\includegraphics[width=1cm]{plot.pdf}\n% \\includegraphics{hidden}\n\\includegraphics{../up}';
  assert.deepEqual(figureNames(text), ['plot.pdf', '../up']);
  const files = new Set(['figs/plot.png']);
  const find = imageResolver(text, (rel) => files.has(rel), (rel) => 'url:' + rel);
  assert.strictEqual(find('plot.pdf'), 'url:figs/plot.png');
  assert.strictEqual(find('../up'), null);
});
