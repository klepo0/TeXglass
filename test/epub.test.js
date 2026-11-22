'use strict';
// EPUB export (src/epub.js): the book's files, MathML, chapters and links
// between them, figures, and diagrams drawn in a real browser (the web
// viewer's way), checked as XML by the browser's own parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const TeXglassEpub = require('../src/epub.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const KATEX = path.dirname(require.resolve('katex/dist/katex.min.css'));
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });
// a 1×1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c489' + '0000000d49444154789c63f8cfc0f01f0005000201' + 'a5d6b3a0' + '0000000049454e44ae426082', 'hex');

/** The files of a ZIP: { name: Buffer }, in order, with how each was stored. */
function unzip(buf) {
  buf = Buffer.from(buf);
  const files = [];
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
    const raw = buf.slice(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    files.push({ name, method, crc, data, extra });
    p += 30 + nameLen + extra + size;
  }
  assert.equal(buf.readUInt32LE(p), 0x02014b50, 'the central directory follows the files');
  return files;
}

const SRC = String.raw`\documentclass{article}
\newcommand{\R}{\mathbb{R}}
\newtheorem{theorem}{Theorem}[section]
\title{A Test \& Book}
\author{Ada Lovelace \and Emmy Noether}
\begin{document}
\maketitle
\section{One}\label{s:one}
Let $f\colon \R \to \mathcal{C}$.\footnote{A note.}
\begin{theorem}\label{t:a}
We have
\begin{equation}\label{e:a} \int_0^1 f = 1. \end{equation}
\end{theorem}
\includegraphics{fig.png} and \includegraphics{missing.pdf}
\section{Two}
By Theorem~\ref{t:a} and \eqref{e:a}, see Section~\ref{s:one}.
\begin{align*} a &= b \\ &\le c \end{align*}
\begin{tikzcd} A \arrow[r, "f"] & B \end{tikzcd}
\end{document}`;

async function book(opts) {
  const result = TeXglass.render(SRC, { renderMath, resolveImage: (p) => (p.endsWith('.png') ? 'fig.png' : 'missing.pdf') });
  const out = await TeXglassEpub.build({
    body: result.html,
    title: result.title,
    toc: result.toc,
    katexCss: fs.readFileSync(path.join(KATEX, 'katex.min.css'), 'utf8'),
    readFont: (n) => new Uint8Array(fs.readFileSync(path.join(KATEX, 'fonts', n))),
    readImage: (src) => (src === 'fig.png' ? { data: new Uint8Array(PNG) } : { data: new Uint8Array([37, 80, 68, 70]), type: 'application/pdf' }),
    diagramsJs: fs.readFileSync(path.join(ROOT, 'src/diagrams.js'), 'utf8'),
    modified: new Date('2026-11-22T10:00:00Z'),
    ...opts,
  });
  const files = unzip(out.bytes);
  const get = (n) => { const f = files.find((x) => x.name === n); return f && f.data.toString('utf8'); };
  return { ...out, files, get, result };
}

