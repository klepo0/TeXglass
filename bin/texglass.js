#!/usr/bin/env node
/* Convert a .tex file to a standalone HTML page: texglass paper.tex [-o paper.html] */
'use strict';
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log('Usage: texglass <file.tex> [-o out.html]');
  process.exit(args.length ? 0 : 1);
}
const input = args[0];
const o = args.indexOf('-o');
const output = o >= 0 ? args[o + 1] : input.replace(/\.[^.\/]+$/, '') + '.html';

const result = TeXglass.render(fs.readFileSync(input, 'utf8'), {
  renderMath: (tex, displayMode, macros) =>
    katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' }),
  resolveImage: (p) => p,
});
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TeXglass.escapeHtml(result.title || path.basename(input))}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>${css}</style>
</head>
<body>
<main class="panes"><section class="pane"><article id="preview" class="document">
${result.html}
</article></section></main>
</body>
</html>
`;
fs.writeFileSync(output, html);
for (const w of result.warnings) console.error('warning: ' + w);
console.log(`Wrote ${output}`);
