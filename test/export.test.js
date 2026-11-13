'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const TeXglass = require('../src/texglass.js');
const TeXglassExport = require('../src/export.js');

test('joinBlocks drops the source ranges and keeps the HTML', () => {
  const { html, blocks } = TeXglass.render('\\section{A}\nHello $x$.\n\n\\begin{theorem}T\\end{theorem}', { sourceMap: true, renderMath: (t) => t });
  const joined = TeXglassExport.joinBlocks(blocks);
  assert.ok(!joined.includes('src-block'));
  assert.ok(joined.includes('Hello'));
  assert.ok(/Theorem/.test(joined));
  assert.ok(html.includes('src-block'));
});

test('embedKatexFonts inlines the woff2 fonts and drops the fallbacks', async () => {
  const css = '@font-face{font-family:A;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff"),url(fonts/KaTeX_Main-Regular.ttf) format("truetype")}.x{color:red}';
  const out = await TeXglassExport.embedKatexFonts(css, (n) => (n === 'KaTeX_Main-Regular.woff2' ? 'QUJD' : null));
  assert.equal(out, '@font-face{font-family:A;src:url(data:font/woff2;base64,QUJD) format("woff2")}.x{color:red}');
  assert.equal(await TeXglassExport.embedKatexFonts(css, () => null), null);
});

test('replaceImages swaps only the URLs asked for', async () => {
  const html = '<img src="blob:a" alt="x"><img class="c" src="fig.png"><img src="blob:b">';
  const out = await TeXglassExport.replaceImages(html, (u) => u.startsWith('blob:'), async (u) => (u === 'blob:a' ? 'data:A' : Promise.reject(new Error('gone'))));
  assert.equal(out, '<img src="data:A" alt="x"><img class="c" src="fig.png"><img src="blob:b">');
});

test('page is a whole document with the title escaped and KaTeX inside or linked', () => {
  const inside = TeXglassExport.page({ body: '<p>Hi</p>', title: 'A <b> & C', css: 'p{}', katexCss: '.katex{}' });
  assert.ok(inside.startsWith('<!doctype html>'));
  assert.ok(inside.includes('<title>A &lt;b&gt; &amp; C</title>'));
  assert.ok(inside.includes('<style>.katex{}</style>'));
  assert.ok(!inside.includes('cdn.jsdelivr'));
  assert.ok(inside.includes('<article id="preview" class="document">\n<p>Hi</p>'));
  const linked = TeXglassExport.page({ body: '', title: 't', css: '' });
  assert.ok(linked.includes(TeXglassExport.KATEX_CDN + 'katex.min.css'));
  assert.ok(TeXglassExport.page({ body: '', theme: 'dark' }).includes('<html lang="en" data-theme="dark">'));
});

test('fileName follows the source, else the title', () => {
  assert.equal(TeXglassExport.fileName('dir/paper.tex'), 'paper.html');
  assert.equal(TeXglassExport.fileName('C:\\x\\notes.ltx'), 'notes.html');
  assert.equal(TeXglassExport.fileName('', 'On the Riemann: zeta!'), 'On-the-Riemann-zeta.html');
  assert.equal(TeXglassExport.fileName('', ''), 'document.html');
});

test('the CLI writes a standalone page with fonts inside and figures relative to it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texglass-export-'));
  fs.mkdirSync(path.join(dir, 'src', 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'img', 'f.png'), '');
  fs.writeFileSync(path.join(dir, 'src', 'a.tex'), '\\title{T}\\begin{document}\\maketitle\n\\begin{theorem}\\label{t}$x^2$\\end{theorem}\nSee \\ref{t}.\n\\includegraphics{img/f.png}\n\\end{document}\n');
  const out = path.join(dir, 'out', 'a.html');
  fs.mkdirSync(path.dirname(out));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'texglass.js'), path.join(dir, 'src', 'a.tex'), '-o', out]);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('data:font/woff2;base64,'));
  assert.ok(html.includes('class="katex"'));
  assert.ok(html.includes('src="../src/img/f.png"'));
  assert.ok(/Theorem[^<]*<\/span>|Theorem 1/.test(html));
  assert.ok(!html.slice(html.indexOf('<body>')).includes('class="src-block"'));
});

test('a page made for printing opens the print dialog once loaded; others do not', () => {
  const printed = TeXglassExport.page({ body: '<p>Hi</p>', title: 't', css: '', print: true });
  assert.ok(printed.includes('window.print()'));
  assert.ok(printed.includes('document.fonts.ready'));
  assert.ok(!TeXglassExport.page({ body: '<p>Hi</p>', title: 't', css: '' }).includes('window.print()'));
});

test('the stylesheet prints like a paper', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const print = css.slice(css.lastIndexOf('@media print'));
  assert.ok(/@page\s*\{[^}]*margin/.test(css));
  for (const ui of ['.toolbar', '.toc-pane', '.ref-popover', '.find-bar', '.fold-toggle', '.theme-toggle']) assert.ok(print.includes(ui), ui);
  assert.ok(/--bg: #fff !important/.test(print), 'light colours forced');
  assert.ok(/\.fold-hidden \{ display: revert !important; \}/.test(print), 'sections unfolded');
  assert.ok(/break-inside: avoid/.test(print));
});

test('\\url and \\href links are marked, so print shows the address of an \\href', () => {
  const { html } = TeXglass.render('\\url{https://a.org} and \\href{https://b.org}{B}', { renderMath: (t) => t });
  assert.ok(html.includes('<a class="url" href="https://a.org">'));
  assert.ok(html.includes('<a class="href" href="https://b.org">B</a>'));
});
