#!/usr/bin/env node
/* Convert a .tex file to a standalone HTML page or an EPUB e-book:
 * texglass paper.tex [-o paper.html] [--reader] [--link-katex] [--epub]
 * texglass --sty  (copies texglass.sty, the optional LaTeX package, here)
 * texglass --ai-prompt  (prints the prompt that asks an AI chatbot for texglass.sty hints) */
'use strict';
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const TeXglassExport = require('../src/export.js');
const TeXglassEpub = require('../src/epub.js');

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log('Usage: texglass <file.tex> [-o out.html] [--reader] [--link-katex] [--epub]\n' +
    '       texglass --sty\n' +
    '       texglass --ai-prompt\n\n' +
    '  --reader      add the reading tools: reference previews, notation on hover, the side panel\n' +
    '                (contents, map, notation index), Navigate (Ctrl+F, Ctrl+G) and Back\n' +
    '  --link-katex  load KaTeX\'s stylesheet and fonts from a CDN instead of putting them in the page\n' +
    '  --epub        write an EPUB e-book (out.epub) instead, with the maths as MathML, for e-readers\n' +
    '  --sty         copy texglass.sty into this folder: optional hints for TeXglass that LaTeX ignores\n' +
    '  --ai-prompt   print a prompt to give an AI chatbot with your .tex file; it suggests texglass.sty hints');
  process.exit(args.length ? 0 : 1);
}
if (args[0] === '--sty') {
  // texglass.sty (latex/texglass.sty), for authors; docs/GUIDE.md "Hints for TeXglass in your own papers"
  const to = path.resolve('texglass.sty');
  if (fs.existsSync(to)) {
    console.error('texglass.sty is already here; remove it first to replace it.');
    process.exit(1);
  }
  fs.copyFileSync(path.join(__dirname, '..', 'latex', 'texglass.sty'), to);
  console.log(`Wrote ${to}`);
  process.exit(0);
}
if (args[0] === '--ai-prompt') {
  // latex/AI-PROMPT.md, the part between its ai-prompt markers
  const md = fs.readFileSync(path.join(__dirname, '..', 'latex', 'AI-PROMPT.md'), 'utf8');
  process.stdout.write(/<!-- ai-prompt:start -->\s*````text\n([\s\S]*?)\n````/.exec(md)[1] + '\n');
  process.exit(0);
}
const input = args[0];
const o = args.indexOf('-o');
const epub = args.includes('--epub');
const output = o >= 0 ? args[o + 1] : input.replace(/\.[^.\/]+$/, '') + (epub ? '.epub' : '.html');

(async () => {
  if (epub) return writeEpub();
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
    // draws tikzcd arrows, TikZ pictures and tree symbols once the page is open
    diagramsJs: fs.readFileSync(path.join(__dirname, '..', 'src', 'diagrams.js'), 'utf8'),
    reader: args.includes('--reader')
      ? {
        // KaTeX comes from its npm package; the rest from this one.
        scripts: TeXglassExport.READER_SCRIPTS.map((f) => fs.readFileSync(
          f.startsWith('vendor/katex/') ? require.resolve('katex/dist/' + path.basename(f)) : path.join(__dirname, '..', f), 'utf8')),
        data: { defs: result.defs, toc: result.toc },
      }
      : null,
  });
  fs.writeFileSync(output, html);
  for (const w of result.warnings) console.error('warning: ' + w);
  console.log(`Wrote ${output}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

/** --epub: the document as an EPUB 3 book (src/epub.js), figures and KaTeX's fonts inside it. */
async function writeEpub() {
  const dir = path.dirname(path.resolve(input));
  // A figure named without its extension, as LaTeX allows: the first file that is there.
  const findFigure = (p) => {
    for (const ext of ['', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.eps']) {
      const f = path.resolve(dir, p + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch (e) { /* next */ }
    }
    return null;
  };
  const result = TeXglass.render(fs.readFileSync(input, 'utf8'), {
    renderMath: (tex, displayMode, macros) =>
      katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' }),
    resolveImage: (p) => {
      const f = findFigure(p);
      return f ? path.relative(dir, f).split(path.sep).join('/') : null;
    },
  });
  const dist = path.dirname(require.resolve('katex/dist/katex.min.css'));
  const { bytes, warnings } = await TeXglassEpub.build({
    body: result.html,
    title: result.title || path.basename(input),
    toc: result.toc,
    katexCss: fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8'),
    readFont: (name) => new Uint8Array(fs.readFileSync(path.join(dist, 'fonts', name))),
    readImage: (src) => ({ data: new Uint8Array(fs.readFileSync(path.resolve(dir, decodeURIComponent(src)))) }),
    // The book draws its diagrams in e-readers that run scripts (Apple Books, Thorium, Calibre).
    diagramsJs: fs.readFileSync(path.join(__dirname, '..', 'src', 'diagrams.js'), 'utf8'),
  });
  fs.writeFileSync(output, bytes);
  for (const w of result.warnings.concat(warnings)) console.error('warning: ' + w);
  if (/class="tg-diagram/.test(result.html)) {
    console.error('note: diagrams are drawn by a script, which Apple Books, Thorium and Calibre run; for diagrams that show in every e-reader, export from the web viewer (… → Export as EPUB).');
  }
  console.log(`Wrote ${output}`);
}
