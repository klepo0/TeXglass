#!/usr/bin/env node
/* Copy the converter, the BibTeX reader, the HTML export and the stylesheet from the web viewer into the extension,
 * so both stay one source. Runs before packaging (vscode:prepublish). */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'shared');
fs.mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['src/texglass.js', 'texglass.js'],
  ['src/export.js', 'export.js'],
  ['src/tikz.js', 'tikz.js'],
  ['src/diagrams.js', 'diagrams.js'],
  ['styles.css', 'styles.css'],
  ['src/find.js', 'find.js'],
  ['src/zoom.js', 'zoom.js'],
  ['src/scroll.js', 'scroll.js'],
  ['src/popover.js', 'popover.js'],
  ['src/copytex.js', 'copytex.js'],
  ['src/margin.js', 'margin.js'],
  ['src/notes-sync.js', 'notes-sync.js'],
  ['src/insight.js', 'insight.js'],
  ['src/hypotheses.js', 'hypotheses.js'],
  ['src/cite.js', 'cite.js'],
  ['src/cited.js', 'cited.js'],
  ['src/arxiv.js', 'arxiv.js'],
  ['src/bib.js', 'bib.js'],
  ['src/eps.js', 'eps.js'],
  ['src/pdf.js', 'pdf.js'],
]) {
  const src = path.join(root, from);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, to));
}
// pdf.js, for PDF figures; src/pdf.js finds it at ../vendor/pdfjs/ from shared/
const pdfjs = path.join(__dirname, '..', 'vendor', 'pdfjs');
fs.mkdirSync(pdfjs, { recursive: true });
for (const f of ['pdf.min.js', 'pdf.worker.min.js', 'LICENSE']) fs.copyFileSync(path.join(root, 'vendor', 'pdfjs', f), path.join(pdfjs, f));
console.log('Copied the shared files into', path.relative(process.cwd(), out) || '.');
