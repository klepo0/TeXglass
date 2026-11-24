'use strict';
// TeXmark (.tmd) files in VS Code: the extension reads them as their compact
// LaTeX conversion (asLatex in extension.js), so the project is assembled as
// usual and every line keeps its number. Run `npm run copy-shared` first.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { assemble, locate } = require('../project.js');
const { convert } = require('../convert.js');
const TeXmark = require('../shared/texmark.js');

const R = path.resolve('/proj');
const P = (n) => path.join(R, n);
const TMD = [
  '---',
  'title: A made-up note',
  'bib: refs.bib',
  '---',
  '',
  '# Setting {#sec:setting}',
  '',
  '::: lemma [Small] {#lem:small}',
  'Every $f$ is **fine**, see [@k].',
  ':::',
  '',
  'By @lem:small we are done.',
].join('\n');

test('a .tmd file assembles from its compact conversion, line for line, with its .bib', () => {
  const files = { [P('note.tmd')]: TMD, [P('refs.bib')]: '@book{k, author={Ann Author}, title={T}, year={2000}}' };
  const read = (p) => (files[p] == null ? null : /\.tmd$/.test(p) ? TeXmark.convert(files[p], { compact: true }).latex : files[p]);
  const pr = assemble(P('note.tmd'), read);
  assert.deepStrictEqual(pr.warnings, []);
  assert.match(pr.text, /Ann Author/);
  const lines = pr.text.split('\n');
  const src = TMD.split('\n');
  // The lemma starts on the same line as in the .tmd file.
  const at = lines.findIndex((l) => l.startsWith('\\begin{lemma}'));
  assert.strictEqual(src[at], '::: lemma [Small] {#lem:small}');
  const loc = locate(pr, pr.text.indexOf('By \\cref'));
  assert.strictEqual(pr.files[loc.file], P('note.tmd'));

  const r = convert({ text: pr.text });
  const html = r.blocks.join('\n');
  assert.match(html, /Lemma 1\.1<\/span>/);
  assert.match(html, /A made-up note/);
});
