/*
 * Export a rendered document as one standalone HTML page: the page the
 * preview shows, with the viewer's stylesheet and KaTeX's inside it, so it
 * opens anywhere without TeXglass. Used by the web viewer (Export button),
 * the VS Code extension (TeXglass: Export to HTML) and the CLI.
 *
 * Everything here is plain string work; reading files (the stylesheet,
 * KaTeX's fonts, images) is left to the caller, which knows where they are.
 *
 * Works in the browser (window.TeXglassExport) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KATEX_VERSION = '0.16.11';
  const KATEX_CDN = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/`;

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // The viewer's stylesheet is written for an app whose panes scroll inside a
  // fixed window. A document page scrolls as a whole and prints as one.
  const PAGE_CSS = `
html, body { height: auto; overflow: visible; }
body { display: block; }
.pane { overflow: visible; }
.document { margin-left: auto; margin-right: auto; }
#preview > .src-block { content-visibility: visible; }
.theme-toggle { position: fixed; top: 10px; right: 12px; z-index: 5; width: 32px; height: 32px; padding: 0; border: 1px solid var(--rule); border-radius: 50%; background: var(--paper); color: var(--muted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.theme-toggle[hidden] { display: none; }
.theme-toggle:hover { color: var(--ink); }
@media print { .theme-toggle { display: none; } }
.tg-view-hide { display: none !important; }
`;

  // A light/dark switch like the preview's; it remembers nothing, so the page
  // follows the reader's system until they press it.
  const THEME_SCRIPT = `
(function () {
  var b = document.getElementById('theme-toggle');
  if (!b) return;
  b.hidden = false;
  b.addEventListener('click', function () {
    var root = document.documentElement;
    var t = root.getAttribute('data-theme');
    var dark = t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
  });
})();
`;

  // For a page made to be printed (VS Code's Print / Save as PDF): open the
  // print dialog once the fonts have loaded, so the math is set in KaTeX's.
  const PRINT_SCRIPT = `
(function () {
  function go() { setTimeout(function () { window.print(); }, 200); }
  window.addEventListener('load', function () {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go);
    else go();
  });
})();
`;

  // For a page printed with a view (VS Code: "Show pinned results", or "What
  // does this use?" with Hide the rest): the preview says which of its blocks
  // show (TeXglassPick.snapshot, by their place among VIEW_BLOCKS); the page
  // hides the others. If the page's blocks do not match the preview's, the
  // whole document prints.
  const VIEW_BLOCKS = 'h1, h2, h3, h4, h5, h6, header, .theorem, .proof, .math-display, figure, table, li, p, blockquote, pre';
  const VIEW_OUTSIDE = '.ref-popover, .insight-popover, .insight-dialog, .mnote, .tg-margin, .tg-hlbar, .tg-note-pad, .tg-note-dock, .pick-bar, .uses-bar, .pick-sheet, .pick-memo, .pick-context, .pick-handout';
  function applyView(root, view, blocksSel, outsideSel) {
    var blocks = Array.prototype.filter.call(root.querySelectorAll(blocksSel), function (el) { return !el.closest(outsideSel); });
    if (!view || blocks.length !== view.n) return false;
    var keep = new Set();
    view.keep.forEach(function (i) { if (blocks[i]) keep.add(blocks[i]); });
    var lit = new Set();
    keep.forEach(function (k) { for (var p = k.parentElement; p && p !== root; p = p.parentElement) lit.add(p); });
    (function walk(node) {
      Array.prototype.forEach.call(node.children, function (c) {
        if (keep.has(c)) return;
        if (lit.has(c)) walk(c);
        else c.classList.add('tg-view-hide');
      });
    })(root);
    return true;
  }
  const viewScript = (view) => `
(${applyView.toString()})(document.getElementById('preview'), ${JSON.stringify({ n: view.n | 0, keep: (view.keep || []).map((i) => i | 0) })}, ${JSON.stringify(VIEW_BLOCKS)}, ${JSON.stringify(VIEW_OUTSIDE)});
`;

  const SRC_BLOCK = /^<div class="src-block" data-s="\d+" data-e="\d+">/;

  /** The preview's blocks (render with sourceMap) as plain HTML, without their source ranges. */
  function joinBlocks(blocks) {
    return blocks
      .map((b) => (SRC_BLOCK.test(b) && b.endsWith('</div>') ? b.slice(b.indexOf('>') + 1, -6) : b))
      .join('\n');
  }

  /** The file name of a KaTeX font that a url() in katex.min.css points at, or null. */
  const fontName = (url) => {
    const m = /^fonts\/(KaTeX_[\w-]+\.woff2)$/.exec(url);
    return m ? m[1] : null;
  };

  /**
   * KaTeX's stylesheet with its fonts inside it as data: URLs, so that math
   * looks right offline. Only the woff2 fonts are kept (every current browser
   * reads them). readFont(name) gives a font's bytes as base64, or a promise
   * of them; if any font cannot be read, the result is null.
   */
  async function embedKatexFonts(css, readFont) {
    const names = new Set();
    css.replace(/url\((fonts\/[^)]+)\)/g, (_, u) => {
      const n = fontName(u);
      if (n) names.add(n);
      return '';
    });
    const data = {};
    try {
      await Promise.all(Array.from(names, async (n) => {
        data[n] = await readFont(n);
        if (!data[n]) throw new Error('missing ' + n);
      }));
    } catch (e) {
      return null;
    }
    return css.replace(/src:([^;}]*)/g, (all, list) => {
      const woff2 = /url\((fonts\/[^)]+\.woff2)\)\s*format\("woff2"\)/.exec(list);
      const n = woff2 && fontName(woff2[1]);
      return n ? `src:url(data:font/woff2;base64,${data[n]}) format("woff2")` : all;
    });
  }

  /**
   * Replace the src of each <img> whose URL `want(url)` accepts with what
   * toUrl(url) gives (a promise or a string), e.g. object URLs with data: URLs.
   */
  async function replaceImages(html, want, toUrl) {
    const urls = new Set();
    for (const m of html.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/g)) if (want(m[1])) urls.add(m[1]);
    if (!urls.size) return html;
    const map = new Map();
    await Promise.all(Array.from(urls, async (u) => {
      try {
        map.set(u, await toUrl(u));
      } catch (e) { /* keep the old URL */ }
    }));
    return html.replace(/(<img\b[^>]*?\ssrc=")([^"]*)"/g, (all, head, u) => (map.has(u) && map.get(u) ? `${head}${map.get(u)}"` : all));
  }

  /**
   * The whole page.
   *   body       the document's HTML (render().html, or joinBlocks(blocks))
   *   title      the page title
   *   css        the viewer's stylesheet (styles.css)
   *   katexCss   KaTeX's stylesheet to put inside the page (see
   *              embedKatexFonts); without it the page links KaTeX's from a CDN
   *   theme      'light' or 'dark' to fix the colours; else they follow the system
   *   diagramsJs src/diagrams.js, which draws the arrows of tikzcd/xymatrix and
   *              the tikzpicture paths; put inside the page when it has diagrams
   *   print      open the print dialog as soon as the page has loaded
   *   view       print only these blocks: { n, keep } from TeXglassPick.snapshot
   *   rootAttrs  more attributes for <html>, e.g. { 'data-look': 'notes' }
   *   extraCss   a stylesheet to put after the viewer's (e.g. a look's)
   *   bodyStart  markup to put first in <body> (e.g. SVG filters the look uses)
   *   reader     the reading tools: { scripts, data }. scripts are the sources
   *              of READER_SCRIPTS, in that order; data is { defs, toc } from
   *              render(). The page then looks like the viewer: a toolbar, a
   *              side panel and a scrolling document (see src/reader.js).
   */
  function page({ body, title, css, katexCss, theme, diagramsJs, print, view, rootAttrs, extraCss, bodyStart, reader }) {
    if (reader && Array.isArray(reader.scripts)) {
      return readerPage({ body, title, css, katexCss, theme, diagramsJs, rootAttrs, extraCss, bodyStart, reader });
    }
    const diagrams = diagramsJs && /class="tg-diagram/.test(body || '')
      ? `\n<script>${diagramsJs.replace(/<\/script/gi, '<\\/script')}</script>`
      : '';
    const katex = katexCss
      ? `<style>${katexCss.replace(/<\/style/gi, '<\\/style')}</style>`
      : `<link rel="stylesheet" href="${KATEX_CDN}katex.min.css" crossorigin="anonymous">`;
    const themeAttr = theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : '';
    const moreAttrs = Object.entries(rootAttrs || {})
      .filter(([k]) => /^data-[a-z-]+$/.test(k))
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join('');
    const more = extraCss ? `\n<style>${extraCss.replace(/<\/style/gi, '<\\/style')}</style>` : '';
    return `<!doctype html>