test('the package: mimetype first and stored, container, manifest, spine, contents', async () => {
  const { files, get, warnings } = await book();
  assert.equal(files[0].name, 'mimetype');
  assert.equal(files[0].method, 0);
  assert.equal(files[0].extra, 0);
  assert.equal(files[0].data.toString(), 'application/epub+zip');
  for (const f of files) assert.equal(TeXglassEpub.crc32(f.data), f.crc, f.name + ' CRC');
  assert.match(get('META-INF/container.xml'), /full-path="OEBPS\/content.opf"/);
  const opf = get('OEBPS/content.opf');
  assert.match(opf, /<dc:title>A Test &amp; Book<\/dc:title>/);
  assert.match(opf, /<dc:creator id="creator1">Ada Lovelace<\/dc:creator>/);
  assert.match(opf, /<dc:creator id="creator2">Emmy Noether<\/dc:creator>/);
  assert.match(opf, /<dc:identifier id="uid">urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/dc:identifier>/);
  assert.match(opf, /<meta property="dcterms:modified">2026-11-22T10:00:00Z<\/meta>/);
  assert.match(opf, /href="nav.xhtml" media-type="application\/xhtml\+xml" properties="nav"/);
  // every file in the book is in the manifest, and the other way round
  const items = [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((m) => 'OEBPS/' + m[1]).sort();
  const inZip = files.map((f) => f.name).filter((n) => n.startsWith('OEBPS/') && n !== 'OEBPS/content.opf').sort();
  assert.deepEqual(items, inZip);
  // the title page, two sections, the notes
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(spine, ['c0', 'c1', 'c2', 'c3']);
  const nav = get('OEBPS/nav.xhtml');
  assert.match(nav, /<a href="c00.xhtml">A Test &amp; Book<\/a>/);
  assert.match(nav, /<a href="c01.xhtml">1 One<\/a>/);
  assert.match(nav, /<a href="c02.xhtml">2 Two<\/a>/);
  assert.match(nav, /<a href="c03.xhtml">Notes<\/a>/);
  assert.match(get('OEBPS/toc.ncx'), /<content src="c02.xhtml"\/>/);
  // the PDF figure could not go in, and says so
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing\.pdf/);
});

test('maths is MathML, with Unicode maths letters and aligned columns', async () => {
  const { get, files } = await book();
  const c1 = get('OEBPS/c01.xhtml');
  assert.ok(!/class="katex/.test(c1), 'no KaTeX HTML outside diagrams');
  assert.match(c1, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"><semantics>/);
  assert.match(c1, /<mi>ℝ<\/mi>/);
  assert.match(c1, /<mi>𝒞<\/mi>/);
  assert.ok(!/mathvariant="double-struck"|<mtd[^>]* width=/.test(c1));
  assert.match(c1, /<math xmlns="[^"]+" display="block">/);
  const opf = get('OEBPS/content.opf');
  assert.match(opf, /id="c1" href="c01.xhtml" media-type="application\/xhtml\+xml" properties="mathml"/);
  const c2 = get('OEBPS/c02.xhtml');
  assert.match(c2, /<mtd style="text-align:right">/);
  assert.match(c2, /<mtd style="text-align:left">/);
  // KaTeX's stylesheet and fonts only for the formulas inside diagrams
  assert.match(c2, /href="katex.css"/);
  assert.ok(!/href="katex.css"/.test(c1));
  assert.ok(files.some((f) => f.name === 'OEBPS/fonts/KaTeX_Main-Regular.woff2'));
  assert.match(get('OEBPS/katex.css'), /src:url\(fonts\/KaTeX_Main-Regular.woff2\) format\("woff2"\)/);
  assert.ok(!/\.woff\)|\.ttf\)/.test(get('OEBPS/katex.css')), 'only the woff2 fonts, which are in the book');
});

