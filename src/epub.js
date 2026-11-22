/*
 * Export a rendered document as an EPUB 3 e-book, for reading in Apple Books,
 * Thorium, Kobo, a Kindle (through Send to Kindle) or any other e-book app.
 * Used by the web viewer (… → Export as EPUB), the VS Code extension
 * (TeXglass: Export to EPUB) and the CLI (texglass paper.tex --epub).
 *
 * The book is built from the converter's HTML (render().html):
 *   - maths becomes MathML, which KaTeX already writes beside its HTML, so
 *     formulas are text: they grow with the reader's font size and reflow;
 *   - each top-level section is a chapter of its own, and the e-reader's
 *     contents come from the document's sections;
 *   - references, citations and footnotes stay links, across chapters;
 *   - figures go inside the book (readImage gives their bytes);
 *   - diagrams (tikzcd, xymatrix, TikZ) keep the layout the viewer gives them.
 *     When the caller has already drawn them (the web viewer draws them in the
 *     page, then hands over that HTML: diagramsDrawn) they are plain SVG; else
 *     the book carries src/diagrams.js, which draws them in readers that run
 *     scripts (Apple Books, Thorium, Calibre).
 *
 * Everything here is plain string and byte work, so it runs in the browser
 * (window.TeXglassEpub) and in Node (require) alike.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassEpub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NS = {
    xhtml: 'http://www.w3.org/1999/xhtml',
    svg: 'http://www.w3.org/2000/svg',
    math: 'http://www.w3.org/1998/Math/MathML',
    xlink: 'http://www.w3.org/1999/xlink',
    epub: 'http://www.idpf.org/2007/ops',
  };

  // ---------------------------------------------------------------------------
  // A small HTML reader: enough for the converter's own output (and for what a
  // browser's innerHTML gives back), into a tree that can be written as XHTML.
  // ---------------------------------------------------------------------------

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea', 'title']);
  // Elements that end an open <p>, as an HTML parser would.
  const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
    'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
  // What an e-book has no use for (buttons of the viewer, scripts, forms).
  const DROP = new Set(['script', 'button', 'input', 'select', 'textarea', 'form', 'template', 'noscript', 'iframe', 'object', 'embed', 'canvas', 'dialog']);

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
    zwnj: '‌', zwj: '‍', shy: '­', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘',
    rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®',
    trade: '™', sect: '§', para: '¶', middot: '·', bull: '•', dagger: '†', Dagger: '‡',
    deg: '°', times: '×', divide: '÷', minus: '−', prime: '′', Prime: '″', iexcl: '¡',
    iquest: '¿', euro: '€', pound: '£', cent: '¢', yen: '¥', larr: '←', rarr: '→',
    uarr: '↑', darr: '↓', harr: '↔', hArr: '⇔', rArr: '⇒', lArr: '⇐', ZeroWidthSpace: '​',
    InvisibleTimes: '⁢', ApplyFunction: '⁡', NewLine: '\n', Tab: '\t',
  };

  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (all, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : all;
    });
  }

  const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  const el = (name, attrs, kids) => ({ name, attrs: attrs || [], kids: kids || [] });
  const text = (v) => ({ text: v });

  /** The tree of a piece of HTML: { kids } of nodes { name, attrs: [[k, v]], kids } and { text }. */
  function parse(html) {
    const root = el('#root');
    const stack = [root];
    const top = () => stack[stack.length - 1];
    // Inside <svg> or <math> names are XML's: anything may close itself.
    const foreign = () => stack.some((n) => n.name === 'svg' || n.name === 'math');
    let last = 0;
    TAG.lastIndex = 0;
    let m;
    const addText = (s) => { if (s) top().kids.push(text(decode(s))); };
    while ((m = TAG.exec(html))) {
      addText(html.slice(last, m.index));
      last = TAG.lastIndex;
      if (m[1]) {
        const name = foreign() ? m[1] : m[1].toLowerCase();
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === name) { stack.length = i; break; }
        }
        continue;
      }
      if (!m[2]) continue; // a comment, doctype or CDATA
      const lower = m[2].toLowerCase();
      const inForeign = foreign() || lower === 'svg' || lower === 'math';
      const name = foreign() ? m[2] : lower;
      const attrs = [];
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(m[3] || ''))) {
        const v = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : null;
        attrs.push([inForeign ? a[1] : a[1].toLowerCase(), v == null ? null : decode(v)]);
      }
      if (!foreign() && BLOCK.has(name)) {
        // a block closes an open paragraph (unless something in between holds it)
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === 'p') { stack.length = i; break; }
          if (BLOCK.has(stack[i].name) || stack[i].name === 'li' || stack[i].name === 'td' || stack[i].name === 'th') break;
        }
      }
      const node = el(name, attrs);
      top().kids.push(node);
      if (RAW.has(name) && !foreign()) {
        const end = html.toLowerCase().indexOf('</' + name, last);
        const stop = end < 0 ? html.length : end;
        if (stop > last) node.kids.push(text(name === 'textarea' || name === 'title' ? decode(html.slice(last, stop)) : html.slice(last, stop)));
        const close = end < 0 ? html.length : html.indexOf('>', end) + 1;
        TAG.lastIndex = last = close;
        continue;
      }
      if (m[4] && inForeign) continue;
      if (!foreign() && VOID.has(name)) continue;
      stack.push(node);
    }
    addText(html.slice(last));
    return root;
  }

  const attr = (n, k) => {
    if (!n.attrs) return null;
    for (const [a, v] of n.attrs) if (a === k) return v == null ? '' : v;
    return null;
  };
  const setAttr = (n, k, v) => {
    for (const p of n.attrs) if (p[0] === k) { p[1] = v; return; }
    n.attrs.push([k, v]);
  };
  const removeAttr = (n, k) => { n.attrs = n.attrs.filter((p) => p[0] !== k); };
  const hasClass = (n, c) => {
    const v = n.name && attr(n, 'class');
    return !!v && (' ' + v + ' ').replace(/\s+/g, ' ').indexOf(' ' + c + ' ') >= 0;
  };
  function find(n, test) {
    for (const k of n.kids || []) {
      if (!k.name) continue;
      if (test(k)) return k;
      const f = find(k, test);
      if (f) return f;
    }
    return null;
  }
  function walk(n, fn) {
    for (const k of n.kids || []) {
      if (k.name && fn(k) !== false) walk(k, fn);
    }
  }
  function textOf(n) {
    if (n.text != null) return n.text;
    return (n.kids || []).map(textOf).join('');
  }

  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
  // Characters XML 1.0 does not allow.
  const xmlSafe = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  const XML_NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

  /** A tree (or a node) written as XHTML. */
  function serialize(n, ns) {
    if (n.text != null) return escText(xmlSafe(n.text));
    if (n.name === '#root') return n.kids.map((k) => serialize(k, ns || 'xhtml')).join('');
    let here = ns || 'xhtml';
    if (n.name === 'svg') here = 'svg';
    else if (n.name === 'math') here = 'math';
    const seen = new Set();
    let out = '<' + n.name;
    if (here !== ns && here !== 'xhtml') {
      out += ` xmlns="${NS[here]}"`;
      seen.add('xmlns');
    }
    for (const [k, v] of n.attrs) {
      if (seen.has(k) || !XML_NAME.test(k) || /^on/i.test(k)) continue;
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      seen.add(k);
      out += ` ${k}="${escAttr(xmlSafe(v == null ? k : v))}"`;
    }
    if (here === 'svg' && n.name === 'svg' && !seen.has('xmlns:xlink') && hasXlink(n)) out += ` xmlns:xlink="${NS.xlink}"`;
    if (RAW.has(n.name) && here === 'xhtml') {
      const body = n.kids.map((k) => k.text || '').join('');
      const inner = n.name === 'style' || n.name === 'script' ? '<![CDATA[' + body.replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>' : escText(body);
      return out + '>' + inner + '</' + n.name + '>';
    }
    if (!n.kids.length && (here !== 'xhtml' || VOID.has(n.name))) return out + '/>';
    return out + '>' + n.kids.map((k) => serialize(k, here)).join('') + '</' + n.name + '>';
  }
  function hasXlink(n) {
    if (n.attrs && n.attrs.some(([k]) => k.startsWith('xlink:'))) return true;
    return (n.kids || []).some((k) => k.name && hasXlink(k));
  }

  // ---------------------------------------------------------------------------
  // From the viewer's HTML to the book's
  // ---------------------------------------------------------------------------

  const inside = (n, parents, test) => parents.some(test) || test(n);

  /**
   * Make the tree fit for an e-book, in place: MathML for the maths, no
   * viewer controls, images collected. Returns what it found.
   */
  function prepare(root, opts) {
    const found = { images: [], diagrams: false, katex: false, svg: false, math: false, scripted: false };
    (function visit(n, parents) {
      const out = [];
      for (const k of n.kids) {
        if (!k.name) { out.push(k); continue; }
        if (DROP.has(k.name) && !parents.some((p) => p.name === 'svg' || p.name === 'math')) continue;
        if (hasClass(k, 'tg-diagram')) found.diagrams = true;
        const inDiagram = parents.some((p) => hasClass(p, 'tg-diagram')) || hasClass(k, 'tg-diagram');
        const isKatex = hasClass(k, 'katex-display') || (hasClass(k, 'katex') && !parents.some((p) => hasClass(p, 'katex-display')));
        if (isKatex && !inDiagram) {
          const math = find(k, (x) => x.name === 'math');
          if (math) {
            found.math = true;
            cleanMath(math);
            out.push(math);
            continue;
          }
        }
        // footnote marks and notes: e-readers show the note in a pop-up
        if (k.name === 'a' && n.name === 'sup' && hasClass(n, 'fn')) setAttr(k, 'epub:type', 'noteref');
        if (k.name === 'li' && /^fn-/.test(attr(k, 'id') || '') && parents.some((p) => hasClass(p, 'footnotes'))) setAttr(k, 'epub:type', 'footnote');
        if (k.name === 'img') {
          if (attr(k, 'alt') == null) setAttr(k, 'alt', '');
          found.images.push(k);
        }
        if (k.name === 'svg') found.svg = true;
        if (inDiagram && hasClass(k, 'katex')) found.katex = true;
        if (k.name === 'math') found.math = true;
        removeAttr(k, 'data-tex');
        removeAttr(k, 'data-label');
        removeAttr(k, 'contenteditable');
        removeAttr(k, 'tabindex');
        if (!opts.keepDiagramData) { removeAttr(k, 'data-cd'); removeAttr(k, 'data-tikz'); }
        visit(k, parents.concat(k));
        out.push(k);
      }
      n.kids = out;
    })(root, []);
    return found;
  }

  // Letters in a style (\\mathbb, \\mathcal, \\mathbf, …) as the characters of
  // Unicode's mathematical alphabets: MathML Core (Chromium, so Thorium and
  // many Android apps) draws only mathvariant="normal", and every reader has
  // these characters. [capital A, small a, digit 0 or 0, exceptions].
  const ALPHABETS = {
    bold: [0x1d400, 0x1d41a, 0x1d7ce],
    italic: [0x1d434, 0x1d44e, 0, { h: 0x210e }],
    'bold-italic': [0x1d468, 0x1d482, 0],
    script: [0x1d49c, 0x1d4b6, 0, { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b, e: 0x212f, g: 0x210a, o: 0x2134 }],
    'bold-script': [0x1d4d0, 0x1d4ea, 0],
    fraktur: [0x1d504, 0x1d51e, 0, { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 }],
    'double-struck': [0x1d538, 0x1d552, 0x1d7d8, { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 }],
    'bold-fraktur': [0x1d56c, 0x1d586, 0],
    'sans-serif': [0x1d5a0, 0x1d5ba, 0x1d7e2],
    'bold-sans-serif': [0x1d5d4, 0x1d5ee, 0x1d7ec],
    'sans-serif-italic': [0x1d608, 0x1d622, 0],
    'sans-serif-bold-italic': [0x1d63c, 0x1d656, 0],
    monospace: [0x1d670, 0x1d68a, 0x1d7f6],
  };
  /** s in the alphabet of a mathvariant, or null if some character has no such letter. */
  function styled(s, variant) {
    const a = ALPHABETS[variant];
    if (!a) return null;
    let out = '';
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (a[3] && a[3][ch]) out += String.fromCodePoint(a[3][ch]);
      else if (c >= 65 && c <= 90) out += String.fromCodePoint(a[0] + c - 65);
      else if (c >= 97 && c <= 122) out += String.fromCodePoint(a[1] + c - 97);
      else if (c >= 48 && c <= 57 && a[2]) out += String.fromCodePoint(a[2] + c - 48);
      else if (/\s/.test(ch)) out += ch;
      else return null;
    }
    return out;
  }

  // Make KaTeX's MathML draw the same everywhere:
  //  - mathvariant letters become Unicode's mathematical letters (above);
  //  - widths MathML 3 does not have on <mtd> become CSS, and the table width
  //    of 100% (for equation numbers) too;
  //  - columnalign (aligned equations) also as CSS, which MathML Core reads.
  function cleanMath(math) {
    if (!attr(math, 'xmlns')) math.attrs.unshift(['xmlns', NS.math]);
    (function visit(n, variant) {
      if (n.name === 'annotation' || n.name === 'annotation-xml') return;
      let v = attr(n, 'mathvariant');
      if (v != null && v !== 'normal' && (n.name === 'mi' || n.name === 'mn' || n.name === 'mtext' || n.name === 'mo') && n.kids.every((k) => k.text != null)) {
        const t = styled(n.kids.map((k) => k.text).join(''), v);
        if (t != null) {
          n.kids = [text(t)];
          if (n.name === 'mi' && [...t].length === 1) removeAttr(n, 'mathvariant');
          else setAttr(n, 'mathvariant', 'normal');
          v = null;
        }
      } else if (v == null && variant && variant !== 'normal' && (n.name === 'mi' || n.name === 'mn') && n.kids.every((k) => k.text != null)) {
        const t = styled(n.kids.map((k) => k.text).join(''), variant);
        if (t != null) {
          n.kids = [text(t)];
          if (!(n.name === 'mi' && [...t].length === 1)) setAttr(n, 'mathvariant', 'normal');
        }
      }
      if (n.name === 'mstyle' && v) variant = v;
      if (n.name === 'mtd') {
        const w = attr(n, 'width');
        if (w != null) {
          removeAttr(n, 'width');
          setAttr(n, 'style', (attr(n, 'style') ? attr(n, 'style') + ';' : '') + 'width:' + w);
        }
      }
      if (n.name === 'mtable') {
        const w = attr(n, 'width');
        if (w != null) {
          removeAttr(n, 'width');
          setAttr(n, 'style', (attr(n, 'style') ? attr(n, 'style') + ';' : '') + 'width:' + w);
        }
        // KaTeX gives some rows of an aligned display (those after a line
        // break) the empty cells of numbered rows while others have none,
        // which shifts their columns; take those cells out.
        const rows = n.kids.filter((r) => r.name === 'mtr');
        const glued = rows.filter((r) => { const c = r.kids.find((x) => x.name === 'mtd'); return c && hasClass(c, 'mtr-glue'); });
        if (glued.length && glued.length < rows.length) {
          for (const r of glued) r.kids = r.kids.filter((c) => !(c.name === 'mtd' && (hasClass(c, 'mtr-glue') || hasClass(c, 'mml-eqn-num')) && !c.kids.length));
        }
        const ca = attr(n, 'columnalign');
        if (ca) {
          const al = ca.trim().split(/\s+/);
          for (const row of n.kids) {
            if (row.name !== 'mtr' && row.name !== 'mlabeledtr') continue;
            let i = 0;
            for (const cell of row.kids) {
              if (cell.name !== 'mtd') continue;
              const a = attr(cell, 'columnalign') || al[Math.min(i, al.length - 1)];
              i++;
              if (/^(left|right|center)$/.test(a)) setAttr(cell, 'style', (attr(cell, 'style') ? attr(cell, 'style') + ';' : '') + 'text-align:' + a);
            }
          }
        }
      }
      for (const k of n.kids || []) if (k.name) visit(k, variant);
    })(math, null);
  }

  // ---------------------------------------------------------------------------
  // Chapters, contents and the package
  // ---------------------------------------------------------------------------

  /** Split the top level of the tree into chapters at the document's top sections. */
  function chapters(root, toc) {
    const ids = new Set();
    const levels = (toc || []).map((t) => t.level);
    const topLevel = levels.length ? Math.min(...levels) : 2;
    for (const t of toc || []) if (t.level === topLevel) ids.add(t.id);
    const parts = [{ nodes: [], title: null }];
    for (const k of root.kids) {
      const id = k.name && attr(k, 'id');
      const isBib = k.name === 'section' && hasClass(k, 'bibliography');
      if (k.name === 'section' && hasClass(k, 'footnotes')) {
        parts.push({ nodes: [k], title: 'Notes', notes: true });
        continue;
      }
      if ((id && ids.has(id)) || isBib) {
        parts.push({ nodes: [k], title: isBib ? textOf(find(k, (x) => /^h\d$/.test(x.name)) || text('References')).trim() || 'References' : null, id: isBib ? null : id, bib: isBib });
      } else {
        parts[parts.length - 1].nodes.push(k);
      }
    }
    // An empty opening part (nothing but white space before the first section) is dropped.
    if (!parts[0].nodes.some((k) => k.name || /\S/.test(k.text))) parts.shift();
    return parts;
  }

  /** The text of a contents entry: tags gone, a formula as its TeX. */
  function plainTitle(html) {
    const t = parse(html || '');
    (function strip(n) {
      n.kids = n.kids.map((k) => {
        if (k.name && (hasClass(k, 'katex') || hasClass(k, 'katex-display'))) {
          const ann = find(k, (x) => x.name === 'annotation');
          return text(ann ? textOf(ann).trim() : textOf(k));
        }
        if (k.name) strip(k);
        return k;
      });
    })(t);
    return textOf(t).replace(/\s+/g, ' ').trim();
  }

  /** The <li>s of a nested list of contents entries { level, label, href }. */
  function navList(entries) {
    let out = '';
    let i = 0;
    (function list(level) {
      out += '<ol>';
      while (i < entries.length && entries[i].level >= level) {
        const e = entries[i++];
        out += `<li><a href="${escAttr(e.href)}">${escText(e.label)}</a>`;
        if (i < entries.length && entries[i].level > e.level) list(entries[i].level);
        out += '</li>';
      }
      out += '</ol>';
    })(entries.length ? entries[0].level : 1);
    return out;
  }

  function ncxPoints(entries) {
    let out = '';
    let i = 0;
    let order = 0;
    (function list(level, pad) {
      while (i < entries.length && entries[i].level >= level) {
        const e = entries[i++];
        out += `${pad}<navPoint id="np${++order}" playOrder="${order}"><navLabel><text>${escText(e.label)}</text></navLabel><content src="${escAttr(e.href)}"/>\n`;
        if (i < entries.length && entries[i].level > e.level) list(entries[i].level, pad + '  ');
        out += `${pad}</navPoint>\n`;
      }
    })(entries.length ? entries[0].level : 1, '    ');
    return out;
  }

  // A stable identifier for the book, from its title and text: the same paper
  // exported again replaces itself in a library rather than becoming a second book.
  function bookId(seed) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    let h3 = 0x9e3779b9;
    let h4 = 0x85ebca6b;
    for (let i = 0; i < seed.length; i++) {
      const c = seed.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ c, 2246822507);
      h3 = Math.imul(h3 ^ c, 3266489909);
      h4 = Math.imul(h4 ^ c, 668265263);
    }
    const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
    return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  const MEDIA = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  };
  // EPUB's core media types: anything else an e-reader need not show.
  const CORE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']);
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp' };

  /** The image type of some bytes, by their first bytes, or null. */
  function sniff(b) {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    const head = String.fromCharCode.apply(null, Array.from(b.subarray(0, 512)));
    if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
    return null;
  }

  /** Bytes of a data: URL, with its media type, or null. */
  function fromDataUrl(url) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(url);
    if (!m) return null;
    let bytes;
    if (m[3]) bytes = base64Bytes(m[4]);
    else bytes = utf8(decodeURIComponent(m[4]));
    return { data: bytes, type: (m[1] || 'text/plain').toLowerCase() };
  }
  function base64Bytes(b64) {
    const s = b64.replace(/[^A-Za-z0-9+/]/g, '');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const utf8 = (s) => new TextEncoder().encode(s);

  // The e-book's own stylesheet: the document's look without the viewer's
  // colours, which belong to the e-reader (its day, sepia and night modes).
  const BOOK_CSS = `@charset "utf-8";
body { margin: 0 4%; line-height: 1.5; hyphens: auto; -webkit-hyphens: auto; overflow-wrap: break-word; }
p { margin: 0 0 0.8em; }
a { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; }
a.ref, .cite a, sup.fn a, a.fn-back { border-bottom: 0; }
a.ref, .cite a { text-decoration: underline; text-decoration-style: dotted; }
.title-block { text-align: center; margin: 2em 0 2.2em; }
.doc-title { font-size: 1.7em; line-height: 1.2; margin: 0.4em 0 0.6em; font-weight: bold; }
.authors { font-variant: small-caps; font-size: 1.05em; }
.author { display: inline-block; margin: 0 0.8em; }
.doc-date { margin-top: 0.4em; }
h1, h2, h3, h4 { line-height: 1.3; font-weight: bold; page-break-after: avoid; break-after: avoid; }
h1.chapter { font-size: 1.7em; margin: 1.5em 0 0.8em; }
h1.part { font-size: 1.9em; text-align: center; margin: 2em 0 1em; }
h2 { font-size: 1.35em; margin: 1.4em 0 0.6em; }
h3 { font-size: 1.15em; margin: 1.3em 0 0.5em; }
h4 { font-size: 1em; margin: 1.2em 0 0.4em; }
.secnum { margin-right: 0.7em; }
.run-in { margin-right: 0.4em; }
.abstract { margin: 0 1.5em 2em; font-size: 0.95em; }
.abstract-title { text-align: center; font-weight: bold; font-variant: small-caps; margin-bottom: 0.4em; }
.keywords { margin: 0 1.5em 0.4em; font-size: 0.95em; }
.keywords-head { font-variant: small-caps; margin-right: 0.3em; }
nav.toc { margin: 0 0 2em; }
nav.toc h2 { font-size: 1.05em; margin: 0 0 0.4em; }
nav.toc ul { list-style: none; margin: 0; padding: 0; }
nav.toc li { margin: 0.15em 0; }
nav.toc .toc-l3 { padding-left: 1.5em; }
nav.toc .toc-l4 { padding-left: 3em; }
.toc-num { display: inline-block; min-width: 2.2em; }
.theorem { margin: 1.2em 0; padding: 0 0 0 0.8em; border-left: 3px solid currentColor; }
.thm-definition { border-left-style: double; }
.thm-remark { border-left: 0; padding-left: 0; }
.thm-plain p { font-style: italic; }
.thm-plain .item-label, .thm-plain .thm-head, .thm-plain .ref, .thm-plain .thm-head .thm-note { font-style: normal; }
.thm-head .thm-name { font-weight: bold; }
.thm-remark .thm-head .thm-name { font-weight: normal; font-style: italic; }
.thm-head-only { margin-bottom: 0.3em; }
.proof { margin: 0.6em 0 1.4em; }
.proof-head { font-style: italic; }
.qed { float: right; margin-left: 1em; }
.qed-line { overflow: hidden; margin: 0; }
math { font-family: "STIX Two Math", "Cambria Math", "Latin Modern Math", "STIX Math", math; }
.math-display { margin: 0.8em 0; overflow-x: auto; overflow-y: hidden; text-align: center; }
math[display="block"] { margin: 0.4em 0; overflow-x: auto; overflow-y: hidden; }
.math-error, .math-src { font-family: monospace; font-size: 0.85em; }
.ref-missing { font-weight: bold; }
.cite-key { font-family: monospace; font-size: 0.85em; }
.center { text-align: center; }
.flushright { text-align: right; }
.flushleft { text-align: left; }
blockquote { margin: 1em 1.5em; }
code, pre { font-family: monospace; font-size: 0.85em; }
pre.verbatim { padding: 0.6em 0; overflow-x: auto; line-height: 1.4; white-space: pre-wrap; }
.sc { font-variant: small-caps; }
.sf { font-family: sans-serif; }
.fbox { border: 1px solid currentColor; padding: 0 0.2em; }
.latex-logo sup { font-size: 0.75em; vertical-align: 0.25em; margin-left: -0.3em; margin-right: -0.12em; }
.latex-logo sub { font-size: 1em; vertical-align: -0.5ex; margin-left: -0.1667em; margin-right: -0.125em; text-transform: uppercase; }
.size-tiny { font-size: 0.5em; } .size-scriptsize { font-size: 0.7em; } .size-footnotesize { font-size: 0.8em; }
.size-small { font-size: 0.9em; } .size-large { font-size: 1.2em; } .size-Large { font-size: 1.44em; }
.size-LARGE { font-size: 1.73em; } .size-huge, .size-Huge { font-size: 2em; }
.list { list-style: none; padding: 0; margin: 0 0 0.8em; }
.list .item { margin: 0.25em 0; padding-left: 2.2em; text-indent: 0; }
.item-label { display: inline-block; min-width: 1.6em; margin-left: -2.2em; margin-right: 0.6em; text-align: right; }
.description .item { padding-left: 0; }
.description .item-label { font-weight: bold; min-width: 0; margin-left: 0; text-align: left; }
.item-body > p:first-child { display: inline; }
.item-body > p:last-child { margin-bottom: 0; }
.list .list { margin-top: 0.25em; }
.float { margin: 1.5em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
.caption { font-size: 0.93em; margin-top: 0.5em; }
.caption-head { font-weight: bold; }
.table-wrap { overflow-x: auto; }
.tabular { border-collapse: collapse; margin: 0 auto; }
.tabular td { padding: 0.25em 0.8em; border-top: 1px solid currentColor; border-bottom: 1px solid currentColor; }
img.graphic, .graphic { max-width: 100%; height: auto; }
.graphic-placeholder { display: inline-block; padding: 1em 1.5em; border: 1px dashed currentColor; font-size: 0.85em; font-family: monospace; }
.bibliography ol { list-style: none; padding: 0; }
.bibliography li { margin: 0.4em 0; padding-left: 2.5em; text-indent: -2.5em; }
.bib-label { margin-right: 0.6em; }
.footnotes { margin-top: 3em; border-top: 1px solid currentColor; padding-top: 0.6em; font-size: 0.9em; }
.footnotes ol { padding-left: 1.4em; }
.fn { line-height: 0; }
.fn-back { margin-left: 0.3em; }
.tg-diagram { display: block; margin: 0.8em 0; text-align: center; overflow-x: auto; overflow-y: hidden; position: relative; }
.math-inline .tg-diagram, .diagram-display .tg-diagram, .float .tg-diagram { display: inline-block; margin: 0; vertical-align: middle; max-width: 100%; }
.tg-diagram.tg-tree { display: inline; margin: 0; overflow: visible; }
.cd-wrap { display: inline-block; position: relative; vertical-align: middle; text-align: left; }
.cd-grid { display: inline-grid; align-items: center; justify-items: center; vertical-align: middle; }
.cd-cell { display: block; }
.cd-node { display: inline-block; padding: 0.1em 0.32em; white-space: nowrap; }
.cd-node.cd-empty { padding: 0; width: 0; height: 0; }
.cd-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.cd-label { position: absolute; left: 0; top: 0; visibility: hidden; white-space: nowrap; line-height: 1.1; padding: 0.04em 0.06em; }
.cd-label.cd-desc { padding: 0.08em 0.16em; }
.diagram-row { display: inline-flex; align-items: center; max-width: 100%; }
.tikz-wrap { display: inline-block; position: relative; vertical-align: middle; text-align: left; isolation: isolate; transform-origin: 0 0; }
.tikz-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.tikz-node { position: absolute; left: 0; top: 0; white-space: nowrap; line-height: 1.2; visibility: hidden; }
.tikz-node.tikz-multi { white-space: normal; text-align: center; }
.tikz-node.tikz-under { z-index: -1; line-height: 0; }
.tikz-node img.graphic { max-width: none; }
.tikz-note { display: block; font-size: 0.75em; margin-top: 0.3em; }
.tikz-fallback { text-align: left; display: inline-block; max-width: 100%; }
.tikz-fallback pre { font-size: 0.8em; margin: 0.4em 0 0; }
.theorem, .math-display, .tg-diagram, .title-block { page-break-inside: avoid; break-inside: avoid; }
`;

  /** KaTeX's stylesheet for the book: only the woff2 fonts, as files beside it. */
  function katexForBook(css) {
    const fonts = new Set();
    const out = css.replace(/src:([^;}]*)/g, (all, list) => {
      const m = /url\(["']?(?:\.\/)?fonts\/(KaTeX_[\w-]+\.woff2)["']?\)\s*format\(["']woff2["']\)/.exec(list);
      if (!m) return all;
      fonts.add(m[1]);
      return `src:url(fonts/${m[1]}) format("woff2")`;
    });
    return { css: out, fonts: [...fonts] };
  }

  function xhtmlPage({ title, lang, body, css, scripts, epubType }) {
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" lang="${escAttr(lang)}" xml:lang="${escAttr(lang)}">
<head>
<meta charset="utf-8"/>
<title>${escText(title)}</title>
${css.map((h) => `<link rel="stylesheet" type="text/css" href="${escAttr(h)}"/>`).join('\n')}
${(scripts || []).map((h) => `<script src="${escAttr(h)}"></script>`).join('\n')}
</head>
<body${epubType ? ` epub:type="${epubType}"` : ''}>
<div class="document">
${body}
</div>
</body>
</html>
`;
  }

  /**
   * The book, as the bytes of a .epub file.
   *   body          the document's HTML (render().html, or the same HTML with
   *                 its diagrams drawn: see diagramsDrawn)
   *   title         the book's title
   *   authors       its authors (else read from the title block)
   *   lang          language code (default 'en')
   *   toc           render().toc, for the contents and the chapters
   *   modified      a Date (default now)
   *   katexCss      KaTeX's stylesheet (katex.min.css), needed for diagrams
   *   readFont      (name) => bytes (Uint8Array, or a promise) of a KaTeX font
   *   readImage     (src) => { data, type } (or a promise) of a figure, null to leave it out
   *   diagramsDrawn true when the diagrams in body are drawn already
   *   diagramsJs    src/diagrams.js, put in the book when they are not
   *   deflate       (bytes) => compressed bytes (raw deflate) or a promise;
   *                 by default zlib in Node, CompressionStream in browsers
   *   warn          (message) => void, for what had to be left out
   * Returns a promise of { bytes: Uint8Array, warnings: [string] }.
   */
  async function build(opts) {
    const warnings = [];
    const warn = (m) => { warnings.push(m); if (opts.warn) opts.warn(m); };
    const lang = opts.lang || 'en';
    const root = parse(opts.body || '');
    const found = prepare(root, {
      keepDiagramData: !opts.diagramsDrawn && !!opts.diagramsJs,
    });

    // Title and authors
    const titleBlock = find(root, (n) => hasClass(n, 'title-block'));
    let authors = opts.authors;
    if (!authors && titleBlock) {
      authors = [];
      walk(titleBlock, (n) => {
        if (!hasClass(n, 'author')) return true;
        const copy = JSON.parse(JSON.stringify(n));
        (function strip(x) { x.kids = x.kids.filter((k) => !(k.name && (k.name === 'sup' || hasClass(k, 'thanks') || hasClass(k, 'affil') || hasClass(k, 'author-note')))); x.kids.forEach((k) => k.name && strip(k)); })(copy);
        const t = textOf(copy).replace(/\s+/g, ' ').trim();
        if (t) authors.push(t);
        return false;
      });
    }
    const title = (opts.title || 'Document').replace(/\s+/g, ' ').trim();

    // Images: into the book, under images/
    const files = []; // { path, data (bytes or string), type, id, props }
    const byUrl = new Map();
    let imgN = 0;
    for (const img of found.images) {
      const src = attr(img, 'src');
      if (!src) continue;
      if (!byUrl.has(src)) {
        let got = null;
        try {
          if (/^data:/i.test(src)) got = fromDataUrl(src);
          else if (opts.readImage) got = await opts.readImage(src);
        } catch (e) { got = null; }
        if (got && got.data && !CORE_IMAGE.has(got.type)) {
          const ext = (/\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src) || [])[1];
          got.type = sniff(got.data) || MEDIA[(ext || '').toLowerCase()] || got.type || '';
        }
        if (got && got.data && CORE_IMAGE.has(got.type)) {
          const path = `images/img${++imgN}.${EXT[got.type]}`;
          files.push({ path, data: got.data, type: got.type, id: 'img' + imgN });
          byUrl.set(src, path);
        } else {
          byUrl.set(src, null);
          warn(`Left out a figure that could not be read or is not PNG, JPEG, GIF, SVG or WebP: ${src.startsWith('data:') ? src.slice(0, 30) + '…' : src}`);
        }
      }
      const path = byUrl.get(src);
      if (path) setAttr(img, 'src', path);
      else {
        // a figure the book cannot hold: say what it was
        img.name = 'span';
        const alt = attr(img, 'alt');
        img.attrs = [['class', 'graphic-placeholder']];
        img.kids = [text(alt || '[figure: ' + src.replace(/^.*\//, '').replace(/[?#].*$/, '').slice(0, 80) + ']')];
      }
    }

    // Chapters, and where each id lives
    const parts = chapters(root, opts.toc);
    const where = new Map();
    parts.forEach((p, i) => {
      p.file = `c${String(i).padStart(2, '0')}.xhtml`;
      for (const k of p.nodes) {
        if (!k.name) continue;
        const id = attr(k, 'id');
        if (id && !where.has(id)) where.set(id, p.file);
        walk(k, (n) => {
          const id2 = attr(n, 'id');
          if (id2 && !where.has(id2)) where.set(id2, p.file);
        });
      }
    });
    // Links between chapters; links to ids that are nowhere lose their href.
    parts.forEach((p) => {
      for (const k of p.nodes) {
        if (!k.name) continue;
        const fix = (n) => {
          if (n.name !== 'a') return true;
          const h = attr(n, 'href');
          if (!h || h[0] !== '#') return true;
          const id = h.slice(1);
          const f = where.get(id) || where.get(decodeURIComponent(id));
          if (!f) removeAttr(n, 'href');
          else if (f !== p.file) setAttr(n, 'href', f + h);
          return true;
        };
        fix(k);
        walk(k, (n) => (n.name === 'svg' ? false : fix(n)));
      }
    });

    // Stylesheets and scripts
    const css = ['book.css'];
    files.push({ path: 'book.css', data: BOOK_CSS, type: 'text/css', id: 'css' });
    const needKatex = found.katex && opts.katexCss;
    if (found.katex && !opts.katexCss) warn('Diagrams with formulas need KaTeX\'s stylesheet; they may look wrong.');
    if (needKatex) {
      const k = katexForBook(opts.katexCss);
      let ok = true;
      const fontFiles = [];
      for (const name of k.fonts) {
        let data = null;
        try { data = opts.readFont ? await opts.readFont(name) : null; } catch (e) { data = null; }
        if (!data) { ok = false; break; }
        fontFiles.push({ path: 'fonts/' + name, data: typeof data === 'string' ? base64Bytes(data) : data, type: 'font/woff2', id: 'f-' + name.replace(/\W/g, '-') });
      }
      if (ok) {
        files.push({ path: 'katex.css', data: k.css, type: 'text/css', id: 'katex-css' }, ...fontFiles);
        css.unshift('katex.css');
      } else {
        warn('KaTeX\'s fonts could not be read; formulas inside diagrams may look wrong.');
      }
    }
    const scripted = found.diagrams && !opts.diagramsDrawn && !!opts.diagramsJs;
    if (scripted) files.push({ path: 'diagrams.js', data: opts.diagramsJs, type: 'application/javascript', id: 'diagrams-js' });
    if (found.diagrams && !opts.diagramsDrawn && !opts.diagramsJs) warn('Diagrams are not drawn: their arrows are missing.');

    // The chapter files
    const spine = [];
    parts.forEach((p, i) => {
      const body = p.nodes.map((k) => serialize(k)).join('');
      const hasSvg = /<svg[\s>]/.test(body);
      const hasMath = /<math[\s>]/.test(body);
      const hasDiagram = /class="[^"]*\btg-diagram\b/.test(body);
      const label = p.title || (p.id && (opts.toc || []).find((t) => t.id === p.id) ? plainTitle((opts.toc.find((t) => t.id === p.id) || {}).title) : (i === 0 ? title : `Part ${i}`));
      const props = [];
      if (hasMath) props.push('mathml');
      if (hasSvg) props.push('svg');
      if (scripted && hasDiagram) props.push('scripted');
      files.push({
        path: p.file,
        data: xhtmlPage({ title: label || title, lang, body, css: /class="katex"/.test(body) ? css : css.filter((c) => c !== 'katex.css'), scripts: scripted && hasDiagram ? ['diagrams.js'] : [], epubType: p.bib ? 'bibliography' : p.notes ? 'footnotes' : null }),
        type: 'application/xhtml+xml',
        id: 'c' + i,
        props,
      });
      spine.push('c' + i);
    });

    // Contents: the title page, every section in the document's contents, the references
    const entries = [];
    if (parts.length && !parts[0].id && !parts[0].bib) entries.push({ level: 1, label: title, href: parts[0].file });
    const levels = (opts.toc || []).map((t) => t.level);
    const base = levels.length ? Math.min(...levels) : 1;
    for (const t of opts.toc || []) {
      const f = where.get(t.id);
      if (!f) continue;
      const label = [t.num, plainTitle(t.title)].filter(Boolean).join(' ');
      entries.push({ level: t.level - base + 1, label: label || 'Section', href: f + (parts.some((p) => p.id === t.id) ? '' : '#' + t.id) });
    }
    parts.forEach((p) => { if (p.bib || p.notes) entries.push({ level: 1, label: p.title || 'References', href: p.file }); });
    // A contents list must start at its top level.
    if (entries.length && entries[0].level > 1) entries.forEach((e) => { e.level = Math.max(1, e.level - entries[0].level + 1); });
    if (!entries.length && parts.length) entries.push({ level: 1, label: title, href: parts[0].file });

    const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" lang="${escAttr(lang)}" xml:lang="${escAttr(lang)}">
<head>
<meta charset="utf-8"/>
<title>${escText(title)}</title>
<link rel="stylesheet" type="text/css" href="book.css"/>
</head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1>
${navList(entries)}
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden"><ol>
<li><a epub:type="toc" href="nav.xhtml">Contents</a></li>
${parts.length ? `<li><a epub:type="bodymatter" href="${parts[0].file}">${escText(title)}</a></li>` : ''}
</ol></nav>
</body>
</html>
`;
    files.push({ path: 'nav.xhtml', data: nav, type: 'application/xhtml+xml', id: 'nav', props: ['nav'] });

    const id = opts.identifier || bookId(title + '\n' + (opts.body || '').length + '\n' + (opts.body || '').slice(0, 4000));
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escAttr(lang)}">
  <head>
    <meta name="dtb:uid" content="${escAttr(id)}"/>
    <meta name="dtb:depth" content="${Math.max(1, ...entries.map((e) => e.level))}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escText(title)}</text></docTitle>
  <navMap>
${ncxPoints(entries)}  </navMap>
</ncx>
`;
    files.push({ path: 'toc.ncx', data: ncx, type: 'application/x-dtbncx+xml', id: 'ncx' });

    const modified = (opts.modified instanceof Date ? opts.modified : new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${escAttr(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${escText(id)}</dc:identifier>
    <dc:title>${escText(title)}</dc:title>
    <dc:language>${escText(lang)}</dc:language>
${(authors || []).map((a, i) => `    <dc:creator id="creator${i + 1}">${escText(a)}</dc:creator>`).join('\n')}${authors && authors.length ? '\n' : ''}    <meta property="dcterms:modified">${modified}</meta>
    <meta name="generator" content="TeXglass"/>
  </metadata>
  <manifest>
${files.map((f) => `    <item id="${f.id}" href="${escAttr(f.path)}" media-type="${f.type}"${f.props && f.props.length ? ` properties="${f.props.join(' ')}"` : ''}/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.map((s) => `    <itemref idref="${s}"/>`).join('\n')}
  </spine>
</package>
`;
    const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
    const entriesZip = [
      { name: 'mimetype', data: utf8('application/epub+zip'), store: true },
      { name: 'META-INF/container.xml', data: utf8(container) },
      { name: 'OEBPS/content.opf', data: utf8(opf) },
      ...files.map((f) => ({ name: 'OEBPS/' + f.path, data: typeof f.data === 'string' ? utf8(f.data) : f.data, store: /^(image\/(png|jpeg|gif|webp)|font\/)/.test(f.type) })),
    ];
    const bytes = await zip(entriesZip, opts.deflate || defaultDeflate(), opts.modified);
    return { bytes, warnings };
  }

  // ---------------------------------------------------------------------------
  // ZIP
  // ---------------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Raw deflate where the platform has it: zlib in Node, CompressionStream in browsers; else none (stored). */
  function defaultDeflate() {
    if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof require === 'function') {
      try {
        const zlib = require('zlib');
        return (b) => new Uint8Array(zlib.deflateRawSync(b, { level: 9 }));
      } catch (e) { /* fall through */ }
    }
    if (typeof CompressionStream === 'function') {
      return async (b) => {
        try {
          const s = new Blob([b]).stream().pipeThrough(new CompressionStream('deflate-raw'));
          return new Uint8Array(await new Response(s).arrayBuffer());
        } catch (e) {
          return null;
        }
      };
    }
    return null;
  }

  /** A ZIP file of entries { name, data: Uint8Array, store }. The first is written first and stored (EPUB's mimetype). */
  async function zip(entries, deflate, date) {
    const d = date instanceof Date ? date : new Date();
    const dosTime = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    const dosDate = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const name = utf8(e.name);
      const crc = crc32(e.data);
      let body = e.data;
      let method = 0;
      if (!e.store && deflate && e.data.length > 64) {
        const z = await deflate(e.data);
        if (z && z.length < e.data.length) { body = z; method = 8; }
      }
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // names are UTF-8
      local.setUint16(8, method, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, body.length, true);
      local.setUint32(22, e.data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, body);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, method, true);
      c.setUint16(12, dosTime, true);
      c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, body.length, true);
      c.setUint32(24, e.data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + body.length;
    }
    const centralSize = central.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
    let p = 0;
    for (const b of all) { out.set(b, p); p += b.length; }
    return out;
  }

  // ---------------------------------------------------------------------------
  // In a browser page: draw the diagrams before they go into the book
  // ---------------------------------------------------------------------------

  const DRAW_BG = 'rgb(1, 2, 3)'; // the page colour diagrams.js sees, to find again

  /**
   * The HTML of a document with its diagrams drawn, by src/diagrams.js (which
   * the page must have loaded), in a column about as wide as an e-reader's.
   * Sizes it sets in pixels become em, so the drawings grow with the reader's
   * font size, and the gaps behind arrow labels become transparent, so they
   * suit the reader's day and night colours. Browser only.
   */
  async function drawDiagrams(html, doc) {
    doc = doc || document;
    const box = doc.createElement('div');
    box.className = 'document';
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = `position:absolute;left:-30000px;top:0;width:560px;font-size:16px;line-height:1.5;background:${DRAW_BG};contain:layout`;
    box.innerHTML = html;
    doc.body.appendChild(box);
    try {
      const win = doc.defaultView || window;
      const frame = () => new Promise((r) => win.requestAnimationFrame(() => r()));
      if (win.TeXglassDiagrams) win.TeXglassDiagrams.observe(box);
      if (doc.fonts && doc.fonts.ready) await doc.fonts.ready;
      await frame();
      await frame();
      if (win.TeXglassDiagrams) win.TeXglassDiagrams.observe(box);
      emify(box, win);
      return box.innerHTML.split(DRAW_BG).join('transparent');
    } finally {
      box.remove();
    }
  }

  /** Inline pixel sizes inside drawn diagrams as em of each element's own font size. */
  function emify(root, win) {
    const PX = /(-?[\d.]+)px/g;
    for (const wrap of root.querySelectorAll('.cd-wrap, .tikz-wrap')) {
      for (const e of [wrap, ...wrap.querySelectorAll('[style], svg')]) {
        const fs = parseFloat(win.getComputedStyle(e).fontSize) || 16;
        const em = (v) => `${Math.round((parseFloat(v) / fs) * 10000) / 10000}em`;
        if (e.namespaceURI === NS.svg && e.tagName.toLowerCase() === 'svg') {
          for (const a of ['width', 'height']) {
            const v = e.getAttribute(a);
            if (v && /^[\d.]+(px)?$/.test(v) && !e.style[a]) e.style[a] = em(v);
          }
        }
        const st = e.getAttribute('style');
        if (!st || st.indexOf('px') < 0) continue;
        // positions, sizes and clip insets; not the line widths of SVG strokes
        e.setAttribute('style', st.replace(/(^|;)\s*(left|top|width|height|clip-path|padding|margin-left|margin-top)\s*:([^;]*)/g,
          (all, sep, prop, val) => `${sep}${prop}:${val.replace(PX, (m, n) => em(n))}`));
      }
    }
  }

  /** A file name for the book: the source's name with .epub, or the title's. */
  function fileName(sourceName, title) {
    const base = sourceName
      ? sourceName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
      : (title || 'document').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
    return (base || 'document') + '.epub';
  }

  return { build, drawDiagrams, fileName, parse, serialize, prepare, chapters, zip, crc32, katexForBook, BOOK_CSS };
});