<html lang="en"${themeAttr}${moreAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="TeXglass">
<title>${escapeHtml(title || 'Document')}</title>
${katex}
<style>${(css || '').replace(/<\/style/gi, '<\\/style')}
${PAGE_CSS}</style>${more}
</head>
<body>
${bodyStart ? bodyStart + '\n' : ''}<button id="theme-toggle" class="theme-toggle" type="button" title="Switch between light and dark" aria-label="Switch between light and dark" hidden><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
<main class="panes"><section class="pane"><article id="preview" class="document">
${body}
</article></section></main>
${view && Array.isArray(view.keep) ? `<script>${viewScript(view)}</script>\n` : ''}<script>${THEME_SCRIPT}</script>${diagrams}
${print ? `<script>${PRINT_SCRIPT}</script>\n` : ''}</body>
</html>
`;
  }

  // The files a reader page holds, in order (paths from the repository root).
  // KaTeX and the converter draw the symbols of the notation index.
  const READER_SCRIPTS = [
    'vendor/katex/katex.min.js',
    'src/texglass.js',
    'src/popover.js',
    'src/scroll.js',
    'src/find.js',
    'src/copytex.js',
    'src/insight.js',
    'src/pick.js',
    'src/cite.js',
    'src/reader.js',
  ];

  // The viewer's layout, minus what an exported page has no use for.
  const READER_CSS = `
.tg-reader-bar .tg-reader-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 14px; }
.tg-reader-bar .tg-reader-made { font-size: 12px; color: var(--muted); text-decoration: none; white-space: nowrap; }
.tg-reader-bar .tg-reader-made:hover { color: var(--accent); }
#preview > .src-block { content-visibility: visible; }
@media (max-width: 760px) { .tg-reader-bar .tg-reader-made { display: none; } }
@media print { html, body { height: auto; overflow: visible; } body { display: block; } .panes, .pane { display: block; overflow: visible; } }
`;

  const script = (js) => `<script>${String(js).replace(/<\/script/gi, '<\\/script')}</script>`;
  // JSON inside <script>: nothing in it may close the element.
  const jsonScript = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value || {}).replace(/</g, '\\u003c')}</script>`;

  const MOON = '<svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const SUN = '<svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  /** page() with the reading tools: the viewer's layout and src/reader.js. */
  function readerPage({ body, title, css, katexCss, theme, diagramsJs, rootAttrs, extraCss, bodyStart, reader }) {
    const katex = katexCss
      ? `<style>${katexCss.replace(/<\/style/gi, '<\\/style')}</style>`
      : `<link rel="stylesheet" href="${KATEX_CDN}katex.min.css" crossorigin="anonymous">`;
    const themeAttr = theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : '';
    const moreAttrs = Object.entries(rootAttrs || {})
      .filter(([k]) => /^data-[a-z-]+$/.test(k))
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join('');
    const more = extraCss ? `\n<style>${extraCss.replace(/<\/style/gi, '<\\/style')}</style>` : '';
    const diagrams = diagramsJs && /class="tg-diagram/.test(body || '') ? '\n' + script(diagramsJs) : '';
    const data = reader.data || {};
    return `<!doctype html>
<html lang="en"${themeAttr}${moreAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="TeXglass">
<title>${escapeHtml(title || 'Document')}</title>
${katex}
<style>${(css || '').replace(/<\/style/gi, '<\\/style')}
${READER_CSS}</style>${more}
</head>
<body>
${bodyStart ? bodyStart + '\n' : ''}<header class="toolbar tg-reader-bar">
<span class="tg-reader-title">${escapeHtml(title || '')}</span>
<a class="tg-reader-made" href="https://github.com/klepo0/TeXglass" target="_blank" rel="noopener">Made with TeXglass</a>
<button id="toc-toggle" type="button" aria-pressed="false" aria-controls="toc-pane" title="Show or hide the side panel: contents, the map of which results use which, and the notation index" hidden>Contents</button>
<button id="find" type="button" title="Search the document (Ctrl+F) or go to a theorem, equation or section by its number (Ctrl+G)">Navigate</button>
<button id="theme-toggle" class="icon-button" type="button" title="Switch between light and dark" aria-label="Switch between light and dark">${MOON}${SUN}</button>
</header>
<main class="panes">
<nav class="toc-pane" id="toc-pane" aria-label="Table of contents" hidden><div class="toc-pane-head"><div class="toc-pane-title">Contents</div></div><ol id="toc-list" class="toc-list"></ol></nav>
<section class="pane preview-pane" id="preview-pane"><article id="preview" class="document">
${body}
</article></section>
</main>
<div id="ref-popover" class="ref-popover document" role="tooltip" hidden></div>
${jsonScript('tg-reader-data', { defs: data.defs || null, toc: data.toc || [] })}
${script(THEME_SCRIPT)}${diagrams}
${reader.scripts.map(script).join('\n')}
</body>
</html>
`;
  }

  /** A file name for the page: the source's name with .html, or the title's. */
  function fileName(sourceName, title) {
    const base = sourceName
      ? sourceName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
      : (title || 'document').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
    return (base || 'document') + '.html';
  }

  return { page, joinBlocks, READER_SCRIPTS, embedKatexFonts, replaceImages, fileName, applyView, VIEW_BLOCKS, VIEW_OUTSIDE, KATEX_CDN, KATEX_VERSION };
});