test('links across chapters, footnotes, figures and scripted diagrams', async () => {
  const { get, files } = await book();
  const c1 = get('OEBPS/c01.xhtml');
  const c2 = get('OEBPS/c02.xhtml');
  const ids = (s) => new Set([...s.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const where = {};
  for (const f of files.filter((x) => /c\d+\.xhtml$/.test(x.name))) where[f.name.slice(6)] = ids(f.data.toString());
  // every internal link lands on an id
  for (const f of Object.keys(where)) {
    for (const [, file, id] of get('OEBPS/' + f).matchAll(/<a [^>]*href="(c\d+\.xhtml)?#([^"]+)"/g)) {
      assert.ok(where[file || f].has(id), `${f}: link to ${file || ''}#${id}`);
    }
  }
  assert.match(c2, /href="c01.xhtml#thm-\d+"/, 'a reference to a theorem in chapter 1');
  assert.match(c1, /<a href="c03.xhtml#fn-1" id="fnref-1" epub:type="noteref">/);
  assert.match(get('OEBPS/c03.xhtml'), /<li id="fn-1" epub:type="footnote">/);
  assert.match(c1, /<img class="graphic" src="images\/img1.png" alt="fig.png"\/>/);
  assert.match(c1, /<span class="graphic-placeholder">missing.pdf<\/span>/);
  assert.deepEqual([...files.find((f) => f.name === 'OEBPS/images/img1.png').data], [...PNG]);
  // not drawn yet: the book draws the diagram with diagrams.js
  assert.match(c2, /<script src="diagrams.js"><\/script>/);
  assert.match(c2, /data-cd="/);
  assert.match(get('OEBPS/content.opf'), /id="c2" href="c02.xhtml" media-type="application\/xhtml\+xml" properties="mathml scripted"/);
});

test('HTML becomes XHTML: void elements, entities, paragraphs, SVG names', () => {
  const t = TeXglassEpub.parse('<p>a&nbsp;b<br>c<img src="x.png"><div>d</div></p><svg viewBox="0 0 1 1"><path d="M0 0"/><clipPath id="c"></clipPath></svg><p>e &unknown; &#x1D400; &lt;</p>');
  assert.equal(TeXglassEpub.serialize(t),
    '<p>a b<br/>c<img src="x.png"/></p><div>d</div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"/><clipPath id="c"/></svg><p>e &amp;unknown; 𝐀 &lt;</p>');
  assert.equal(TeXglassEpub.serialize(TeXglassEpub.parse('<button onclick="x()">x</button><span hidden data-x=\'"\'>y</span>')),
    '<button>x</button><span hidden="hidden" data-x="&quot;">y</span>');
  assert.equal(TeXglassEpub.fileName('dir/paper.tex'), 'paper.epub');
  assert.equal(TeXglassEpub.fileName('', 'On Things: a study'), 'On-Things-a-study.epub');
});

test('the same paper gets the same identifier', async () => {
  const a = await book();
  const b = await book({ modified: new Date('2027-01-01T00:00:00Z') });
  const uid = (x) => /urn:uuid:[^<]+/.exec(x.get('OEBPS/content.opf'))[0];
  assert.equal(uid(a), uid(b));
});

test('in a browser: diagrams drawn into the book, in em, and every page parses as XHTML', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="katex.min.css"><style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style></head><body></body></html>`);
    await page.addStyleTag({ content: fs.readFileSync(path.join(KATEX, 'katex.min.css'), 'utf8').replace(/url\(fonts\//g, 'url(file://' + KATEX + '/fonts/') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/diagrams.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/epub.js') });
    const result = TeXglass.render(SRC, { renderMath, resolveImage: () => null });
    const drawn = await page.evaluate((html) => window.TeXglassEpub.drawDiagrams(html, document), result.html);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.document').length), 0, 'the drawing box is gone');
    const { get, files } = await book({ body: drawn, diagramsDrawn: true, diagramsJs: '' });
    const c2 = get('OEBPS/c02.xhtml');
    assert.ok(!/<script/.test(c2), 'drawn: no script');
    assert.ok(!files.some((f) => f.name === 'OEBPS/diagrams.js'));
    assert.ok(!/data-cd=/.test(c2));
    assert.match(c2, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="cd-svg"[^>]* viewBox="[^"]+"[^>]* style="width: [\d.]+em; height: [\d.]+em;"/);
    assert.match(c2, /class="cd-label"[^>]*style="[^"]*left: ?[\d.-]+em/);
    assert.ok(!/rgb\(1, 2, 3\)/.test(c2), 'the drawing colour is gone');
    assert.match(get('OEBPS/content.opf'), /id="c2" href="c02.xhtml" media-type="application\/xhtml\+xml" properties="mathml svg"/);
    // the browser's XML parser takes every page
    for (const f of files.filter((x) => /\.(xhtml|opf|ncx|xml)$/.test(x.name))) {
      const err = await page.evaluate((s) => {
        const d = new DOMParser().parseFromString(s, 'application/xml');
        const e = d.querySelector('parsererror');
        return e ? e.textContent : null;
      }, f.data.toString());
      assert.equal(err, null, f.name);
    }
  } finally {
    await browser.close();
  }
});
