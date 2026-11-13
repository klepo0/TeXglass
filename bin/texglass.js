#!/usr/bin/env node
/* Convert a .tex file to a standalone HTML page: texglass paper.tex [-o paper.html] [--link-katex] */
'use strict';
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const TeXglassExport = require('../src/export.js');

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log('Usage: texglass <file.tex> [-o out.html] [--link-katex]\n\n' +
    '  --link-katex  load KaTeX\'s stylesheet and fonts from a CDN instead of putting them in the page');
  process.exit(args.length ? 0 : 1);
}
const input = args[0];
const o = args.indexOf('-o');
const output = o >= 0 ? args[o + 1] : input.replace(/\.[^.\/]+$/, '') + '.html';

(async () => {
  const result = TeXglass.render(fs.readFileSync(input, 'utf8'), {
    renderMath: (tex, displayMode, macros) =>
      katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' }),
    // Figures relative to the page, wherever it is written.
    resolveImage: (p) => path.relative(path.dirname(path.resolve(output)), path.resolve(path.dirname(input), p)).split(path.sep).join('/'),
  });
  let katexCss = null;
  if (!args.includes('--link-katex')) {
    const dist = path.dirname(require.resolve('katex/dist/katex.min.css'));
    katexCss = await TeXglassExport.embedKatexFonts(
      fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8'),
      (name) => fs.readFileSync(path.join(dist, 'fonts', name)).toString('base64')
    );
  }
  const html = TeXglassExport.page({
    body: result.html,
    title: result.title || path.basename(input),
    css: fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8'),
    katexCss,
  });
  fs.writeFileSync(output, html);
  for (const w of result.warnings) console.error('warning: ' + w);
  console.log(`Wrote ${output}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
