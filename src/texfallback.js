/*
 * Draw what TeXglass cannot with the reader's own LaTeX.
 *
 * TeXglass renders LaTeX itself, without a TeX installation. When a formula
 * fails (a KaTeX error, a command KaTeX does not know) or a picture is drawn
 * only in part (TikZ features or pgfplots that tikz.js does not draw), a host
 * that can run TeX on the reader's computer (the VS Code extension, FlexTeX)
 * compiles just those pieces with the document's preamble and this module
 * puts the result in their place. Without a TeX installation nothing changes.
 *
 * In a page:
 *
 *   const fallback = TeXglassTexFallback.create({
 *     root,                      // the element the document is rendered into
 *     request: async (pieces) => results,  // the host's compiler, see below
 *     preamble: () => text,      // the document's preamble (preamble(source))
 *     onChange: () => {},        // optional: called after pieces were swapped
 *   });
 *   fallback.refresh();          // after each render: finds failed pieces, asks, swaps
 *   fallback.reset();            // another document: forget what was drawn
 *
 * request(pieces) gets [{ key, tex, display, kind }] (kind 'math' or 'picture';
 * tex is LaTeX for one piece, ready to go between \begin{document} and
 * \end{document}, see piece()) and resolves to one result per piece, in order:
 *   { pdf, page, depth }  pdf: bytes (Uint8Array, ArrayBuffer, Blob or base64)
 *                         of a PDF whose page `page` (from 1) is the piece,
 *                         cropped to it; depth: points below the baseline
 *   null                  could not be drawn (no TeX, or TeX failed too)
 *
 * In Node (texfallback-node.js, the compiler that hosts use): preamble(),
 * engineFor(), documentFor() and parseLog() below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassTexFallback = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BORDER = 0.5; // points of margin around each piece (preview's \PreviewBorder)

  // ---- LaTeX for the pieces (used by hosts in Node, and to build keys here) ----

  /** The text with % comments taken out (an escaped \% stays). */
  function stripComments(text) {
    return String(text).replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, '$1$2');
  }

  /** The document's preamble, from \documentclass up to \begin{document}; null without one. */
  function preamble(source) {
    const text = String(source || '').replace(/\r\n?/g, '\n');
    const clean = stripComments(text);
    const begin = /\\begin\s*\{document\}/.exec(clean);
    if (!begin || !/\\documentclass\b/.test(clean.slice(0, begin.index))) return null;
    // the comments stay out, so a % in the last line cannot swallow what follows
    return clean.slice(0, begin.index).replace(/\s+$/, '') + '\n';
  }

  /** The engine a preamble needs: lualatex or xelatex for system fonts, else pdflatex. */
  function engineFor(pre) {
    const p = stripComments(pre || '');
    if (/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatexbase|luaotfload|lua-visual-debug|lualatex-math)\b/.test(p) || /\\directlua\b/.test(p)) return 'lualatex';
    if (/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|xeCJK|polyglossia|mathspec|xltxtra)\b/.test(p)) return 'xelatex';
    return 'pdflatex';
  }

  const AMS = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:amsmath|mathtools|empheq)\b|\\documentclass(?:\[[^\]]*\])?\{(?:ams(?:art|book|proc)|elsarticle|revtex4(?:-\d)?|llncs|siamart\d*|imsart)\}/;

  /** Split at top-level \\ (row breaks), outside braces and inner environments. */
  function rows(tex) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < tex.length; i++) {
      const c = tex[i];
      if (c === '\\') {
        if (tex[i + 1] === '\\' && depth === 0) {
          out.push(tex.slice(start, i));
          let j = i + 2;
          const opt = /^\s*\[[^\]]*\]/.exec(tex.slice(j)); // \\[2pt]
          if (opt) j += opt[0].length;
          start = j;
          i = j - 1;
          continue;
        }
        const env = /^\\(begin|end)\s*\{[^}]*\}/.exec(tex.slice(i));
        if (env) {
          depth += env[1] === 'begin' ? 1 : -1;
          i += env[0].length - 1;
        } else i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    out.push(tex.slice(start));
    while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  const ALIGNS = /^\\begin\s*\{(align|gather|flalign|alignat|eqnarray|multline)(\*?)\}(\s*\{[^}]*\})?([\s\S]*)\\end\s*\{\1\*?\}\s*$/;
  const TAG = /\\tag\*?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g;

  /**
   * LaTeX for one formula: tex as written (a .math element's data-tex), and the
   * \tag{…} numbers TeXglass gave its rows (from the text it handed KaTeX), so
   * the drawing shows the same numbers. Numbers need amsmath in the preamble.
   */
  function mathTex(tex, display, shown, pre) {
    tex = String(tex).trim();
    if (!display) return `$${tex}$`;
    const ams = AMS.test(stripComments(pre || ''));
    const tags = String(shown || '').match(TAG) || [];
    const m = ALIGNS.exec(tex);
    if (m) {
      const env = m[1];
      const star = env === 'eqnarray' || !ams ? m[2] : '*'; // starred, so LaTeX does not number it again
      let body = m[4];
      if (ams && tags.length && env !== 'eqnarray' && !m[2]) {
        // the row numbers TeXglass shows: \tag on each row that had one
        const own = rows(body);
        const seen = rows(String(shown).replace(/^[\s\S]*?\\begin\s*\{[^}]*\}(\s*\{[^}]*\})?/, '').replace(/\\end\s*\{[^}]*\}\s*$/, ''));
        if (own.length === seen.length) {
          body = own.map((r, k) => { const t = seen[k].match(TAG); return t ? `${r} ${t[0]}` : r; }).join(' \\\\\n');
        }
      } else if (!ams) {
        body = body.replace(TAG, '');
      }
      return `\\begin{${env}${star || m[2]}}${m[3] || ''}${body}\\end{${env}${star || m[2]}}`;
    }
    const tag = ams && tags.length === 1 ? ` ${tags[0]}` : '';
    return `\\[ ${tex}${tag} \\]`;
  }

  /** LaTeX for a piece found in the page: what goes inside the preview box. */
  function pieceTex(piece) {
    if (piece.kind === 'picture') return piece.tex;
    if (piece.display) return `\\begin{minipage}{\\linewidth}${piece.tex}\\end{minipage}`;
    return piece.tex;
  }

  /**
   * The document that draws every piece on a page of its own, cropped to it
   * (the preview package), and logs each one's size (parseLog reads them back).
   */
  function documentFor(pre, pieces) {
    const lines = [
      String(pre).replace(/\s+$/, ''),
      '\\usepackage[active,tightpage]{preview}',
      `\\setlength\\PreviewBorder{${BORDER}pt}`,
      '\\newsavebox\\tgfallbackbox',
      '\\pagestyle{empty}',
      '\\begin{document}',
    ];
    pieces.forEach((p, k) => {
      lines.push(`\\typeout{TGPIECE ${k + 1}}%`);
      lines.push(`\\begin{preview}\\sbox\\tgfallbackbox{${pieceTex(p)}}%`);
      lines.push('\\typeout{TGBOX \\the\\ht\\tgfallbackbox\\space\\the\\dp\\tgfallbackbox\\space\\the\\wd\\tgfallbackbox}%');
      lines.push('\\usebox\\tgfallbackbox\\end{preview}');
    });
    lines.push('\\typeout{TGPIECE END}%', '\\end{document}', '');
    return lines.join('\n');
  }

  /**
   * What the log of documentFor's run says: for each piece { ok, page, height,
   * depth, width } (points), the font size, and the page count. A piece with a
   * TeX error is not ok, so the reader keeps TeXglass's own rendering of it.
   */
  function parseLog(log, count) {
    const text = String(log || '');
    const out = [];
    for (let k = 0; k < count; k++) out.push({ ok: false, page: k + 1 });
    const font = /Preview: Fontsize ([\d.]+)pt/.exec(text);
    const pages = /Output written on .*?\((\d+) pages?/.exec(text.replace(/\n/g, ''));
    const at = text.indexOf('TGPIECE 1\n');
    const fatal = at < 0; // the preamble stopped TeX (a missing package, say)
    if (!fatal) {
      const parts = text.slice(at).split(/^TGPIECE /m).slice(1);
      for (const part of parts) {
        const n = parseInt(part, 10);
        if (!(n >= 1 && n <= count)) continue;
        const box = /^TGBOX ([\d.]+)pt ([\d.]+)pt ([\d.]+)pt/m.exec(part);
        out[n - 1] = {
          ok: !!box && !/^! /m.test(part),
          page: n,
          height: box ? +box[1] : 0,
          depth: box ? +box[2] : 0,
          width: box ? +box[3] : 0,
        };
      }
    }
    const pageCount = pages ? +pages[1] : 0;
    if (pageCount !== count) for (const r of out) r.ok = false; // pages and pieces do not line up
    return { pieces: out, fontSize: font ? +font[1] : 10, pages: pageCount, fatal };
  }

  // ---- in the page ----

  const MATH = '.math[data-tex]';
  const PICTURE = '[data-tg-source]';

  /** Undefined commands KaTeX shows in red. */
  function redCommand(el) {
    for (const n of el.querySelectorAll('.katex-html .mord.text[style*="color:#cc0000"]')) {
      if (/^\\[A-Za-z@]+\*?$/.test(n.textContent.trim())) return true;
    }
    return false;
  }

  /** The text TeXglass gave KaTeX for a formula (with its \tag numbers). */
  function shownTex(el) {
    const err = el.querySelector('.math-error, .katex-error');
    if (err) return err.textContent;
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    return ann ? ann.textContent : '';
  }

  /** The pieces in root that TeXglass could not draw: [{ el, kind, display, tex }]. */
  function failed(root, pre) {
    const out = [];
    for (const el of root.querySelectorAll(MATH)) {
      if (el.dataset.tgTexfallback || el.closest('.tg-diagram')) continue; // math in a picture goes with the picture
      if (!el.querySelector('.math-error, .katex-error') && !redCommand(el)) continue;
      const display = el.classList.contains('math-display');
      // align with \intertext comes as several displays with the same source: leave it to TeXglass
      const near = [el.previousElementSibling, el.nextElementSibling];
      if (display && near.some((n) => n && n.matches('p.intertext'))) continue;
      out.push({ el, kind: 'math', display, tex: mathTex(el.dataset.tex, display, shownTex(el), pre) });
    }
    for (const el of root.querySelectorAll(PICTURE)) {
      if (el.dataset.tgTexfallback) continue;
      out.push({ el, kind: 'picture', display: el.tagName === 'DIV', tex: el.dataset.tgSource });
    }
    return out;
  }

  function toBlob(pdf) {
    if (typeof Blob !== 'undefined' && pdf instanceof Blob) return pdf;
    if (typeof pdf === 'string') {
      const bin = atob(pdf);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      pdf = bytes;
    }
    return new Blob([pdf], { type: 'application/pdf' });
  }

  function create(opts) {
    const root = opts.root;
    let drawn = new Map(); // key -> Promise of { url, width, height, depth, font } or null
    const pdfs = new Map(); // pdf bytes -> Blob, so a batch's PDF is read once
    const urls = [];
    let generation = 0;

    async function draw(result) {
      if (!result || !result.pdf || !window.TeXglassPdf) return null;
      let blob = pdfs.get(result.pdf);
      if (!blob) pdfs.set(result.pdf, (blob = toBlob(result.pdf)));
      const image = await window.TeXglassPdf.toImage(blob, { page: result.page || 1, transparent: true });
      if (!image) return null;
      const url = URL.createObjectURL(image);
      urls.push(url);
      return { url, depth: result.depth || 0, font: result.fontSize || 10, size: await sizeOf(image) };
    }

    /** The image's size in points, from the SVG pdf.js wrote (width="…pt"). */
    async function sizeOf(image) {
      const head = await image.slice(0, 300).text();
      const m = /width="([\d.]+)pt" height="([\d.]+)pt"/.exec(head);
      return m ? { width: +m[1], height: +m[2] } : null;
    }

    function swap(item, d) {
      const { el } = item;
      if (!el.isConnected) return false;
      if (!d) {
        el.dataset.tgTexfallback = 'failed';
        return false;
      }
      const img = document.createElement('img');
      img.className = 'tg-texfallback-img';
      img.src = d.url;
      img.alt = item.kind === 'math' ? el.dataset.tex : 'Picture drawn with LaTeX';
      img.title = 'Drawn by the LaTeX on this computer';
      img.draggable = false;
      // sized in em, so the drawing's text matches the text around it (KaTeX sets math at 1.21em)
      const scale = item.kind === 'math' ? 1.21 : 1;
      const em = (pt) => `${+((pt * scale) / d.font).toFixed(3)}em`;
      if (d.size) img.style.width = em(d.size.width);
      if (item.kind === 'math' && !item.display) img.style.verticalAlign = `-${em(d.depth + BORDER)}`;
      el.dataset.tgTexfallback = 'drawn';
      el.classList.add('tg-texfallback');
      if (item.kind === 'math') el.replaceChildren(img);
      else {
        const box = document.createElement(el.tagName === 'DIV' ? 'div' : 'span');
        box.className = 'tg-texfallback tg-texfallback-picture';
        box.dataset.tgTexfallback = 'drawn';
        box.dataset.tgSource = el.dataset.tgSource;
        box.appendChild(img);
        el.replaceWith(box);
      }
      return true;
    }

    async function refresh() {
      if (!root) return;
      const run = generation;
      const pre = typeof opts.preamble === 'function' ? opts.preamble() : opts.preamble || '';
      const items = failed(root, pre);
      if (!items.length) return;
      const ask = [];
      const waits = [];
      for (const item of items) {
        item.key = `${item.kind}|${item.display ? 1 : 0}|${item.tex}|${pre}`; // a new preamble draws again
        item.el.dataset.tgTexfallback = 'pending';
        if (!drawn.has(item.key)) {
          const slot = {};
          drawn.set(item.key, new Promise((resolve) => { slot.resolve = resolve; }));
          ask.push({ item, slot });
        }
        waits.push(drawn.get(item.key).then((d) => [item, d]));
      }
      if (ask.length) {
        let results = [];
        try {
          results = (await opts.request(ask.map(({ item }) => ({ key: item.key, tex: item.tex, display: item.display, kind: item.kind })))) || [];
        } catch (e) {
          results = [];
        }
        ask.forEach(({ slot }, k) => slot.resolve(draw(results[k]).catch(() => null)));
      }
      let changed = false;
      for (const [item, d] of await Promise.all(waits)) {
        if (run !== generation) return;
        if (swap(item, d)) changed = true;
      }
      if (changed && opts.onChange) opts.onChange();
    }

    function reset() {
      generation++;
      drawn = new Map();
      pdfs.clear();
      urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    }

    return { refresh, reset };
  }

  return { create, preamble, engineFor, documentFor, parseLog, mathTex, rows, failed, BORDER, _: { stripComments } };
});
