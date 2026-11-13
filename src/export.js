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
   *   print      open the print dialog as soon as the page has loaded
   */
  function page({ body, title, css, katexCss, theme, print }) {
    const katex = katexCss
      ? `<style>${katexCss.replace(/<\/style/gi, '<\\/style')}</style>`
      : `<link rel="stylesheet" href="${KATEX_CDN}katex.min.css" crossorigin="anonymous">`;
    const themeAttr = theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : '';
    return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="TeXglass">
<title>${escapeHtml(title || 'Document')}</title>
${katex}
<style>${(css || '').replace(/<\/style/gi, '<\\/style')}
${PAGE_CSS}</style>
</head>
<body>
<button id="theme-toggle" class="theme-toggle" type="button" title="Switch between light and dark" aria-label="Switch between light and dark" hidden><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
<main class="panes"><section class="pane"><article id="preview" class="document">
${body}
</article></section></main>
<script>${THEME_SCRIPT}</script>
${print ? `<script>${PRINT_SCRIPT}</script>\n` : ''}</body>
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

  return { page, joinBlocks, embedKatexFonts, replaceImages, fileName, KATEX_CDN, KATEX_VERSION };
});
