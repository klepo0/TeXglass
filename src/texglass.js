/*
 * TeXglass — render LaTeX documents to HTML, the way a Markdown previewer
 * renders Markdown.
 *
 * The converter is a small, forgiving, single-file LaTeX-to-HTML translator.
 * It does not try to be TeX: it understands the commands that matter for
 * reading mathematical writing (sectioning, math, theorem-like environments,
 * \label/\ref, lists, footnotes, bibliographies, simple tables) and falls back
 * to showing the content of anything it does not know.
 *
 * Math is handed to a pluggable `renderMath(tex, displayMode, macros)`
 * function (KaTeX in the browser and in the CLI).
 *
 * Cross references are resolved with two passes: the first pass numbers
 * everything and collects labels, citations and the table of contents; the
 * second pass renders with that information, so forward references work.
 *
 * Works in the browser (window.TeXglass) and in Node (require).
 */
(function (root, factory) {
  // The BibTeX reader (src/bib.js) is looked up when needed, so it may load after this file.
  if (typeof module === 'object' && module.exports) module.exports = factory(() => require('./bib.js'));
  else root.TeXglass = factory(() => root.TeXglassBib);
})(typeof self !== 'undefined' ? self : this, function (loadBib) {
  'use strict';

  /** src/bib.js, or null where it is not available. */
  const bibReader = () => {
    try {
      return (loadBib && loadBib()) || null;
    } catch (e) {
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  /** A data-tex attribute holding a formula's LaTeX as written, for copying it from the page. */
  const texAttr = (tex) => {
    const t = String(tex).replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b[ \t]*/g, '').replace(/[ \t]+$/gm, '').trim();
    return t ? ` data-tex="${escapeHtml(t)}"` : '';
  };

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const stripTags = (html) =>
    String(html)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');

  const isLetter = (c) => c !== undefined && /[A-Za-z@]/.test(c);

  /** The diagram module (src/tikz.js), if it is loaded. */
  function tikz() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try { return require('./tikz.js'); } catch (e) { return null; }
    }
    return typeof self !== 'undefined' && self.TeXglassTikz ? self.TeXglassTikz : null;
  }

  const DIAGRAM_RE = /\\begin\s*\{(tikzcd|tikzpicture)\}|\\xymatrix(?![A-Za-z])/;

  /** Where the diagram starting at match m of DIAGRAM_RE in s ends. */
  function diagramEnd(s, m) {
    const at = m.index + m[0].length;
    if (m[1]) return findEnvEnd(s, at, m[1]).end;
    const open = s.indexOf('{', at);
    if (open < 0) return s.length;
    let depth = 0;
    for (let k = open; k < s.length; k++) {
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === '{') depth++;
      else if (s[k] === '}' && --depth === 0) return k + 1;
    }
    return s.length;
  }

  /**
   * A piece of math cut out from around a diagram may hold half of a group
   * (\fbox{ … }, \left( … \right)); drop the unmatched halves.
   */
  function balanceMath(t) {
    const drop = new Set();
    const open = [];
    for (let k = 0; k < t.length; k++) {
      if (t[k] === '\\') { k++; continue; }
      if (t[k] === '{') open.push(k);
      else if (t[k] === '}') { if (open.length) open.pop(); else drop.add(k); }
    }
    for (const k of open) drop.add(k);
    let out = '';
    for (let k = 0; k < t.length; k++) if (!drop.has(k)) out += t[k];
    if (open.length) out = out.replace(/\\(fbox|mbox|hbox|vbox|vcenter|text|boxed|raisebox|scalebox|resizebox|makebox|framebox|colorbox)\s*(\{[^{}]*\}\s*|\[[^\]]*\]\s*)*$/, '');
    // row and column breaks belonged to an outer layout
    if (!/\\begin\b/.test(out)) out = out.replace(/\\\\(\s*\[[^\]]*\])?/g, ' ').replace(/(^|[^\\])&/g, '$1 ');
    const lefts = (out.match(/\\left(?![a-z])/g) || []).length;
    const rights = (out.match(/\\right(?![a-z])/g) || []).length;
    if (lefts !== rights) out = out.replace(/\\(left|right)(?![a-z])\s*\.?/g, '');
    return out;
  }

  /**
   * Remove wrappers such as \begin{array}{c} … \end{array} or gathered around
   * diagrams (they would be cut in half), turning their row breaks into spaces.
   */
  function unwrapDiagrams(tex) {
    const re = /\\begin\s*\{(array|gathered|aligned|matrix|split)(\*?)\}/g;
    let m;
    for (let guard = 0; guard < 50 && (m = re.exec(tex)); guard++) {
      const name = m[1] + m[2];
      const e = findEnvEnd(tex, m.index + m[0].length, name);
      let body = tex.slice(m.index + m[0].length, e.contentEnd);
      if (!DIAGRAM_RE.test(body)) continue;
      if (m[1] === 'array') body = body.replace(/^\s*\{[^}]*\}/, '');
      // row breaks outside the diagrams become spaces
      let out = '';
      let rest = body;
      for (let d; (d = DIAGRAM_RE.exec(rest)); ) {
        const end = diagramEnd(rest, d);
        out += rest.slice(0, d.index).replace(/\\\\(\[[^\]]*\])?|&/g, ' ') + rest.slice(d.index, end);
        rest = rest.slice(end);
      }
      out += rest.replace(/\\\\(\[[^\]]*\])?|&/g, ' ');
      tex = tex.slice(0, m.index) + out + tex.slice(e.end);
      re.lastIndex = m.index;
    }
    return tex;
  }

  /** Element id for a \hypertarget name. */
  function hyperId(name) {
    return 'ht-' + name.trim().replace(/\s+/g, '-');
  }

  function safeUrl(url) {
    const u = String(url).trim();
    if (/^(https?:|mailto:|#|\.{0,2}\/)/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '#';
  }

  function alpha(n, upper) {
    let s = '';
    while (n > 0) {
      n--;
      s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26);
    }
    return upper ? s.toUpperCase() : s;
  }

  function roman(n, upper) {
    if (n <= 0) return String(n);
    const table = [
      [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
      [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
    ];
    let s = '';
    for (const [v, r] of table) while (n >= v) { s += r; n -= v; }
    return upper ? s.toUpperCase() : s;
  }

  /**
   * Remove % comments, keeping \% and verbatim-like environments intact.
   * Returns the stripped text and, for each of its characters, the index of
   * that character in the original source (plus one final entry for the end).
   */
  function stripCommentsMap(src) {
    const verb = /\\begin\{(verbatim\*?|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}/g;
    const out = [];
    const map = [];
    const copy = (from, to) => {
      for (let k = from; k < to; k++) { out.push(src[k]); map.push(k); }
    };
    const plain = (from, to) => {
      let i = from;
      while (i < to) {
        const c = src[i];
        if (c === '\\' && i + 1 < to) { copy(i, i + 2); i += 2; continue; }
        if (c === '%') {
          // A comment also swallows the newline and the next line's indentation.
          let j = src.indexOf('\n', i);
          if (j < 0 || j >= to) { i = to; continue; }
          j++;
          while (j < to && (src[j] === ' ' || src[j] === '\t')) j++;
          i = j;
          continue;
        }
        copy(i, i + 1);
        i++;
      }
    };
    let last = 0;
    let m;
    while ((m = verb.exec(src))) {
      plain(last, m.index);
      if (m[1] !== 'comment') copy(m.index, m.index + m[0].length);
      last = m.index + m[0].length;
    }
    plain(last, src.length);
    map.push(src.length);
    return { text: out.join(''), map };
  }

  function stripComments(src) {
    return stripCommentsMap(src).text;
  }

  /** Read a balanced {...} group starting at src[i] === '{'. */
  function readGroup(src, i) {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') { j++; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return { content: src.slice(i + 1, j), end: j + 1 };
      }
    }
    return { content: src.slice(i + 1), end: src.length };
  }

  /** Skip spaces and at most one newline (not a paragraph break). */
  function skipWhite(src, i) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
    if (src[i] === '\n') {
      let j = i + 1;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
      if (src[j] !== '\n') i = j;
    }
    return i;
  }

  /** Read a mandatory argument: {group}, \command, or a single character. */
  function readArg(src, i) {
    i = skipWhite(src, i);
    if (src[i] === '{') return readGroup(src, i);
    if (src[i] === '\\') {
      let j = i + 1;
      if (isLetter(src[j])) while (isLetter(src[j])) j++;
      else j++;
      return { content: src.slice(i, j), end: j };
    }
    if (i >= src.length) return { content: '', end: i };
    return { content: src[i], end: i + 1 };
  }

  /** Read an optional [argument]; returns null if there is none. */
  function readOpt(src, i) {
    const j = skipWhite(src, i);
    if (src[j] !== '[') return null;
    let depth = 0;
    for (let k = j + 1; k < src.length; k++) {
      const c = src[k];
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ']' && depth === 0) return { content: src.slice(j + 1, k), end: k + 1 };
    }
    return null;
  }

  function readStar(src, i) {
    return src[i] === '*' ? { star: true, end: i + 1 } : { star: false, end: i };
  }

  /** Find the matching \end{name} for an environment whose body starts at `from`. */
  function findEnvEnd(src, from, name) {
    const re = /\\(begin|end)\s*\{([^}]*)\}/g;
    re.lastIndex = from;
    let depth = 1;
    let m;
    while ((m = re.exec(src))) {
      if (m[2] !== name) continue;
      if (m[1] === 'begin') depth++;
      else if (--depth === 0) return { contentEnd: m.index, end: m.index + m[0].length };
    }
    return { contentEnd: src.length, end: src.length };
  }

  /**
   * Split `src` at top level (outside braces and nested environments).
   * `sep(src, i)` returns the length of a separator at i, or 0.
   */
  function splitTop(src, sep) {
    const parts = [];
    let depth = 0;
    let envDepth = 0;
    let start = 0;
    for (let i = 0; i < src.length; i++) {
      if (depth === 0 && envDepth === 0) {
        const len = sep(src, i);
        if (len) {
          parts.push(src.slice(start, i));
          start = i + len;
          i = start - 1;
          continue;
        }
      }
      const c = src[i];
      if (c === '\\') {
        if (src.startsWith('\\begin', i) && !isLetter(src[i + 6])) envDepth++;
        else if (src.startsWith('\\end', i) && !isLetter(src[i + 4])) envDepth--;
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    parts.push(src.slice(start));
    return parts;
  }

  /** KaTeX macros for commands from common packages that KaTeX lacks. */
  const MATH_MACROS = {
    '\\hdots': '\\ldots',
    // \ensuremath{…} is just its argument once in math (user macros like
    // \newcommand{\R}{\ensuremath{\mathbb R}} used inside $…$); \xspace adds nothing there.
    '\\ensuremath': '#1',
    '\\xspace': '',
    '\\MoveEqLeft': '',
    '\\intertext': '\\text{#1}',
    '\\shortintertext': '\\text{#1}',
    // esint: the averaged integral ⨏
    '\\fint': '\\mathop{\\rlap{\\hspace{0.32em}\\raisebox{0.05em}{\\text{-}}}{\\int}}\\nolimits',
    '\\dashint': '\\fint',
    // a \label that reaches KaTeX through a user macro: drop it
    '\\label': (ctx) => { ctx.consumeArgs(1); return ''; },
    // bbm: \mathbbm{1} is the indicator 𝟙; KaTeX's \mathbb has no digits or small letters.
    '\\mathbbm': (ctx) => {
      const arg = ctx.consumeArgs(1)[0].slice().reverse().map((t) => t.text).join('');
      return Array.from(arg.replace(/\s+/g, ''))
        .map((c) => {
          if (/[0-9]/.test(c)) return `\\text{${String.fromCodePoint(0x1d7d8 + +c)}}`;
          if (/[a-z]/.test(c)) return `\\text{${String.fromCodePoint(0x1d552 + c.charCodeAt(0) - 97)}}`;
          return `\\mathbb{${c}}`;
        })
        .join('');
    },
  };
  MATH_MACROS['\\mathbbmss'] = MATH_MACROS['\\mathbbm'];
  // nicefrac / xfrac: a slanted fraction ¹⁄₂, with nicefrac's optional font argument ignored.
  const niceFrac = (ctx) => {
    ctx.consumeSpaces();
    if (ctx.future().text === '[') {
      for (let depth = 0; ;) {
        const t = ctx.popToken();
        if (t.text === 'EOF') break;
        if (t.text === '{') depth++;
        else if (t.text === '}') depth--;
        else if (t.text === ']' && depth === 0) break;
      }
    }
    return '\\texglassNiceFrac';
  };
  MATH_MACROS['\\nicefrac'] = niceFrac;
  MATH_MACROS['\\sfrac'] = niceFrac;
  MATH_MACROS['\\texglassNiceFrac'] = '{}^{#1}\\!/\\!{}_{#2}';
  // slashed (Feynman slash notation): a stroke through the argument.
  MATH_MACROS['\\slashed'] = '\\cancel{#1}';
  // mathtools: \adjustlimits\lim_a\sup_b only lines up the limits.
  MATH_MACROS['\\adjustlimits'] = '';
  // \mathpalette\cmd{x} calls \cmd with the current style, as in
  // \newcommand\dotop{\mathpalette\dotop@{.6}}; \m@th only resets \mathsurround.
  MATH_MACROS['\\mathpalette'] = '\\mathchoice{#1\\displaystyle{#2}}{#1\\textstyle{#2}}{#1\\scriptstyle{#2}}{#1\\scriptscriptstyle{#2}}';
  MATH_MACROS['\\m@th'] = '';
  // upgreek: upright Greek letters (\uptau, \Upgamma)
  for (const g of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
    'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau',
    'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega']) {
    MATH_MACROS['\\up' + g] = `\\mathrm{\\${g}}`;
  }
  for (const g of ['Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega']) {
    MATH_MACROS['\\Up' + g.toLowerCase()] = `\\${g}`;
    MATH_MACROS['\\Up' + g] = `\\${g}`;
  }
  // stmaryrd's tall white bar ⫾ (KaTeX's fonts lack it; drawn as a double bar)
  MATH_MACROS['\\talloblong'] = '\\mathbin{\\Vert}';
  // \protect only matters to LaTeX's moving arguments
  MATH_MACROS['\\protect'] = '';
  // mathabx / MnSymbol double angle brackets ⟪ ⟫, which KaTeX lacks: two
  // angles (see doubleAngles for \left\llangle, \big\llangle, …)
  MATH_MACROS['\\llangle'] = '\\langle\\mkern-4mu\\langle';
  MATH_MACROS['\\rrangle'] = '\\rangle\\mkern-4mu\\rangle';
  // The triple-bar norm delimiter ⦀ (fourier's \VERT, \vvvert), which KaTeX lacks:
  // drawn as three bars (see TRIPLE_BAR and tripleBars).
  const TRIPLE_BAR = '\\vert\\mkern-2mu\\vert\\mkern-2mu\\vert';
  MATH_MACROS['\\vvvert'] = `{${TRIPLE_BAR}}`;
  MATH_MACROS['\\VERT'] = MATH_MACROS['\\vvvert'];

  /** Names (with backslash) of delimiters that are drawn as three bars. */
  const DEFAULT_TRIPLE = ['\\vvvert', '\\VERT'];

  /**
   * One delimiter: wrap('\\vert') gives e.g. '\\left\\vert' or '\\mathopen{\\vert}'.
   * A triple bar becomes three of them in a row. (Not one \\mathopen{…} round
   * all three: KaTeX's MathML for that nests <mspace/> inside <mo>, which the
   * HTML parser reads as an unclosed element that swallows the rest of the page.)
   */
  function sizedDelim(wrap, d, triple) {
    if (!triple.includes(d.trim())) return wrap(d);
    return [0, 1, 2].map(() => wrap('\\vert')).join('\\mkern-2mu');
  }

  /**
   * \left\llangle … \right\rrangle, \big\llangle, …: KaTeX sizes one delimiter
   * at a time, so size both angles.
   */
  function doubleAngles(tex) {
    if (!/\\(ll|rr)angle/.test(tex)) return tex;
    return tex.replace(/(\\(?:left|right|middle|[bB]igg?[lrm]?))\s*\\(ll|rr)angle(?![A-Za-z@])/g, (_, pre, d) => {
      const a = d === 'll' ? '\\langle' : '\\rangle';
      return `${pre}${a}\\mkern-4mu${pre}${a}`;
    });
  }

  /**
   * Write KaTeX's empty MathML elements (<mspace/>, …) with an end tag. KaTeX
   * sometimes nests them inside <mo> or <mi> (\mathrel{\rlap{…}\mkern2mu…}),
   * where the HTML parser reads tags as HTML, so `<mspace/>` opens an element
   * that is never closed: it swallows the rest of the page, which nests deeper
   * at every formula and makes the page take seconds to parse.
   */
  function closeEmptyMathml(html) {
    return typeof html === 'string' && html.includes('/>')
      ? html.replace(/<(mspace|mglyph|malignmark|mprescripts|none)\b([^<>]*?)\s*\/>/g, '<$1$2></$1>')
      : html;
  }

  /**
   * \left\vvvert … \right\vvvert (or \bigl, \Big, …) for a triple-bar delimiter:
   * KaTeX takes a single delimiter after \left, so put three bars in a row.
   */
  function tripleBars(tex, triple) {
    for (const d of triple) {
      if (!tex.includes(d)) continue;
      const re = new RegExp(`(\\\\(?:left|right|middle|[bB]igg?[lrm]?))\\s*${d.replace(/\\/g, '\\\\')}(?![A-Za-z@])`, 'g');
      tex = tex.replace(re, (_, pre) => sizedDelim((x) => pre + x, d, triple));
    }
    return tex;
  }
  // graphicx boxes around math, as in \[ \resizebox{\linewidth}{!}{$\displaystyle …$} \]:
  // the content at its own size (a formula too wide for the page scrolls instead).
  const boxedMath = (n) => (ctx) => {
    const args = ctx.consumeArgs(n);
    // tokens come last-first; in a formula leave out the $ that switched the
    // box to math (inside \hbox{…} the box is text, so the $ stays)
    const toks = ctx.mode === 'text' ? args[n - 1] : args[n - 1].filter((t) => t.text !== '$');
    return { tokens: toks, numArgs: 0 };
  };
  MATH_MACROS['\\resizebox'] = boxedMath(3);
  MATH_MACROS['\\scalebox'] = boxedMath(2);

  // physics package: \abs, \norm, \qty, \dd, \dv, \pdv, \expval, … (a user's own
  // definition, e.g. with \DeclarePairedDelimiter, takes precedence over these).
  // Token helpers: KaTeX hands arguments over last-first.
  const tokText = (toks) =>
    toks
      .slice()
      .reverse()
      .map((t) => (/^\\[A-Za-z@]+$/.test(t.text) ? t.text + ' ' : t.text))
      .join('');
  const peekText = (ctx) => {
    ctx.consumeSpaces();
    return ctx.future().text;
  };
  const optStar = (ctx) => {
    if (peekText(ctx) !== '*') return false;
    ctx.popToken();
    return true;
  };
  const optBracket = (ctx) => (peekText(ctx) === '[' ? (ctx.popToken(), tokText(ctx.consumeArg([']']).tokens)) : null);
  const group = (ctx) => tokText(ctx.consumeArgs(1)[0]);
  const optGroup = (ctx) => (peekText(ctx) === '{' ? group(ctx) : null);
  /** Read up to the matching `close` (for \qty(…), \qty|…|), nesting on `open`. */
  const until = (ctx, open, close) => {
    const out = [];
    for (let depth = 0; ;) {
      const t = ctx.popToken();
      if (t.text === 'EOF') break;
      if (t.text === close && depth === 0) break;
      if (t.text === open && open !== close) depth++;
      else if (t.text === close) depth--;
      out.push(t);
    }
    return tokText(out.reverse());
  };
  const SIZES = /^\\(big|Big|bigg|Bigg)$/;
  /** Delimiters round `body`: auto-sized, plain with a star, or \big-sized. */
  const delimited = (open, close, body, star, size) => {
    if (star) return `\\mathopen{${open}}${body}\\mathclose{${close}}`;
    if (size) return `\\mathopen{${size}l${open}}${body}\\mathclose{${size}r${close}}`;
    return `\\left${open} ${body} \\right${close}`;
  };
  const physDelim = (open, close) => (ctx) => {
    const star = optStar(ctx);
    const size = SIZES.test(peekText(ctx)) ? ctx.popToken().text : '';
    return delimited(open, close, group(ctx), star, size);
  };
  MATH_MACROS['\\abs'] = physDelim('\\lvert', '\\rvert');
  MATH_MACROS['\\absolutevalue'] = MATH_MACROS['\\abs'];
  MATH_MACROS['\\norm'] = physDelim('\\lVert', '\\rVert');
  MATH_MACROS['\\pqty'] = physDelim('(', ')');
  MATH_MACROS['\\bqty'] = physDelim('[', ']');
  MATH_MACROS['\\vqty'] = physDelim('\\lvert', '\\rvert');
  MATH_MACROS['\\Bqty'] = physDelim('\\{', '\\}');
  MATH_MACROS['\\qty'] = (ctx) => {
    const star = optStar(ctx);
    const size = SIZES.test(peekText(ctx)) ? ctx.popToken().text : '';
    const t = peekText(ctx);
    const pairs = { '(': ')', '[': ']', '|': '|' };
    if (pairs[t]) {
      ctx.popToken();
      const open = t === '|' ? '\\lvert' : t;
      const close = t === '|' ? '\\rvert' : pairs[t];
      return delimited(open, close, until(ctx, t, pairs[t]), star, size);
    }
    return delimited('\\{', '\\}', group(ctx), star, size);
  };
  MATH_MACROS['\\order'] = (ctx) => `\\mathcal{O}${MATH_MACROS['\\qty'](ctx)}`;
  MATH_MACROS['\\eval'] = (ctx) => {
    const t = peekText(ctx);
    if (t === '(' || t === '[') {
      ctx.popToken();
      return `\\left${t} ${until(ctx, t, '|')} \\right\\rvert`;
    }
    return `\\left. ${group(ctx)} \\right\\rvert`;
  };
  // derivatives: \dd x, \dd[n]{x}, \dv{f}{x}, \dv[n]{f}{x}, \dv{x}, \pdv{f}{x}{y}
  const D = '\\mathrm{d}';
  MATH_MACROS['\\dd'] = (ctx) => {
    const n = optBracket(ctx);
    const x = optGroup(ctx);
    return `\\mathop{}\\!${D}${n ? `^{${n}}` : ''}${x !== null ? `{${x}}` : ''}`;
  };
  const derivative = (d) => (ctx) => {
    const star = optStar(ctx);
    const n = optBracket(ctx);
    const pow = n ? `^{${n}}` : '';
    const a = group(ctx);
    const b = optGroup(ctx);
    if (b === null) return star ? `${d}${pow}/${d}{${a}}${pow}` : `\\frac{${d}${pow}}{${d}{${a}}${pow}}`;
    const c = d === '\\partial' ? optGroup(ctx) : null;
    if (c !== null) return `\\frac{${d}^{2} {${a}}}{${d}{${b}}\\,${d}{${c}}}`;
    return star ? `${d}${pow}{${a}}/${d}{${b}}${pow}` : `\\frac{${d}${pow}{${a}}}{${d}{${b}}${pow}}`;
  };
  MATH_MACROS['\\dv'] = derivative(D);
  MATH_MACROS['\\derivative'] = MATH_MACROS['\\dv'];
  MATH_MACROS['\\pdv'] = derivative('\\partial');
  MATH_MACROS['\\partialderivative'] = MATH_MACROS['\\pdv'];
  // quantum notation (\bra, \ket and \braket are KaTeX's own)
  MATH_MACROS['\\expval'] = (ctx) => {
    const a = group(ctx);
    const b = optGroup(ctx);
    return b === null ? `\\left\\langle ${a} \\right\\rangle` : `\\left\\langle ${b} \\middle\\vert ${a} \\middle\\vert ${b} \\right\\rangle`;
  };
  MATH_MACROS['\\ev'] = MATH_MACROS['\\expval'];
  MATH_MACROS['\\mel'] = '\\left\\langle #1 \\middle\\vert #2 \\middle\\vert #3 \\right\\rangle';
  MATH_MACROS['\\matrixel'] = MATH_MACROS['\\mel'];
  MATH_MACROS['\\comm'] = '\\left[ #1 , #2 \\right]';
  MATH_MACROS['\\commutator'] = MATH_MACROS['\\comm'];
  MATH_MACROS['\\acomm'] = '\\left\\{ #1 , #2 \\right\\}';
  MATH_MACROS['\\anticommutator'] = MATH_MACROS['\\acomm'];
  MATH_MACROS['\\tr'] = '\\operatorname{tr}';
  MATH_MACROS['\\Tr'] = '\\operatorname{Tr}';
  MATH_MACROS['\\rank'] = '\\operatorname{rank}';
  // vectors: \vb{x} upright bold (\vb*{x} italic bold), \vu{x} a unit vector
  MATH_MACROS['\\vb'] = (ctx) => (optStar(ctx) ? `\\boldsymbol{${group(ctx)}}` : `\\mathbf{${group(ctx)}}`);
  MATH_MACROS['\\vu'] = (ctx) => (optStar(ctx) ? `\\hat{\\boldsymbol{${group(ctx)}}}` : `\\hat{\\mathbf{${group(ctx)}}}`);
  MATH_MACROS['\\grad'] = '\\nabla';
  MATH_MACROS['\\curl'] = '\\nabla\\times';
  MATH_MACROS['\\divergence'] = '\\nabla\\cdot';
  MATH_MACROS['\\laplacian'] = '\\nabla^2';
  MATH_MACROS['\\cross'] = '\\times';
  MATH_MACROS['\\vdot'] = '\\cdot';
  MATH_MACROS['\\qq'] = '\\quad\\text{#1}\\quad';
  MATH_MACROS['\\qc'] = ',\\quad';
  // ulem inside formulas (as in \text{\uline{…}}); KaTeX has \underline and \sout
  MATH_MACROS['\\uline'] = '\\underline{#1}';
  MATH_MACROS['\\uuline'] = '\\underline{\\underline{#1}}';
  MATH_MACROS['\\uwave'] = '\\underline{#1}';
  MATH_MACROS['\\dashuline'] = '\\underline{#1}';
  MATH_MACROS['\\dotuline'] = '\\underline{#1}';
  MATH_MACROS['\\xout'] = '\\sout{#1}';

  /**
   * KaTeX's array takes only l, c, r and | columns: drop @{…}, !{…}, >{…}, <{…}
   * from the column spec (\begin{array}{l@{}l} becomes {ll}) and read p{…} as l.
   */
  function arraySpecs(tex) {
    const re = /\\begin\s*\{d?array\}\s*(?:\[[^\]]*\]\s*)?\{/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(tex))) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let k = open;
      for (; k < tex.length; k++) {
        if (tex[k] === '{') depth++;
        else if (tex[k] === '}' && --depth === 0) break;
      }
      if (k >= tex.length) break;
      let spec = tex.slice(open + 1, k);
      for (let guard = 0; guard < 10 && /[@!<>]\s*\{/.test(spec); guard++) {
        spec = spec.replace(/[@!<>]\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
      }
      spec = spec.replace(/[pmbw]\s*\{[^{}]*\}/g, 'l');
      out += tex.slice(last, open + 1) + spec + '}';
      last = k + 1;
      re.lastIndex = last;
    }
    return out + tex.slice(last);
  }


  /**
   * A KaTeX macro for a mathtools \DeclarePairedDelimiter: \cmd{x} puts plain
   * delimiters, \cmd*{x} \left…\right ones, \cmd[\big]{x} \bigl…\bigr ones.
   */
  function pairedMacro(p, triple) {
    triple = triple || DEFAULT_TRIPLE;
    return (ctx) => {
      ctx.consumeSpaces();
      let size = '';
      let star = false;
      const t = ctx.future();
      if (t.text === '*') {
        ctx.popToken();
        star = true;
      } else if (t.text === '[') {
        ctx.popToken();
        const toks = [];
        let depth = 0;
        for (;;) {
          const k = ctx.popToken();
          if (k.text === 'EOF') break;
          if (k.text === '{') depth++;
          else if (k.text === '}') depth--;
          else if (k.text === ']' && depth === 0) break;
          toks.push(k.text);
        }
        size = toks.join(' ').trim();
      }
      let open;
      let close;
      let mid;
      if (star) {
        open = sizedDelim((x) => `\\left${x}`, p.open, triple);
        close = sizedDelim((x) => `\\right${x}`, p.close, triple);
        mid = '\\middle';
      } else if (size) {
        const big = /^\\(big|Big|bigg|Bigg)$/.test(size);
        open = sizedDelim((x) => `${size}${big ? 'l' : ''}${x}`, p.open, triple);
        close = sizedDelim((x) => `${size}${big ? 'r' : ''}${x}`, p.close, triple);
        mid = size;
      } else {
        open = sizedDelim((x) => `\\mathopen{${x}}`, p.open, triple);
        close = sizedDelim((x) => `\\mathclose{${x}}`, p.close, triple);
        mid = '';
      }
      const body = p.body.replace(/\\delimsize\b/g, mid);
      return `${p.pre}${open} ${body} ${close}${p.post}`;
    };
  }

  /**
   * A KaTeX macro for a user command that takes arguments. A plain string
   * body would not do: KaTeX counts the arguments from the #n it finds, so
   * an argument the body never uses is left behind in the formula, and it
   * has no notion of a default for the first one (\newcommand{\c}[2][x]{…}).
   * The default is handled by pushing `{default}` (or `{what was in […]}`)
   * back onto the input, where KaTeX then reads it as argument #1.
   */
  function userMathMacro(m) {
    let body = null;
    let delimiters = null;
    const lex = (ctx, s) => {
      const lexer = new ctx.lexer.constructor(s, ctx.settings);
      const out = [];
      for (let t = lexer.lex(); t.text !== 'EOF'; t = lexer.lex()) out.push(t);
      return out;
    };
    return (ctx) => {
      if (!body) {
        body = lex(ctx, m.body).reverse();
        if (m.delims) {
          delimiters = m.delims.map((d) => lex(ctx, d).map((t) => t.text).filter((t) => t !== ' '));
          // An undelimited parameter (#1#2) has an empty list.
          if (!delimiters.some((d) => d.length)) delimiters = null;
        }
      }
      if (m.def !== null && m.def !== undefined) {
        ctx.consumeSpaces();
        const braces = lex(ctx, '{}'); // [ '{', '}' ]
        let arg;
        if (ctx.future().text === '[') {
          ctx.popToken();
          arg = ctx.consumeArg([']']).tokens; // already in stack order
        } else {
          arg = lex(ctx, m.def).reverse();
        }
        ctx.pushToken(braces[1]);
        ctx.pushTokens(arg);
        ctx.pushToken(braces[0]);
      }
      return { tokens: body, numArgs: m.nargs, delimiters: delimiters || undefined };
    };
  }

  /**
   * Commands that only make sense in math. A user macro whose body uses one
   * of these is set as math when it appears in running text (\R, \eps,
   * \abs{x}), as it would have to be wrapped in \ensuremath to work in TeX.
   */
  const MATH_ONLY = new RegExp(
    '(?<!\\\\)[\\^_]|\\\\(?:' +
      [
        'math[a-z]*', 'operatorname\\*?', 'bm', 'boldsymbol', 'pmb',
        'v?[aA]lpha', 'beta', '[gG]amma', '[dD]elta', 'v?epsilon', 'varepsilon', 'zeta', 'eta', 'v?[tT]heta',
        'iota', 'kappa', 'varkappa', '[lL]ambda', 'mu', 'nu', '[xX]i', 'v?pi', '[pP]i', 'v?rho', 'v?[sS]igma',
        'tau', '[uU]psilon', 'v?[pP]hi', 'varphi', 'chi', '[pP]si', '[oO]mega', 'digamma',
        'frac', 'dfrac', 'tfrac', 'binom', 'sqrt', 'left', 'right', 'big[lr]?', 'Big[lr]?', 'bigg[lr]?', 'Bigg[lr]?',
        '[lr]vert', '[lr]Vert', '[lr]angle', 'langle', 'rangle', '[lr]floor', '[lr]ceil', 'mid', 'vert', 'Vert',
        'infty', 'partial', 'nabla', 'sum', 'prod', 'coprod', 'int', 'iint', 'oint', 'bigcup', 'bigcap',
        'bigoplus', 'bigotimes', 'cup', 'cap', 'oplus', 'otimes', 'circ', 'cdot', 'cdots', 'times', 'setminus',
        'le', 'leq', 'ge', 'geq', 'neq', 'ne', 'approx', 'sim', 'simeq', 'cong', 'equiv', 'subset', 'subseteq',
        'supset', 'supseteq', 'in', 'notin', 'ni', 'to', 'mapsto', 'rightarrow', 'leftarrow', 'Rightarrow',
        'hookrightarrow', 'twoheadrightarrow', 'longrightarrow', 'emptyset', 'varnothing', 'forall', 'exists',
        'hat', 'widehat', 'tilde', 'widetilde', 'bar', 'overline', 'vec', 'dot', 'ddot', 'check',
        'overrightarrow', 'underbrace', 'overbrace', 'ell', 'wp', 'Re', 'Im', 'aleph', 'hbar',
        'lim', 'sup', 'inf', 'max', 'min', 'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'det', 'dim', 'ker', 'deg',
      ].join('|') +
      ')(?![A-Za-z])'
  );

  const rowSep = (s, i) => {
    if (!s.startsWith('\\\\', i)) return 0;
    let j = i + 2;
    if (s[j] === '*') j++;
    const opt = readOpt(s, j);
    return (opt ? opt.end : j) - i;
  };
  const cellSep = (s, i) => (s[i] === '&' ? 1 : 0);
  const commandSep = (name) => (s, i) =>
    s.startsWith('\\' + name, i) && !isLetter(s[i + name.length + 1]) ? name.length + 1 : 0;

  // ---------------------------------------------------------------------------
  // Tables of known commands
  // ---------------------------------------------------------------------------

  const SYMBOLS = {
    ldots: '…', dots: '…', textellipsis: '…', LaTeX: '<span class="latex-logo">L<sup>a</sup>T<sub>e</sub>X</span>',
    TeX: '<span class="latex-logo">T<sub>e</sub>X</span>', LaTeXe: '<span class="latex-logo">L<sup>a</sup>T<sub>e</sub>X 2<sub>ε</sub></span>',
    textbackslash: '\\', S: '§', P: '¶', copyright: '©', textcopyright: '©', dag: '†', ddag: '‡',
    textendash: '–', textemdash: '—', textasciitilde: '~', textasciicircum: '^', textbar: '|',
    textless: '&lt;', textgreater: '&gt;', textbullet: '•', textdegree: '°', pounds: '£', euro: '€',
    quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ', enskip: ' ',
    ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', aa: 'å', AA: 'Å',
    i: 'ı', j: 'ȷ', textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”',
    qed: '<span class="qed">∎</span>', checkmark: '✓', hfill: ' ', hfil: ' ', dotfill: ' ',
  };

  /** xcolor names a \todo colour may use that CSS knows by the same name. */
  const NOTE_COLORS = new Set(['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'orange', 'purple', 'violet',
    'pink', 'brown', 'gray', 'olive', 'teal', 'lime']);

  /**
   * A note for the margin (\marginpar, \todo). It sits in the text where it was
   * written; the viewers lift it into the margin column (src/margin.js), and
   * without them (export, print) it floats to the right of the text.
   */
  function marginNote(body, kind, style) {
    return `<span class="mnote mnote-${kind}"${style}><span class="mnote-body">${body}</span></span>`;
  }

  const NOOPS = new Set([
    'noindent', 'indent', 'centering', 'raggedright', 'raggedleft', 'vfill', 'null', 'relax', 'protect',
    'clearpage', 'cleardoublepage', 'newpage', 'pagebreak', 'nopagebreak', 'smallskip', 'medskip', 'bigskip',
    'frenchspacing', 'nonfrenchspacing', 'sloppy', 'fussy', 'flushbottom', 'raggedbottom', 'maketitle_',
    'makeatletter', 'makeatother', 'normalsize', 'selectfont', 'onecolumn', 'twocolumn', 'mainmatter',
    'frontmatter', 'backmatter', 'printbibliography', 'listoffigures', 'listoftables', 'qedhere', 'xspace',
    'ignorespaces', 'unskip', 'allowbreak', 'break', 'nolinebreak', 'leavevmode', 'displaybreak',
    'long', 'outer', 'listoftodos', 'reversemarginpar', 'normalmarginpar',
    // imsart (IMS journals) wraps the preamble's definitions in these
    'startlocaldefs', 'endlocaldefs',
  ]);

  /** Commands whose arguments are dropped entirely. */
  const DROP_ARGS = new Set([
    'usepackage', 'RequirePackage', 'setlength', 'addtolength', 'vspace', 'hspace', 'pagestyle',
    'thispagestyle', 'bibliographystyle', 'bibliography', 'addbibresource', 'input', 'include', 'includeonly',
    'graphicspath', 'hypersetup', 'geometry', 'index', 'nocite', 'addcontentsline', 'markboth', 'markright',
    'pagenumbering', 'linespread', 'colorlet', 'definecolor', 'crefname', 'Crefname', 'creflabelformat',
    'allowdisplaybreaks', 'captionsetup', 'lstset', 'newtheoremstyle', 'setcounter_', 'phantom', 'hphantom',
    'vphantom', 'newlength', 'settowidth', 'tikzset', 'pgfplotsset', 'setlist', 'renewenvironment_',
    'usetikzlibrary', 'tikzcdset', 'SelectTips', 'xyoption', 'pgfdeclarelayer', 'pgfsetlayers', 'CompileMatrices',
    'DeclareGraphicsExtensions', 'urlstyle', 'keywords', 'subjclass', 'address', 'email', 'curraddr',
    'dedicatory', 'translator', 'setcopyright', 'raisebox_', 'enlargethispage', 'looseness', 'spacing',
    'DeclareFontEncoding', 'DeclareFontSubstitution', 'DeclareSymbolFont', 'SetSymbolFont', 'DeclareFontFamily',
    'DeclareFontShape', 'DeclareMathAlphabet', 'SetMathAlphabet', 'DeclareSymbolFontAlphabet',
    'setuptodonotes', 'presetkeys',
    // imsart / elsarticle front matter: running heads, e-mail labels, affiliations
    'runtitle', 'runauthor', 'affiliation', 'ead', 'printead', 'printaddresses', 'ead_',
  ]);

  const TEXT_STYLES = {
    textbf: ['strong'], textit: ['em', 'it'], emph: ['em'], textsl: ['em', 'sl'], texttt: ['code'],
    textsc: ['span', 'sc'], underline: ['u'], uline: ['u'], textrm: ['span'], textsf: ['span', 'sf'],
    textup: ['span'], textnormal: ['span'], textmd: ['span'], mbox: ['span'], hbox: ['span'], text: ['span'],
    textsuperscript: ['sup'], textsubscript: ['sub'], textcolor_: ['span'], fbox: ['span', 'fbox'],
    framebox: ['span', 'fbox'], makebox: ['span'], textup_: ['span'], sout: ['s'], st: ['s'],
    // ulem (and soul's \ul)
    uuline: ['u', 'uuline'], uwave: ['u', 'uwave'], dashuline: ['u', 'dashuline'], dotuline: ['u', 'dotuline'],
    xout: ['s', 'xout'], ul: ['u'],
    // imsart author names: \fnms{first} \snm{last}
    fnms: ['span'], snm: ['span'],
  };

  const DECLARATIONS = {
    bf: ['strong'], bfseries: ['strong'], it: ['em', 'it'], itshape: ['em', 'it'], sl: ['em', 'sl'],
    slshape: ['em', 'sl'], em: ['em'], tt: ['code'], ttfamily: ['code'], sc: ['span', 'sc'],
    scshape: ['span', 'sc'], rm: ['span'], rmfamily: ['span'], normalfont: ['span'], upshape: ['span'],
    sffamily: ['span', 'sf'], sf: ['span', 'sf'], mdseries: ['span'],
    tiny: ['span', 'size-tiny'], scriptsize: ['span', 'size-scriptsize'], footnotesize: ['span', 'size-footnotesize'],
    small: ['span', 'size-small'], large: ['span', 'size-large'], Large: ['span', 'size-Large'],
    LARGE: ['span', 'size-LARGE'], huge: ['span', 'size-huge'], Huge: ['span', 'size-Huge'],
  };

  const ACCENTS = {
    "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇',
    u: '̆', v: '̌', H: '̋', c: '̧', r: '̊', k: '̨', d: '̣', b: '̱',
  };

  const SECTIONS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };

  const MATH_ENVS = new Set([
    'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'flalign',
    'flalign*', 'alignat', 'alignat*', 'eqnarray', 'eqnarray*', 'displaymath', 'dmath', 'dmath*',
  ]);

  // Theorem-like environments known without a \newtheorem (they all share one
  // counter). A document's own \newtheorem declarations take precedence.
  const DEFAULT_THEOREMS = {
    theorem: ['Theorem', 'plain'], thm: ['Theorem', 'plain'], lemma: ['Lemma', 'plain'], lem: ['Lemma', 'plain'],
    proposition: ['Proposition', 'plain'], prop: ['Proposition', 'plain'], corollary: ['Corollary', 'plain'],
    cor: ['Corollary', 'plain'], conjecture: ['Conjecture', 'plain'], conj: ['Conjecture', 'plain'],
    claim: ['Claim', 'plain'], fact: ['Fact', 'plain'], observation: ['Observation', 'plain'],
    hypothesis: ['Hypothesis', 'plain'], assumption: ['Assumption', 'definition'],
    definition: ['Definition', 'definition'], defn: ['Definition', 'definition'], dfn: ['Definition', 'definition'],
    example: ['Example', 'definition'], ex: ['Example', 'definition'], exercise: ['Exercise', 'definition'],
    problem: ['Problem', 'definition'], question: ['Question', 'definition'], notation: ['Notation', 'definition'],
    remark: ['Remark', 'remark'], rem: ['Remark', 'remark'], note: ['Note', 'remark'],
  };

  const KIND_NAMES = {
    // [cref, Cref/autoref]
    equation: ['eq.', 'Equation'], figure: ['fig.', 'Figure'], table: ['tab.', 'Table'],
    section: ['section', 'Section'], subsection: ['section', 'Section'], subsubsection: ['section', 'Section'],
    chapter: ['chapter', 'Chapter'], part: ['part', 'Part'], item: ['item', 'Item'], footnote: ['footnote', 'Footnote'],
    appendix: ['appendix', 'Appendix'],
  };

  // ---------------------------------------------------------------------------
  // The renderer (one instance per pass)
  // ---------------------------------------------------------------------------

  // Limits on user macro expansion (see expandMacro).
  const MACRO_NESTING = 4;
  const MACRO_EXPANSIONS = 200000;

  class Renderer {
    constructor(options, known) {
      this.options = options;
      this.known = known; // results of the first pass, or null during it
      this.renderMathFn = known ? options.renderMath || defaultRenderMath : () => '';
      this.labels = Object.create(null);
      this.toc = [];
      this.cites = Object.create(null);
      this.footnotes = [];
      this.warnings = [];
      this.macros = Object.create(null); // name (without backslash) -> {nargs, def, body}
      this.paired = Object.create(null); // \DeclarePairedDelimiter definitions
      this.triple = DEFAULT_TRIPLE.slice(); // delimiters drawn as three bars (\vvvert)
      this.envs = Object.create(null); // \newenvironment definitions
      this.theorems = Object.create(null);
      this.thmStyle = 'plain';
      this.counters = Object.create(null);
      for (const c of ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'equation', 'figure', 'table', 'footnote', '__thm']) {
        this.newCounter(c, null);
      }
      this.counters.section.parent = null;
      this.counters.subsection.parent = 'section';
      this.counters.subsubsection.parent = 'subsection';
      this.topLevel = 'section';
      this.appendix = false;
      this.target = null; // what a \label currently refers to
      this.ids = 0;
      this.depth = 0;
      this.expanding = new Map(); // macro -> how many of its expansions are open
      this.expansions = 0;
      this.listDepth = 0;
      this.floatKind = null;
      this.meta = { title: null, author: null, date: null };
      this.titleShown = false;
      this.thanksTexts = Object.create(null); // imsart \thankstext / elsarticle \fntext, by key
      this.srcMap = null; // original-source offsets, set when options.sourceMap is on
      this.trackDepth = -1;
    }

    // --- counters ----------------------------------------------------------

    newCounter(name, parent) {
      if (!this.counters[name]) this.counters[name] = { value: 0, parent: parent || null };
    }

    step(name) {
      this.newCounter(name, null);
      this.counters[name].value++;
      const reset = (p) => {
        for (const k in this.counters) {
          if (this.counters[k].parent === p) {
            this.counters[k].value = 0;
            reset(k);
          }
        }
      };
      reset(name);
    }

    fmt(name) {
      const c = this.counters[name];
      if (!c) return '';
      // \renewcommand{\thesection}{\Roman{section}} and the like.
      const own = this.macros['the' + name];
      if (own && !own.nargs && (this.fmtDepth || 0) < 5) {
        this.fmtDepth = (this.fmtDepth || 0) + 1;
        try {
          return stripTags(this.flow(own.body, true)).trim();
        } finally {
          this.fmtDepth--;
        }
      }
      let v = String(c.value);
      if (this.appendix && name === this.topLevel) v = alpha(c.value, true);
      if (name === 'part') v = roman(c.value, true);
      return c.parent && this.counters[c.parent] ? this.fmt(c.parent) + '.' + v : v;
    }

    newId(prefix) {
      return `${prefix}-${++this.ids}`;
    }

    setLabel(key, info) {
      key = key.trim();
      if (!key) return;
      if (this.labels[key] && !this.known) this.warnings.push(`Label "${key}" is defined more than once.`);
      this.labels[key] = info;
    }

    // --- references --------------------------------------------------------

    lookup(key) {
      const table = this.known ? this.known.labels : this.labels;
      return table[key.trim()];
    }

    refHtml(cmd, keys) {
      // \cref{a,b} refers to two labels, but a label may hold commas itself
      const parts = this.lookup(keys) ? [keys.trim()] : keys.split(',').map((k) => k.trim()).filter(Boolean);
      return parts
        .map((key) => {
          const info = this.lookup(key);
          if (!info) {
            if (this.known) this.warnings.push(`Undefined reference "${key}".`);
            return `<span class="ref ref-missing" title="Undefined label: ${escapeHtml(key)}">??</span>`;
          }
          let text = escapeHtml(info.num);
          if (cmd === 'eqref') text = `(${text})`;
          else if (cmd === 'nameref') text = info.name || text;
          else if (cmd === 'cref' || cmd === 'Cref' || cmd === 'autoref' || cmd === 'Autoref') {
            const kind = KIND_NAMES[info.kind];
            let name = info.kindName || (kind ? kind[1] : '');
            if (cmd === 'cref') name = kind ? kind[0] : name.toLowerCase();
            if (info.kind === 'equation' && cmd !== 'autoref' && cmd !== 'Autoref') text = `(${text})`;
            text = (name ? escapeHtml(name) + '&nbsp;' : '') + text;
          }
          return `<a class="ref" href="#${info.id}" data-label="${escapeHtml(key)}">${text}</a>`;
        })
        .join(', ');
    }

    /** \hyperref[key]{html}: the given text as a link to the label's target. */
    labelLink(key, html) {
      key = key.trim();
      const info = this.lookup(key);
      if (!info) {
        if (this.known) this.warnings.push(`Undefined reference "${key}".`);
        return `<span class="ref-missing" title="Undefined label: ${escapeHtml(key)}">${html}</span>`;
      }
      return `<a class="ref" href="#${info.id}" data-label="${escapeHtml(key)}">${html}</a>`;
    }

    /** Resolve \ref-like commands inside math to plain text. */
    mathRefs(tex) {
      return tex.replace(/\\(eqref|ref|cref|Cref|autoref)\s*\{([^}]*)\}/g, (_, cmd, key) => {
        const info = this.lookup(key);
        let num = info ? info.num : '??';
        if (cmd === 'eqref') num = `(${num})`;
        return `\\text{${num.replace(/([{}\\#$%&_^~])/g, '\\$1')}}`;
      });
    }

    renderMath(tex, display) {
      tex = tripleBars(arraySpecs(this.mathRefs(tex)), this.triple);
      if (!this.macros.llangle && !this.macros.rrangle) tex = doubleAngles(tex);
      tex = tex.replace(/\\(qedhere|nonumber|notag)\b/g, '').replace(/\\label\s*\{[^}]*\}/g, '');
      try {
        const html = closeEmptyMathml(this.renderMathFn(tex, display, this.katexMacros(tex)));
        return this.trees && /color:#a5[0-9a-f]{4}/.test(html) ? this.putTrees(html) : html;
      } catch (e) {
        return `<span class="math-error" title="${escapeHtml(e.message || e)}">${escapeHtml(tex)}</span>`;
      }
    }

    katexMacros(tex) {
      if (!this._katexMacros) {
        const m = Object.assign({}, MATH_MACROS);
        for (const name in this.macros) {
          const mac = this.macros[name];
          m['\\' + name] = mac.nargs || mac.delims ? userMathMacro(mac) : mac.body;
        }
        for (const name in this.paired) m['\\' + name] = pairedMacro(this.paired[name], this.triple);
        for (const d of this.triple) if (!m[d]) m[d] = `{${TRIPLE_BAR}}`;
        m['\\texglassTree'] = (ctx) => {
          const name = ctx.consumeArgs(1)[0].slice().reverse().map((t) => t.text).join('').trim();
          return this.treeMarker(name);
        };
        this._katexMacros = m;
      }
      // KaTeX only writes to the macros object for global definitions, so the
      // shared table is safe to hand over unless the formula makes one. (A copy
      // per formula costs O(macros) each time, which adds up in long papers.)
      return /\\(gdef|global|xdef)\b/.test(tex) ? Object.assign({}, this._katexMacros) : this._katexMacros;
    }

    // --- top level ---------------------------------------------------------

    run(src) {
      let pre = '';
      let body = src;
      let bodyStart = 0;
      const b = src.search(/\\begin\s*\{document\}/);
      if (b >= 0) {
        pre = src.slice(0, b);
        bodyStart = src.indexOf('}', b) + 1;
        body = src.slice(bodyStart);
        const e = body.search(/\\end\s*\{document\}/);
        if (e >= 0) body = body.slice(0, e);
      }
      this.preamble = pre;
      this.ulemEmph = /\\usepackage\s*(?:\[(?![^\]]*\bnormalem\b)[^\]]*\])?\s*\{[^}]*\bulem\b[^}]*\}/.test(pre);
      if (/\\chapter\b/.test(src)) {
        this.topLevel = 'chapter';
        this.counters.section.parent = 'chapter';
      }
      this.flow(pre, false); // preamble: definitions only, output discarded
      this.trackDepth = this.depth + 1;
      this.trackBase = bodyStart;
      this.trackText = src;
      this.blocks = null;
      let html = this.flow(body, false);
      this.trackDepth = -1;
      if (this.footnotes.length) {
        const notes =
          '<section class="footnotes"><ol>' +
          this.footnotes.map((f, k) => `<li id="fn-${k + 1}">${f} <a class="fn-back" href="#fnref-${k + 1}">↩</a></li>`).join('') +
          '</ol></section>';
        html += '\n' + notes;
        if (this.blocks) this.blocks.push(notes);
      }
      return html;
    }

    // --- the main loop -----------------------------------------------------

    /**
     * Convert LaTeX source to HTML. In block mode, blank lines make paragraphs
     * and block elements (sections, environments, display math) stand alone;
     * in inline mode everything stays on one line.
     */
    flow(src, inline) {
      if (++this.depth > 200) {
        this.depth--;
        return escapeHtml(src);
      }
      const out = [];
      let para = '';
      // Length of `para` when it last ended with a space. Checking this
      // instead of para.endsWith(' ') avoids flattening the growing string on
      // every space, which is quadratic in the length of a long paragraph.
      let spaceAt = -1;
      // With a source map, remember which part of the source made each
      // top-level block, so the viewer can edit it in place.
      const track = !inline && this.srcMap && this.depth === this.trackDepth;
      const spans = [];
      let paraStart = -1;
      const flush = (pos) => {
        const t = para.trim();
        if (t) {
          out.push(inline ? para : `<p>${t}</p>`);
          if (track) spans[out.length - 1] = [paraStart, pos];
        } else if (inline && para) out.push(para);
        para = '';
        spaceAt = -1;
        paraStart = -1;
      };
      const emit = (r, pos) => {
        if (r.parbreak) {
          if (inline) add(' ');
          else flush(pos);
        }
        if (!r.html) return;
        if (r.block && !inline) {
          flush(pos);
          out.push(r.html);
          if (track) spans[out.length - 1] = [pos, r.end];
        } else add(r.html);
      };
      const add = (html) => {
        para += html;
        if (html.endsWith(' ')) spaceAt = para.length;
      };
      const space = () => {
        if (para && para.length !== spaceAt) {
          para += ' ';
          spaceAt = para.length;
        }
      };

      const n = src.length;
      let i = 0;
      while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (track && paraStart < 0 && c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') paraStart = i;
        switch (c) {
          case '\n': {
            let j = i + 1;
            while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j++;
            if (src[j] === '\n') {
              while (j < n && /\s/.test(src[j])) j++;
              emit({ parbreak: true }, i);
            } else space();
            i = j;
            continue;
          }
          case ' ': case '\t': case '\r':
            space();
            i++;
            continue;
          case '~':
            para += '&nbsp;';
            i++;
            continue;
          case '`':
            if (d === '`') { para += '“'; i += 2; } else { para += '‘'; i++; }
            continue;
          case "'":
            if (d === "'") { para += '”'; i += 2; } else { para += '’'; i++; }
            continue;
          case '-':
            if (d === '-' && src[i + 2] === '-') { para += '—'; i += 3; }
            else if (d === '-') { para += '–'; i += 2; }
            else { para += '-'; i++; }
            continue;
          case '{': {
            const g = readGroup(src, i);
            add(this.flow(g.content, true));
            i = g.end;
            continue;
          }
          case '}': case '&':
            i++;
            continue;
          case '$': {
            const at = i;
            const display = d === '$';
            const start = i + (display ? 2 : 1);
            const end = findMathEnd(src, display ? '$$' : '$', start);
            const tex = src.slice(start, end);
            i = end + (display ? 2 : 1);
            if (display) emit({ block: true, html: this.displayMath('displaymath', tex), end: i }, at);
            else para += this.inlineMath(tex);
            continue;
          }
          case '\\': {
            if (d === '(' || d === '[') {
              const at = i;
              const close = d === '(' ? '\\)' : '\\]';
              const end = findUnescaped(src, close, i + 2);
              const tex = src.slice(i + 2, end);
              i = end + 2;
              if (d === '[') emit({ block: true, html: this.displayMath('displaymath', tex), end: i }, at);
              else para += this.inlineMath(tex);
              continue;
            }
            if (isLetter(d)) {
              let j = i + 1;
              while (isLetter(src[j])) j++;
              const name = src.slice(i + 1, j);
              const r = this.command(name, src, skipAfterWord(src, j), inline);
              emit(r, i);
              i = r.end;
              continue;
            }
            const r = this.symbolCommand(d, src, i + 2);
            add(r.html);
            i = r.end;
            continue;
          }
          default:
            para += escapeHtml(c);
            i++;
        }
      }
      flush(n);
      this.depth--;
      if (track) {
        this.blocks = out.map((html, k) => (spans[k] ? this.wrapSpan(html, spans[k]) : html));
        return this.blocks.join('\n');
      }
      return out.join(inline ? '' : '\n');
    }

    /** Wrap a top-level block with the range of the original source it came from. */
    wrapSpan(html, [s, e]) {
      const text = this.trackText;
      const base = this.trackBase;
      while (e > s && /\s/.test(text[base + e - 1])) e--;
      if (e <= s) return html;
      const from = this.srcMap[base + s];
      const to = this.srcMap[base + e - 1] + 1;
      return `<div class="src-block" data-s="${from}" data-e="${to}">${html}</div>`;
    }

    inlineMath(tex) {
      const src = texAttr(tex);
      if (DIAGRAM_RE.test(tex) && tikz()) return `<span class="math math-inline"${src}>${this.mathWithDiagrams(tex)}</span>`;
      return `<span class="math math-inline"${src}>${this.renderMath(tex, false)}</span>`;
    }

    /** Commands made of a backslash and one non-letter. */
    symbolCommand(c, src, i) {
      if (c === '\\') {
        let j = src[i] === '*' ? i + 1 : i;
        const opt = src[j] === '[' ? readOpt(src, j) : null;
        return { html: '<br>', end: opt ? opt.end : j };
      }
      if (ACCENTS[c] !== undefined && c !== 'c') {
        const a = readArg(src, i);
        let base = a.content === '\\i' ? 'ı' : a.content === '\\j' ? 'ȷ' : a.content;
        return { html: escapeHtml((base + ACCENTS[c]).normalize('NFC')), end: a.end };
      }
      const map = { ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '/': '', '-': '­', '@': '', '\n': ' ' };
      if (c in map) return { html: map[c], end: i };
      if (c === undefined) return { html: '', end: i };
      return { html: escapeHtml(c), end: i }; // \% \& \$ \# \_ \{ \}
    }

    // --- commands ----------------------------------------------------------

    command(name, src, i, inline) {
      const res = (html, end, extra) => Object.assign({ html, end }, extra);

      if (name === 'begin') {
        const a = readArg(src, i);
        return this.environment(a.content.trim(), src, a.end, inline);
      }
      if (name === 'end') return res('', readArg(src, i).end);

      if (name in SECTIONS) return this.section(name, src, i);

      if (name.length === 1 && ACCENTS[name] !== undefined && /[cuvHrkdb]/.test(name)) {
        const a = readArg(src, i);
        const base = a.content === '\\i' ? 'ı' : a.content === '\\j' ? 'ȷ' : a.content;
        return res(escapeHtml((base + ACCENTS[name]).normalize('NFC')), a.end);
      }
      if (name in SYMBOLS) return res(SYMBOLS[name], i);
      if (NOOPS.has(name)) return res('', i);

      if (name in TEXT_STYLES) {
        if (name === 'textcolor' || name === 'colorbox') readArg(src, i);
        const a = readArg(src, i);
        // ulem without [normalem] underlines \emph instead of slanting it
        const [tag, cls] = name === 'emph' && this.ulemEmph ? ['u'] : TEXT_STYLES[name];
        return res(`<${tag}${cls ? ` class="${cls}"` : ''}>${this.flow(a.content, true)}</${tag}>`, a.end);
      }
      if (name in DECLARATIONS) {
        const [tag, cls] = name === 'em' && this.ulemEmph ? ['u'] : DECLARATIONS[name];
        const tagName = inline || tag !== 'span' ? tag : 'div';
        const body = this.flow(src.slice(i), inline);
        const html = `<${tagName}${cls ? ` class="${cls}"` : ''}>${body}</${tagName}>`;
        return res(html, src.length, { block: !inline });
      }
      // graphicx: \resizebox{\linewidth}{!}{…} around a picture fits it to the column
      // (the viewer scales the drawing, see diagrams.js); other sizes keep the content as it is.
      if (name === 'resizebox' || name === 'scalebox') {
        let j = readStar(src, i).end;
        let fit = null;
        if (name === 'resizebox') {
          const w = readArg(src, j);
          j = readArg(src, w.end).end;
          const m = /^\s*([\d.]*)\s*\\(linewidth|textwidth|columnwidth|hsize)\s*$/.exec(w.content);
          if (m) fit = parseFloat(m[1] || '1') || 1;
        } else {
          j = readArg(src, j).end;
          const o = readOpt(src, j);
          if (o) j = o.end;
        }
        const a = readArg(src, j);
        const body = this.flow(a.content, true);
        return res(fit !== null ? `<span class="tg-resize" data-fit="${fit}">${body}</span>` : body, a.end);
      }
      if (name === 'textcolor' || name === 'colorbox') {
        const col = readArg(src, readOpt(src, i) ? readOpt(src, i).end : i);
        const a = readArg(src, col.end);
        return res(`<span>${this.flow(a.content, true)}</span>`, a.end);
      }
      if (name === 'color') return res('', readArg(src, i).end);

      // TikZ styles and colours, kept for tikzpicture.
      if (name === 'tikzset') {
        const a = readArg(src, i);
        this.tikzStyles = (this.tikzStyles ? this.tikzStyles + ',' : '') + a.content;
        return res('', a.end);
      }
      if (name === 'definecolor' || name === 'colorlet') {
        const n = readArg(src, i);
        const m = name === 'definecolor' ? readArg(src, n.end) : null;
        const v = readArg(src, m ? m.end : n.end);
        (this.tikzColors || (this.tikzColors = {}))[n.content.trim()] = m ? [m.content.trim(), v.content.trim()] : ['alias', v.content.trim()];
        return res('', v.end);
      }
      if (DROP_ARGS.has(name)) return res('', dropArgs(src, i));

      switch (name) {
        case 'label': {
          const a = readArg(src, i);
          const t = this.target || { num: '', kind: 'none', id: this.newId('label') };
          this.setLabel(a.content, Object.assign({}, t));
          return res(this.target ? '' : `<span id="${t.id}"></span>`, a.end);
        }
        case 'ref': case 'eqref': case 'cref': case 'Cref': case 'autoref': case 'Autoref': case 'nameref':
        case 'pageref': case 'vref': case 'cpageref': {
          const s = readStar(src, i);
          const a = readArg(src, s.end);
          const cmd = name === 'pageref' || name === 'cpageref' ? 'ref' : name === 'vref' ? 'ref' : name;
          return res(this.refHtml(cmd, a.content), a.end);
        }
        case 'cite': case 'citep': case 'citet': case 'citealp': case 'citeauthor': case 'citeyear': case 'parencite':
        case 'textcite': case 'autocite': {
          let j = readStar(src, i).end;
          const opts = [];
          let o;
          while ((o = readOpt(src, j))) { opts.push(o.content); j = o.end; }
          const a = readArg(src, j);
          return res(this.citeHtml(a.content, opts[opts.length - 1]), a.end);
        }
        case 'cites': case 'parencites': case 'textcites': case 'autocites': case 'citeps': {
          // amsrefs \cites{a,b} and biblatex \cites[pre][post]{a}[post]{b}: one bracket of citations.
          let j = i;
          const keys = [];
          let note;
          for (;;) {
            let k = j;
            const opts = [];
            let o;
            while ((o = readOpt(src, k))) { opts.push(o.content); k = o.end; }
            const at = skipInline(src, k);
            if (src[at] !== '{') break;
            const a = readArg(src, k);
            keys.push(a.content);
            if (opts.length) note = opts[opts.length - 1];
            j = a.end;
          }
          if (!keys.length) return res('', i);
          return res(this.citeHtml(keys.join(','), keys.length === 1 ? note : undefined), j);
        }
        case 'todo': {
          // todonotes: \todo{text} goes in the margin, \todo[inline]{text} in the line.
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          const opts = o ? o.content : '';
          if (/(^|,)\s*disable\s*(,|$)/.test(opts)) return res('', a.end);
          const body = this.flow(a.content, true);
          const c = /(?:^|,)\s*(?:background)?colou?r\s*=\s*\{?([A-Za-z]+)/.exec(opts);
          const color = c && NOTE_COLORS.has(c[1].toLowerCase()) ? ` style="--note-c:${c[1].toLowerCase()}"` : '';
          if (/(^|,)\s*inline\s*(,|$)/.test(opts)) return res(`<span class="todo"${color}>${body}</span>`, a.end);
          return res(marginNote(body, 'todo', color), a.end);
        }
        case 'marginpar': {
          // \marginpar[left text]{right text}: the margin column is on the right.
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          return res(marginNote(this.flow(a.content, true), 'par', ''), a.end);
        }
        case 'marginnote': {
          // marginnote package: \marginnote{text}[vertical offset].
          const a = readArg(src, i);
          const o = readOpt(src, a.end);
          return res(marginNote(this.flow(a.content, true), 'par', ''), o ? o.end : a.end);
        }
        case 'missingfigure': {
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          return res(`<span class="todo">[missing figure: ${this.flow(a.content, true)}]</span>`, a.end);
        }
        case 'footnote': {
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          return res(this.footnote(a.content), a.end);
        }
        case 'thanks': {
          const a = readArg(src, i);
          return res(this.footnote(a.content), a.end);
        }
        case 'url': case 'nolinkurl': {
          const a = readArg(src, i);
          return res(`<a class="url" href="${escapeHtml(safeUrl(a.content))}">${escapeHtml(a.content)}</a>`, a.end);
        }
        case 'href': {
          const u = readArg(src, i);
          const t = readArg(src, u.end);
          return res(`<a class="href" href="${escapeHtml(safeUrl(u.content))}">${this.flow(t.content, true)}</a>`, t.end);
        }
        case 'hyperref': {
          // \hyperref[label]{text}: link text to a \label, like \ref.
          const o = readOpt(src, i);
          if (o) {
            const a = readArg(src, o.end);
            return res(this.labelLink(o.content, this.flow(a.content, true)), a.end);
          }
          // \hyperref{url}{category}{name}{text} links to url#category.name.
          const u = readArg(src, i);
          const c = readArg(src, u.end);
          const n = readArg(src, c.end);
          const t = readArg(src, n.end);
          const frag = [c.content.trim(), n.content.trim()].filter(Boolean).join('.');
          const url = u.content.trim() + (frag ? '#' + frag : '');
          return res(`<a class="href" href="${escapeHtml(safeUrl(url))}">${this.flow(t.content, true)}</a>`, t.end);
        }
        case 'hypertarget': {
          const n = readArg(src, i);
          const t = readArg(src, n.end);
          return res(`<span id="${escapeHtml(hyperId(n.content))}">${this.flow(t.content, true)}</span>`, t.end);
        }
        case 'hyperlink': {
          const n = readArg(src, i);
          const t = readArg(src, n.end);
          return res(`<a class="ref" href="#${escapeHtml(hyperId(n.content))}">${this.flow(t.content, true)}</a>`, t.end);
        }
        case 'verb': {
          const s = readStar(src, i);
          const delim = src[s.end];
          const end = src.indexOf(delim, s.end + 1);
          const stop = end < 0 ? src.length : end;
          return res(`<code>${escapeHtml(src.slice(s.end + 1, stop))}</code>`, stop + 1);
        }
        case 'ensuremath': {
          const a = readArg(src, i);
          return res(this.inlineMath(a.content), a.end);
        }
        case 'par':
          return res('', i, { parbreak: true });
        case 'newline': case 'linebreak':
          return res('<br>', readOpt(src, i) ? readOpt(src, i).end : i);
        case 'today':
          return res(escapeHtml(this.options.today || formatToday()), i);
        case 'item': {
          // Stray \item outside a list.
          const o = readOpt(src, i);
          return res(o ? `<strong>${this.flow(o.content, true)}</strong> ` : '• ', o ? o.end : i);
        }
        case 'title': case 'author': case 'date': {
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          // amsart (and others) take one \author per author: each adds one
          if (name === 'author' && this.meta.author && a.content.trim()) this.meta.author += ' \\and ' + a.content;
          else this.meta[name] = a.content;
          return res('', a.end);
        }
        case 'maketitle':
          this.titleShown = true;
          return res(this.titleBlock(), i, { block: true });
        case 'thankstext': case 'tnotetext': case 'fntext': case 'cortext': {
          // imsart \thankstext{key}{text}, elsarticle \fntext[key]{text}: the
          // note that \thanksref{key} / \fnref{key} attach to a name
          const o = readOpt(src, i);
          const k = o ? null : readArg(src, i);
          const a = readArg(src, o ? o.end : k.end);
          this.thanksTexts[(o ? o.content : k.content).trim()] = a.content;
          return res('', a.end);
        }
        case 'thanksref': case 'tnoteref': case 'fnref': case 'corref': {
          const a = readArg(src, i);
          const notes = a.content.split(',').map((k) => this.thanksTexts[k.trim()]).filter((t) => t !== undefined);
          return res(notes.map((t) => this.footnote(t)).join(''), a.end);
        }
        case 'tableofcontents':
          return res(this.tocHtml(), i, { block: true });
        case 'appendix':
          this.appendix = true;
          this.counters[this.topLevel].value = 0;
          return res('', i);
        case 'caption': {
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          return res(this.caption(a.content), a.end, { block: true });
        }
        case 'includegraphics': {
          const s = readStar(src, i);
          const o = readOpt(src, s.end);
          const a = readArg(src, o ? o.end : s.end);
          const resolved = this.options.resolveImage ? this.options.resolveImage(a.content.trim()) : null;
          // width=0.5\textwidth (or \linewidth, \columnwidth) becomes a percentage.
          const w = o && /(?:^|,)\s*width\s*=\s*([\d.]*)\s*\\(?:textwidth|linewidth|columnwidth|hsize)/.exec(o.content);
          const pct = w ? Math.min(100, Math.round(parseFloat(w[1] || '1') * 100)) : null;
          // width=4.85cm (or height=3cm): an absolute size, in em of a 10pt font
          const abs = !pct && o && /(?:^|,)\s*(width|height)\s*=\s*([\d.]+)\s*(cm|mm|in|pt|bp|em)\s*(?:,|$)/.exec(o.content);
          const absEm = abs ? Math.round((parseFloat(abs[2]) * { cm: 28.4528, mm: 2.84528, in: 72.27, pt: 1, bp: 1.00375, em: 10 }[abs[3]]) / 10 * 1000) / 1000 : 0;
          const style = pct ? ` style="width:${pct}%"` : absEm ? ` style="${abs[1]}:${absEm}em"` : '';
          const html = resolved
            ? `<img class="graphic" src="${escapeHtml(resolved)}" alt="${escapeHtml(a.content)}"${style}>`
            : `<span class="graphic-placeholder">[image: ${escapeHtml(a.content.trim())}]</span>`;
          return res(html, a.end);
        }
        case 'documentclass': {
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          if (/^(book|report|memoir|amsbook|scrbook|scrreprt)$/.test(a.content.trim())) {
            this.topLevel = 'chapter';
            this.counters.section.parent = 'chapter';
            for (const c of ['equation', 'figure', 'table']) this.counters[c].parent = 'chapter';
          }
          return res('', a.end);
        }
        case 'newcommand': case 'renewcommand': case 'providecommand': case 'DeclareRobustCommand':
        case 'newcommandx': {
          const s = readStar(src, i);
          const nm = readArg(src, s.end);
          let j = nm.end;
          const nargs = readOpt(src, j);
          if (nargs) j = nargs.end;
          const def = readOpt(src, j);
          if (def) j = def.end;
          const body = readArg(src, j);
          const key = nm.content.trim().replace(/^\\/, '');
          if (name !== 'providecommand' || !this.macros[key]) {
            this.macros[key] = { nargs: nargs ? parseInt(nargs.content, 10) || 0 : 0, def: def ? def.content : null, body: body.content };
            this._katexMacros = null;
          }
          return res('', body.end);
        }
        case 'def': case 'gdef': case 'edef': case 'xdef': {
          const nm = readArg(src, i);
          let j = nm.end;
          // The parameter text runs up to the body's brace. Besides #1#2 it
          // may hold delimiters, as in \def\pair(#1,#2){…}.
          let k = j;
          while (k < src.length && src[k] !== '{') k += src[k] === '\\' ? 2 : 1;
          const params = src.slice(j, k);
          const parts = params.split(/#[1-9]/);
          const body = readArg(src, k);
          const mac = { nargs: parts.length - 1, def: null, body: body.content };
          if (parts.some((p) => p.trim())) mac.delims = parts.map((p) => p.trim());
          // Tree symbols in the style of regularity structures papers:
          // \DeclareSymbol{name}{baseline}{TikZ} with \def\<#1>{\csname …#1\endcsname}.
          // KaTeX has no \csname, so \<b0> goes through \texglassTree, which
          // draws the symbol (see treeMarker).
          if (nm.content === '\\<' && /\\csname/.test(mac.body)) mac.body = '\\texglassTree{#1}';
          this.macros[nm.content.replace(/^\\/, '')] = mac;
          this._katexMacros = null;
          return res('', body.end);
        }
        case 'let': {
          const m = /^\s*\\([A-Za-z@]+)\s*=?\s*(\\[A-Za-z@]+|.)/.exec(src.slice(i));
          if (!m) return res('', i);
          // \let\cmd\@undefined (or \undefined) forgets \cmd, as before redefining it
          if (/^\\(@undefined|undefined)$/.test(m[2])) delete this.macros[m[1]];
          else this.macros[m[1]] = { nargs: 0, def: null, body: m[2] };
          this._katexMacros = null;
          return res('', i + m[0].length);
        }
        case 'DeclareSymbol': {
          // \DeclareSymbol{b0}{-3}{\node[bxi]{};}: a tree symbol, used as \<b0>.
          const nm = readArg(src, i);
          const bl = readArg(src, nm.end);
          const body = readArg(src, bl.end);
          (this.treeSymbols || (this.treeSymbols = Object.create(null)))[nm.content.trim()] = { baseline: bl.content.trim(), body: body.content };
          return res('', body.end);
        }
        case 'texglassTree': {
          const a = readArg(src, i);
          return res(this.inlineMath(`\\texglassTree{${a.content}}`), a.end);
        }
        case 'definealphabet': {
          // \definealphabet{mc}{\mathcal}{A}{Z} defines \mcA ... \mcZ (a common
          // expl3 helper in authors' own .sty files).
          const pre = readArg(src, i);
          const cmd = readArg(src, pre.end);
          const from = readArg(src, cmd.end);
          const to = readArg(src, from.end);
          const a = from.content.trim().codePointAt(0);
          const b = to.content.trim().codePointAt(0);
          if (/^[A-Za-z@]+$/.test(pre.content.trim()) && a && b && b - a < 64) {
            for (let c = a; c <= b; c++) {
              const ch = String.fromCodePoint(c);
              if (!/[A-Za-z]/.test(ch)) continue;
              this.macros[pre.content.trim() + ch] = { nargs: 0, def: null, body: `${cmd.content.trim()}{${ch}}` };
            }
            this._katexMacros = null;
          }
          return res('', to.end);
        }
        case 'DeclareMathOperator': {
          const s = readStar(src, i);
          const nm = readArg(src, s.end);
          const body = readArg(src, nm.end);
          this.macros[nm.content.trim().replace(/^\\/, '')] = {
            nargs: 0, def: null, body: `\\operatorname${s.star ? '*' : ''}{${body.content}}`,
          };
          this._katexMacros = null;
          return res('', body.end);
        }
        case 'DeclareMathDelimiter': {
          // \DeclareMathDelimiter{\cs}{type}{font}{slot}{largefont}{slot} on slot 152 of a fourier font
          // is the usual way to get the triple bar ⦀. Other glyphs from
          // font slots can't be known, so only the triple bar is drawn.
          const nm = readArg(src, i);
          const args = [];
          let j = nm.end;
          for (let k = 0; k < 5; k++) { const a = readArg(src, j); args.push(a.content.trim()); j = a.end; }
          const cs = nm.content.trim();
          if (/^\\(v?vvert|Vvert|VERT|tvert|tnorm|triplevert|vertiii)$/.test(cs) || (/fourier/i.test(args[1]) && args[2] === '152')) {
            if (!this.triple.includes(cs)) this.triple.push(cs);
            this._katexMacros = null;
          }
          return res('', j);
        }
        case 'DeclarePairedDelimiter': case 'DeclarePairedDelimiterX': case 'DeclarePairedDelimiterXPP': {
          // mathtools: \norm{x}, \norm*{x} (\left…\right) and \norm[\big]{x}.
          const nm = readArg(src, i);
          let j = nm.end;
          const x = name !== 'DeclarePairedDelimiter';
          let nargs = 1;
          if (x) {
            const n = readOpt(src, j);
            if (n) j = n.end;
            nargs = n ? parseInt(n.content, 10) || 0 : 0;
          }
          const take = () => { const a = readArg(src, j); j = a.end; return a.content; };
          const pre = name === 'DeclarePairedDelimiterXPP' ? take() : '';
          const open = take();
          const close = take();
          const post = name === 'DeclarePairedDelimiterXPP' ? take() : '';
          const body = x ? take() : '#1';
          this.paired[nm.content.trim().replace(/^\\/, '')] = { nargs, pre, open, close, post, body };
          this._katexMacros = null;
          return res('', j);
        }
        case 'newenvironment': {
          const s = readStar(src, i);
          const nm = readArg(src, s.end);
          let j = nm.end;
          const nargs = readOpt(src, j);
          if (nargs) j = nargs.end;
          const def = readOpt(src, j);
          if (def) j = def.end;
          const begin = readArg(src, j);
          const end = readArg(src, begin.end);
          this.envs[nm.content.trim()] = {
            nargs: nargs ? parseInt(nargs.content, 10) || 0 : 0, def: def ? def.content : null,
            begin: begin.content, end: end.content,
          };
          return res('', end.end);
        }
        case 'newtheorem': {
          const s = readStar(src, i);
          const env = readArg(src, s.end);
          let j = env.end;
          const shared = readOpt(src, j);
          if (shared) j = shared.end;
          const title = readArg(src, j);
          j = title.end;
          const within = shared ? null : readOpt(src, j);
          if (within) j = within.end;
          const key = env.content.trim();
          let counter = null;
          if (!s.star) {
            if (shared) {
              const sh = shared.content.trim();
              counter = this.theorems[sh] ? this.theorems[sh].counter : sh;
              this.newCounter(counter, null);
            } else {
              counter = key;
              this.counters[key] = { value: 0, parent: within ? within.content.trim() : null };
            }
          }
          this.theorems[key] = { title: title.content, counter, style: this.thmStyle };
          return res('', j);
        }
        case 'theoremstyle': {
          const a = readArg(src, i);
          this.thmStyle = a.content.trim();
          return res('', a.end);
        }
        case 'numberwithin': {
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          const b = readArg(src, a.end);
          this.newCounter(a.content.trim(), null);
          this.counters[a.content.trim()].parent = b.content.trim();
          return res('', b.end);
        }
        case 'newcounter': {
          const a = readArg(src, i);
          const o = readOpt(src, a.end);
          this.newCounter(a.content.trim(), o ? o.content.trim() : null);
          return res('', o ? o.end : a.end);
        }
        case 'setcounter': case 'addtocounter': {
          const a = readArg(src, i);
          const b = readArg(src, a.end);
          const v = parseInt(b.content, 10);
          const key = a.content.trim();
          this.newCounter(key, null);
          if (!isNaN(v)) this.counters[key].value = name === 'setcounter' ? v : this.counters[key].value + v;
          return res('', b.end);
        }
        case 'stepcounter': case 'refstepcounter': {
          const a = readArg(src, i);
          const key = a.content.trim();
          this.step(key);
          if (name === 'refstepcounter') this.target = { num: this.fmt(key), kind: key, id: this.newId(key) };
          return res(name === 'refstepcounter' ? `<span id="${this.target.id}"></span>` : '', a.end);
        }
        case 'arabic': case 'roman': case 'Roman': case 'alph': case 'Alph': case 'value': {
          const a = readArg(src, i);
          const c = this.counters[a.content.trim()];
          const v = c ? c.value : 0;
          const f = { arabic: String(v), value: String(v), roman: roman(v), Roman: roman(v, true), alph: alpha(v), Alph: alpha(v, true) };
          return res(f[name], a.end);
        }
        case 'bibitem':
          return res('', readArg(src, readOpt(src, i) ? readOpt(src, i).end : i).end);
      }

      if (name.startsWith('the') && this.counters[name.slice(3)]) return res(escapeHtml(this.fmt(name.slice(3))), i);

      // User macros used in text.
      if (this.macros[name]) return this.expandMacro(this.macros[name], src, i, inline);

      // Unknown command: drop the name, show its arguments.
      let j = readStar(src, i).end;
      let html = '';
      for (;;) {
        const o = readOpt(src, j);
        if (o) { j = o.end; continue; }
        const k = skipInline(src, j);
        if (src[k] !== '{') break;
        const g = readGroup(src, k);
        html += this.flow(g.content, true);
        j = g.end;
      }
      if (!this.known) this.warnings.push(`Unknown command \\${name}.`);
      return res(html, j);
    }

    expandMacro(m, src, i, inline) {
      const args = [];
      let j = i;
      if (m.delims) {
        // \def with delimited parameters: each argument runs up to the text
        // that follows it in the definition.
        const lead = m.delims[0];
        const at = skipWhite(src, j);
        if (lead) {
          if (!src.startsWith(lead, at)) return { html: '', end: j };
          j = at + lead.length;
        }
      }
      for (let k = 0; k < m.nargs; k++) {
        const stop = m.delims && m.delims[k + 1];
        if (stop) {
          const e = findDelim(src, j, stop);
          args.push(src.slice(j, e).trim());
          j = Math.min(src.length, e + stop.length);
          continue;
        }
        if (k === 0 && m.def !== null) {
          const o = readOpt(src, j);
          args.push(o ? o.content : m.def);
          if (o) j = o.end;
          continue;
        }
        const a = readArg(src, j);
        args.push(a.content);
        j = a.end;
      }
      // A macro that calls itself (often package code that wraps the old
      // meaning of a command we cannot keep apart, as \let\old\cmd then
      // \def\cmd{...\old...}) would expand forever, or exponentially often
      // when it calls itself twice. Stop at a few nested expansions of the same
      // macro, and after a generous number of expansions in all.
      const open = this.expanding.get(m) || 0;
      if (open >= MACRO_NESTING || ++this.expansions > MACRO_EXPANSIONS) {
        if (!this.expansionWarned) {
          this.expansionWarned = true;
          this.warnings.push('A macro expands without end; its deeper expansions are left out.');
        }
        return { html: '', end: j };
      }
      this.expanding.set(m, open + 1);
      try {
        const body = m.body.replace(/#(\d)/g, (_, d) => (args[d - 1] !== undefined ? args[d - 1] : ''));
        // Math-only macros (\R -> \mathbb{R}) are sometimes used in text; TeX
        // would complain, we just render them as math.
        if (this.isMathBody(body, 0)) return { html: this.inlineMath(body), end: j };
        return { html: this.flow(body, true), end: j };
      } finally {
        this.expanding.set(m, open);
      }
    }

    /**
     * Whether a macro body only makes sense as math, directly or through
     * another user macro (\newcommand{\RR}{\R}). Bodies that switch to math
     * themselves ($…$, \ensuremath) or hold links are left as text.
     */
    isMathBody(body, depth, seen) {
      if (/\$|\\\(|\\(?:ensuremath|url|href|text[a-z]*|begin)(?![A-Za-z])/.test(body)) return false;
      if (MATH_ONLY.test(body)) return true;
      if (depth > 8) return false;
      // Each macro is looked into once: package code (an author's own copy of
      // a .sty) has macros that use many others, and walking every path
      // through them takes exponential time.
      seen = seen || new Set();
      const re = /\\([A-Za-z@]+)/g;
      let m;
      while ((m = re.exec(body))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const mac = this.macros[m[1]];
        if (mac && this.isMathBody(mac.body, depth + 1, seen)) return true;
      }
      return false;
    }

    // --- footnotes, citations, title, toc ----------------------------------

    footnote(text) {
      this.footnotes.push(null);
      const k = this.footnotes.length;
      this.footnotes[k - 1] = this.flow(text, true);
      return `<sup class="fn"><a href="#fn-${k}" id="fnref-${k}">${k}</a></sup>`;
    }

    citeHtml(keys, note) {
      const table = this.known ? this.known.cites : this.cites;
      const parts = keys.split(',').map((k) => k.trim()).filter(Boolean).map((k) => {
        const c = table[k];
        if (!c) {
          if (this.known && Object.keys(table).length) this.warnings.push(`Undefined citation "${k}".`);
          return `<span class="cite-key">${escapeHtml(k)}</span>`;
        }
        return `<a href="#${c.id}">${escapeHtml(c.label)}</a>`;
      });
      if (note) parts.push(this.flow(note, true));
      return `<span class="cite">[${parts.join(', ')}]</span>`;
    }

    titleBlock() {
      const m = this.meta;
      if (!m.title && !m.author) return '';
      let html = '<header class="title-block">';
      if (m.title) html += `<h1 class="doc-title">${this.flow(m.title, true)}</h1>`;
      if (m.author) {
        const authors = splitTop(m.author, commandSep('and')).map((a) => `<span class="author">${this.flow(a.trim(), true)}</span>`);
        html += `<div class="authors">${authors.join('')}</div>`;
      }
      const date = m.date === null ? this.options.today || formatToday() : this.flow(m.date, true);
      if (date) html += `<div class="doc-date">${m.date === null ? escapeHtml(date) : date}</div>`;
      return html + '</header>';
    }

    tocHtml() {
      const toc = this.known ? this.known.toc : [];
      if (!toc.length) return '';
      const items = toc
        .map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${t.num ? `<span class="toc-num">${escapeHtml(t.num)}</span>` : ''}${t.title}</a></li>`)
        .join('');
      return `<nav class="toc"><h2>Contents</h2><ul>${items}</ul></nav>`;
    }

    // --- sectioning --------------------------------------------------------

    section(name, src, i) {
      const s = readStar(src, i);
      const o = readOpt(src, s.end);
      const a = readArg(src, o ? o.end : s.end);
      const title = this.flow(a.content, true);
      const id = this.newId('sec');
      const level = SECTIONS[name];
      let num = '';
      const numbered = !s.star && level <= 4 && (this.topLevel === 'chapter' || name !== 'chapter');
      if (numbered) {
        this.step(name);
        num = this.fmt(name);
      }
      const kind = this.appendix && name === this.topLevel ? 'appendix' : name;
      this.target = { num, kind, id, name: stripTags(title) };
      if (level >= 5) {
        return { html: `<strong class="run-in" id="${id}">${title}</strong> `, end: a.end, parbreak: true };
      }
      if (!s.star || level <= 2) this.toc.push({ level, num, title: o ? this.flow(o.content, true) : title, id });
      const tag = 'h' + Math.min(6, Math.max(1, level));
      const prefix = num ? `<span class="secnum">${this.appendix && name === this.topLevel && name === 'chapter' ? 'Appendix ' : ''}${escapeHtml(num)}</span>` : '';
      return { html: `<${tag} id="${id}" class="${name}">${prefix}${title}</${tag}>`, end: a.end, block: true };
    }

    caption(text) {
      const kind = this.floatKind || 'figure';
      this.step(kind);
      const num = this.fmt(kind);
      const id = this.newId(kind);
      const kindName = kind === 'table' ? 'Table' : 'Figure';
      this.target = { num, kind, id, name: '' };
      return `<div class="caption" id="${id}"><span class="caption-head">${kindName} ${escapeHtml(num)}.</span> ${this.flow(text, true)}</div>`;
    }

    // --- environments ------------------------------------------------------

    environment(name, src, i, inline) {
      const isVerbatim = /^(verbatim\*?|lstlisting|minted|Verbatim)$/.test(name);
      let body;
      let end;
      if (isVerbatim) {
        const close = src.indexOf(`\\end{${name}}`, i);
        const stop = close < 0 ? src.length : close;
        body = src.slice(i, stop);
        end = close < 0 ? src.length : close + name.length + 6;
      } else {
        const e = findEnvEnd(src, i, name);
        body = src.slice(i, e.contentEnd);
        end = e.end;
      }
      const saved = this.target;
      const html = this.environmentHtml(name, body, isVerbatim, inline);
      this.target = saved; // labels are scoped like TeX groups
      const isInline = name === 'math';
      return { html, end, block: !isInline };
    }

    environmentHtml(name, body, isVerbatim, inline) {
      if (isVerbatim) {
        let code = body;
        if (name === 'minted') code = code.replace(/^\s*(\[[^\]]*\])?\s*\{[^}]*\}/, '');
        if (name === 'lstlisting') code = code.replace(/^\s*\[[^\]]*\]/, '');
        return `<pre class="verbatim"><code>${escapeHtml(code.replace(/^\n/, '').replace(/\s+$/, ''))}</code></pre>`;
      }
      if (name === 'math') return this.inlineMath(body);
      if (MATH_ENVS.has(name)) return this.displayMath(name, body);
      if ((name === 'equ' || name === 'equs') && !this.envs[name]) return this.mhequ(name, body);

      if (name === 'proof') {
        const o = readOpt(body, 0);
        const head = o ? this.flow(o.content, true) : 'Proof';
        const content = this.flow(o ? body.slice(o.end) : body, false);
        const hasQed = /class="qed"/.test(content);
        let html = attachHead(`<span class="proof-head">${head}.</span> `, content);
        if (!hasQed) {
          const qed = '<span class="qed">∎</span>';
          html = html.endsWith('</p>') ? html.slice(0, -4) + qed + '</p>' : html + `<p class="qed-line">${qed}</p>`;
        }
        return `<div class="proof">${html}</div>`;
      }

      const thm = this.theoremDef(name);
      if (thm) return this.theorem(name, thm, body);

      if (this.envs[name]) {
        const e = this.envs[name];
        const args = [];
        let j = 0;
        for (let k = 0; k < e.nargs; k++) {
          if (k === 0 && e.def !== null) {
            const o = readOpt(body, j);
            args.push(o ? o.content : e.def);
            if (o) j = o.end;
            continue;
          }
          const a = readArg(body, j);
          args.push(a.content);
          j = a.end;
        }
        const sub = (s) => s.replace(/#(\d)/g, (_, d) => args[d - 1] || '');
        return `<div class="env env-${escapeHtml(name)}">${this.flow(sub(e.begin) + '\n' + body.slice(j) + '\n' + e.end, false)}</div>`;
      }

      switch (name) {
        case 'document':
          return this.flow(body, false);
        case 'frontmatter': {
          // imsart, elsarticle: \title, \author, … and the abstract inside, with
          // no \maketitle (the class sets the title at the end of the environment)
          const html = this.flow(body, false);
          if (this.titleShown) return html;
          this.titleShown = true;
          if (this.meta.date === null) this.meta.date = ''; // these classes print no date
          return this.titleBlock() + html;
        }
        case 'keyword': {
          // imsart: \begin{keyword}[class=MSC] \kwd[Primary ]{60H10} \kwd{60G99} \end{keyword};
          // elsarticle: \begin{keyword} a \sep b \MSC[2010] 60H10 \end{keyword}
          const o = readOpt(body, 0);
          const cls = o && /class\s*=\s*([A-Za-z]+)/.exec(o.content);
          let rest = o ? body.slice(o.end) : body;
          const items = [];
          if (/\\kwd(?![A-Za-z])/.test(rest)) {
            const re = /\\kwd(?![A-Za-z])/g;
            let m;
            while ((m = re.exec(rest))) {
              const p = readOpt(rest, m.index + 4);
              const a = readArg(rest, p ? p.end : m.index + 4);
              items.push((p ? p.content : '') + a.content.trim());
              re.lastIndex = a.end;
            }
          } else {
            rest = rest.replace(/\\(?:MSC|PACS|JEL)\s*(\[[^\]]*\])?/g, (t) => `\\sep ${t.replace(/^\\/, '').replace(/[\[\]]/g, ' ').trim()} `);
            for (const t of splitTop(rest, commandSep('sep'))) if (t.trim()) items.push(t.trim());
          }
          const head = cls ? `${cls[1]} subject classifications` : 'Keywords';
          return `<div class="keywords"><span class="keywords-head">${escapeHtml(head)}:</span> ${items.map((t) => this.flow(t, true)).join(', ')}</div>`;
        }
        case 'abstract':
          return `<div class="abstract"><div class="abstract-title">Abstract</div>${this.flow(body, false)}</div>`;
        case 'itemize': case 'enumerate': case 'description': case 'compactitem': case 'compactenum':
        case 'inparaenum': case 'asparaenum':
          return this.list(name, body);
        case 'thebibliography':
          return this.bibliography(body);
        case 'bibdiv': case 'biblist': {
          // amsrefs: \bib{key}{type}{fields} records, turned into a thebibliography.
          const Bib = bibReader();
          if (!Bib) return '';
          const alpha = /\\usepackage\s*\[[^\]]*\balphabetic\b[^\]]*\]\s*\{amsrefs\}/.test(this.preamble || '');
          return this.bibliography(Bib.amsrefsBibliography(body, alpha));
        }
        case 'figure': case 'figure*': case 'table': case 'table*': case 'wrapfigure': {
          const prev = this.floatKind;
          this.floatKind = name.startsWith('table') ? 'table' : 'figure';
          const kind = this.floatKind;
          const content = this.flow(body.replace(/^\s*\[[^\]]*\]/, ''), false);
          this.floatKind = prev;
          return `<figure class="float float-${kind}">${content}</figure>`;
        }
        case 'tabular': case 'tabular*': case 'tabularx': case 'array': case 'longtable':
          return this.tabular(name, body);
        case 'center':
          return `<div class="center">${this.flow(body, false)}</div>`;
        case 'flushleft': case 'flushright':
          return `<div class="${name}">${this.flow(body, false)}</div>`;
        case 'quote': case 'quotation': case 'verse':
          return `<blockquote>${this.flow(body, false)}</blockquote>`;
        case 'minipage': {
          const o = readOpt(body, 0);
          const w = readArg(body, o ? o.end : 0);
          return `<div class="minipage">${this.flow(body.slice(w.end), false)}</div>`;
        }
        case 'tikzcd':
          if (tikz()) return tikz().tikzcd(body, (t, display) => this.renderMath(t, display));
          return `<div class="graphic-placeholder">[tikzcd diagram]</div>`;
        case 'tikzpicture':
          return this.tikzpicture(body);
        case 'picture': case 'pgfpicture': case 'axis':
          return `<div class="graphic-placeholder">[${escapeHtml(name)} diagram]</div>`;
        default:
          return `<div class="env env-${escapeHtml(name.replace(/\*/g, ''))}">${this.flow(body.replace(/^\s*\[[^\]]*\]/, ''), false)}</div>`;
      }
    }

    theoremDef(name) {
      if (this.theorems[name]) return this.theorems[name];
      const starred = name.endsWith('*');
      const base = starred ? name.slice(0, -1) : name;
      const def = this.theorems[base] || (DEFAULT_THEOREMS[base] && {
        title: DEFAULT_THEOREMS[base][0], counter: '__thm', style: DEFAULT_THEOREMS[base][1],
      });
      if (!def) return null;
      return starred ? Object.assign({}, def, { counter: null }) : def;
    }

    theorem(name, def, body) {
      const o = readOpt(body, 0);
      let num = '';
      if (def.counter) {
        this.step(def.counter);
        num = this.fmt(def.counter);
      }
      const id = this.newId('thm');
      const titleHtml = this.flow(def.title, true);
      const note = o ? this.flow(o.content, true) : '';
      this.target = { num, kind: name, kindName: stripTags(titleHtml), id, name: stripTags(note) || stripTags(titleHtml) + (num ? ' ' + num : '') };
      const head =
        `<span class="thm-head"><span class="thm-name">${titleHtml}${num ? ' ' + escapeHtml(num) : ''}</span>` +
        (note ? ` <span class="thm-note">(${note})</span>` : '') +
        '.</span> ';
      const content = this.flow(o ? body.slice(o.end) : body, false);
      const style = /^(plain|definition|remark)$/.test(def.style) ? def.style : 'plain';
      const cls = `theorem thm-${style} thm-env-${escapeHtml(name.replace(/\*/g, ''))}`;
      return `<div class="${cls}" id="${id}" data-number="${escapeHtml(num)}">${attachHead(head, content)}</div>`;
    }

    list(name, body) {
      const isEnum = /enum/.test(name);
      const isDesc = name === 'description';
      let opt = null;
      const o = readOpt(body, 0);
      if (o) { opt = o.content; body = body.slice(o.end); }
      this.listDepth++;
      const depth = this.listDepth;
      const counter = 'enum' + roman(Math.min(depth, 4));
      if (isEnum) {
        this.newCounter(counter, null);
        this.counters[counter].value = 0;
      }
      const parentNum = isEnum && this.enumRefPrefix ? this.enumRefPrefix : '';
      const items = splitTop(body, commandSep('item')).slice(1);
      let template = null;
      if (isEnum && opt) {
        const m = /label\s*=\s*(\{[^}]*\}|[^,]*)/.exec(opt);
        template = m ? m[1].replace(/^\{|\}$/g, '') : /\\(alph|Alph|roman|Roman|arabic)\*?|\b[aAiI1]\b/.test(opt) ? opt : null;
      }
      const out = items.map((item) => {
        let label = '';
        const io = readOpt(item, 0);
        if (io) item = item.slice(io.end);
        const id = this.newId('item');
        if (io) label = this.flow(io.content, true);
        if (isEnum) {
          this.counters[counter].value++;
          const v = this.counters[counter].value;
          const formatted = formatEnum(depth, v, template);
          if (!io) label = escapeHtml(formatted.label);
          this.target = { num: parentNum + formatted.ref, kind: 'item', id, name: '' };
        } else if (!io) {
          label = ['•', '–', '∗', '·'][(depth - 1) % 4];
        }
        const savedPrefix = this.enumRefPrefix;
        if (isEnum) this.enumRefPrefix = this.target.num;
        const content = this.flow(item, false);
        this.enumRefPrefix = savedPrefix;
        return `<li class="item" id="${id}"><span class="item-label">${label}</span><div class="item-body">${content}</div></li>`;
      });
      this.listDepth--;
      const cls = isDesc ? 'description' : isEnum ? 'enumerate' : 'itemize';
      return `<ul class="list ${cls}">${out.join('')}</ul>`;
    }

    bibliography(body) {
      const w = readArg(body, 0); // widest label
      const items = splitTop(body.slice(w.end), commandSep('bibitem')).slice(1);
      let k = 0;
      const out = items.map((item) => {
        k++;
        const o = readOpt(item, 0);
        const key = readArg(item, o ? o.end : 0);
        const label = o ? stripTags(this.flow(o.content, true)) : String(k);
        const id = this.newId('bib');
        this.cites[key.content.trim()] = { label, id };
        return `<li id="${id}"><span class="bib-label">[${escapeHtml(label)}]</span><div class="bib-body">${this.flow(item.slice(key.end), true)}</div></li>`;
      });
      const heading = this.topLevel === 'chapter' ? 'Bibliography' : 'References';
      return `<section class="bibliography"><h2>${heading}</h2><ol>${out.join('')}</ol></section>`;
    }

    tabular(name, body) {
      let j = 0;
      if (name === 'tabular*' || name === 'tabularx') j = readArg(body, 0).end;
      const o = readOpt(body, j);
      if (o) j = o.end;
      const spec = readArg(body, j);
      const aligns = [];
      const specStr = spec.content.replace(/[@!<>]\{[^}]*\}|\*\{[^}]*\}\{[^}]*\}/g, '');
      for (let k = 0; k < specStr.length; k++) {
        const ch = specStr[k];
        if (/[lcrX]/.test(ch)) aligns.push(ch === 'c' ? 'center' : ch === 'r' ? 'right' : 'left');
        else if (/[pmb]/.test(ch) && specStr[k + 1] === '{') {
          aligns.push('left');
          k = readGroup(specStr, k + 1).end - 1;
        }
      }
      const content = body.slice(spec.end).replace(/\\(hline|toprule|midrule|bottomrule|endhead|endfirsthead|endfoot|endlastfoot)\b/g, '').replace(/\\(cline|cmidrule)(\([^)]*\))?\{[^}]*\}/g, '');
      const rows = splitTop(content, rowSep).filter((r) => r.trim());
      if (name === 'array') {
        return this.displayMath('displaymath', `\\begin{array}{${spec.content}}${body.slice(spec.end)}\\end{array}`);
      }
      const trs = rows.map((r) => {
        const cells = splitTop(r, cellSep);
        let col = 0;
        const tds = cells.map((cell) => {
          let span = 1;
          let align = aligns[col] || 'left';
          let text = cell.trim();
          const mc = /^\\multicolumn\s*\{(\d+)\}\s*\{([^}]*)\}/.exec(text);
          if (mc) {
            span = parseInt(mc[1], 10);
            align = /c/.test(mc[2]) ? 'center' : /r/.test(mc[2]) ? 'right' : 'left';
            text = readArg(text, mc[0].length).content;
          }
          col += span;
          return `<td${span > 1 ? ` colspan="${span}"` : ''} style="text-align:${align}">${this.flow(text, true)}</td>`;
        });
        return `<tr>${tds.join('')}</tr>`;
      });
      return `<div class="table-wrap"><table class="tabular"><tbody>${trs.join('')}</tbody></table></div>`;
    }

    // --- display math with equation numbering -----------------------------

    displayMath(name, body) {
      const starred = name.endsWith('*') || name === 'displaymath';
      const base = name.replace(/\*$/, '');
      const id = this.newId('eq');
      // The source to copy: the formula as written, with the environment kept
      // where its rows need it (align, gather, ...).
      const src = texAttr(/^(align|gather|flalign|alignat|eqnarray|multline)$/.test(base) ? `\\begin{${name}}${body}\\end{${name}}` : body);
      if (DIAGRAM_RE.test(body) && tikz()) {
        // A diagram (with maybe some math around it and an equation number).
        const r = this.numberRow(body.replace(/\\\\\s*$/, ''), !starred && base !== 'displaymath', id);
        const t = /\\tag(\*?)\{(.*)\}$/.exec(r.tag);
        // with no number, an empty tag still balances the spacer on the left, so the diagram is centred
        const tag = `<span class="diagram-tag">${t ? this.renderMath(t[1] ? t[2] : `(${t[2]})`, false) : ''}</span>`;
        return `<div class="math math-display diagram-display" id="${id}"${src}><span class="diagram-row">${this.mathWithDiagrams(r.tex)}</span>${tag}</div>`;
      }
      const multiRow = /^(align|gather|flalign|alignat|eqnarray)$/.test(base);
      let tex;
      if (!multiRow) {
        const r = this.numberRow(body, !starred && base !== 'displaymath', id);
        let inner = r.tex;
        if (base === 'multline') inner = `\\begin{gathered}${inner}\\end{gathered}`;
        tex = inner + r.tag;
      } else {
        let lead = '';
        if (base === 'alignat') {
          const a = readArg(body, 0);
          lead = `{${a.content}}`;
          body = body.slice(a.end);
        }
        const rows = splitTop(body, rowSep);
        const env = base === 'gather' ? 'gather*' : base === 'alignat' ? 'alignat*' : 'align*';
        // \intertext{…} between rows: end the display, put the text, start another.
        const parts = [];
        let group = [];
        let groupId = id;
        rows.forEach((row, k) => {
          const it = /^\s*\\(?:short)?intertext\s*(?=\{)/.exec(row);
          if (it) {
            const a = readArg(row, it[0].length);
            if (group.length) parts.push({ id: groupId, rows: group });
            parts.push({ text: a.content });
            group = [];
            groupId = this.newId('eq');
            row = row.slice(a.end);
          }
          if (!row.trim() && k === rows.length - 1) return;
          if (base === 'eqnarray') {
            // a & = & b  ->  a &= {} b
            const cells = splitTop(row, cellSep);
            if (cells.length >= 3) row = `${cells[0]} &${cells[1]}{} ${cells.slice(2).join(' ')}`;
          }
          const r = this.numberRow(row, !starred, groupId);
          group.push(r.tex + r.tag);
        });
        if (group.length) parts.push({ id: groupId, rows: group });
        if (parts.length > 1 || (parts[0] && parts[0].text !== undefined)) {
          return parts
            .map((g) =>
              g.text !== undefined
                ? `<p class="intertext">${this.flow(g.text, true)}</p>`
                : `<div class="math math-display" id="${g.id}"${src}>${this.renderMath(`\\begin{${env}}${lead}${g.rows.join(' \\\\ ')}\\end{${env}}`, true)}</div>`
            )
            .join('');
        }
        tex = `\\begin{${env}}${lead}${(parts[0] ? parts[0].rows : []).join(' \\\\ ')}\\end{${env}}`;
      }
      return `<div class="math math-display" id="${id}"${src}>${this.renderMath(tex, true)}</div>`;
    }

    /**
     * KaTeX source for the tree symbol \<name>: a rule of the picture's size,
     * tinted with a colour that names it, so putTrees can swap the drawing in.
     * Unknown symbols, or ones the TikZ reader cannot draw, show as ⟨name⟩.
     */
    treeMarker(name) {
      const fallback = `{\\scriptstyle\\langle\\mathtt{${name.replace(/[\\{}$&#^_%~]/g, '')}}\\rangle}`;
      const syms = this.treeSymbols || {};
      // \<b0s> and \<b0ss> are the same symbol made smaller for sub- and superscripts.
      const key = syms[name] ? name : syms[name.replace(/s$/, '')] ? name.replace(/s$/, '') : syms[name.replace(/ss$/, '')] ? name.replace(/ss$/, '') : null;
      if (!key || !tikz()) return fallback;
      this.trees = this.trees || { byName: Object.create(null), list: [] };
      let t = this.trees.byName[key];
      if (t === undefined) {
        t = this.trees.byName[key] = this.treePicture(syms[key]);
        if (t) {
          t.color = `#a5${this.trees.list.length.toString(16).padStart(4, '0')}`;
          this.trees.list.push(t);
        }
      }
      if (!t) return fallback;
      return `\\textcolor{${t.color}}{\\rule[${t.raise}em]{${t.width}em}{${t.height}em}}`;
    }

    /** Draw one \DeclareSymbol with the options of the document's own \DeclareSymbol, if it has one. */
    treePicture(sym) {
      let opts = 'baseline=#2,scale=0.15,draw=symbols,line join=round,line cap=round';
      const own = this.macros.DeclareSymbol && /\\tikz\s*\[([^\]]*#2[^\]]*)\]/.exec(this.macros.DeclareSymbol.body);
      if (own) opts = own[1];
      const baseline = /^[+-]?[\d.]+$/.test(sym.baseline) ? `${sym.baseline}pt` : sym.baseline;
      const html = this.tikzpicture(`[${opts.replace(/#2/g, baseline)}]${sym.body}`);
      const m = /data-tikz="([^"]*)"/.exec(html);
      if (!m || /tikz-fallback|tikz-note/.test(html)) return null;
      let data;
      try {
        data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      } catch (e) {
        return null;
      }
      const S = 2.8453; // em per cm
      const [x0, y0, x1, y1] = data.bbox;
      const base = typeof data.baseline === 'number' ? data.baseline : y0;
      const r = (x) => Math.round(x * 1000) / 1000;
      return {
        html: html.replace('class="tg-diagram tg-tikz"', 'class="tg-diagram tg-tikz tg-tree"'),
        width: r((x1 - x0) * S + 0.1),
        height: r((y1 - y0) * S + 0.1),
        raise: r((y0 - base) * S - 0.05),
      };
    }

    /** Put the drawings of tree symbols where treeMarker left their rules in KaTeX's output. */
    putTrees(html) {
      return html.replace(/<span class="mord rule( mtight)?" style="color:(#a5[0-9a-f]{4});[^"]*"><\/span>/g, (m, tight, color) => {
        const t = this.trees.list[parseInt(color.slice(3), 16)];
        return t ? `<span class="mord${tight || ''}">${t.html}</span>` : m;
      });
    }

    /**
     * Martin Hairer's mhequ package: \begin{equ}[label] and \begin{equs}[n][label].
     * An equation gets a number only when it has a label; in equs a [label]
     * numbers the whole block once, otherwise each row with a \label is numbered.
     */
    mhequ(name, body) {
      let label = null;
      for (let k = 0; k < (name === 'equs' ? 2 : 1); k++) {
        const o = readOpt(body, 0);
        if (!o) break;
        const c = o.content.trim();
        if (!(name === 'equs' && /^\d+$/.test(c))) label = c;
        body = body.slice(o.end);
      }
      body = body.replace(/\\(?:minilab|setlabtype)\s*\{[^}]*\}/g, '').replace(/\\multicol\s*\{\d+\}/g, '');
      const lab = label ? `\\label{${label}}` : '';
      if (name === 'equ') {
        return this.displayMath(label || /\\(label|tag)\s*\{/.test(body) ? 'equation' : 'equation*', body + lab);
      }
      if (label) {
        // One number for the block: the rows go in an aligned inside an equation.
        const tags = [];
        body = body.replace(/\\(?:nonumber|notag)\b/g, '').replace(/\\tag\*?\s*\{[^}]*\}/g, (t) => { tags.push(t); return ''; });
        return this.displayMath('equation', `\\begin{aligned}${body}\\end{aligned}${lab}${tags.slice(0, 1).join('')}`);
      }
      const rows = splitTop(body, rowSep).map((r) => (!r.trim() || /\\(label|tag)\s*\{/.test(r) ? r : `${r} \\nonumber`));
      return this.displayMath('align', rows.join(' \\\\ '));
    }

    /** Math that contains tikzcd, xymatrix or tikzpicture: diagrams between pieces of KaTeX. */
    mathWithDiagrams(tex) {
      const T = tikz();
      const math = (t, display) => this.renderMath(t, display);
      const out = [];
      let rest = unwrapDiagrams(tex.replace(/\\index\s*\{[^}]*\}|\\SelectTips\s*\{[^}]*\}\s*\{[^}]*\}/g, ''));
      // \xymatrixcolsep{…} and \xymatrixrowsep{…} apply to the next \xymatrix
      rest = rest.replace(/\\xymatrix(col|row)sep\s*\{([^}]*)\}\s*([\s\S]*?)\\xymatrix(?![A-Za-z])/g, (m, w, v, between) =>
        `${between}\\xymatrix@${w === 'col' ? 'C' : 'R'}=${v}`);
      const piece = (t) => {
        t = balanceMath(t).replace(/\\(?=[\n\r\t])/g, '\\ ').replace(/^\s+/, '').replace(/(?<!\\)\s+$/, '');
        if (t.trim()) out.push(`<span class="diagram-math">${this.renderMath(`\\displaystyle ${t}`, false)}</span>`);
      };
      for (let guard = 0; guard < 100; guard++) {
        const m = DIAGRAM_RE.exec(rest);
        if (!m) break;
        piece(rest.slice(0, m.index));
        if (m[1]) {
          const at = m.index + m[0].length;
          const e = findEnvEnd(rest, at, m[1]);
          const body = rest.slice(at, e.contentEnd);
          out.push(m[1] === 'tikzcd' ? T.tikzcd(body, math) : this.tikzpicture(body));
          rest = rest.slice(e.end);
        } else {
          const r = T.xymatrix(rest.slice(m.index + m[0].length), math);
          if (!r) { piece(rest.slice(m.index, m.index + m[0].length)); rest = rest.slice(m.index + m[0].length); continue; }
          out.push(r.html);
          rest = rest.slice(m.index + m[0].length + r.end);
        }
      }
      piece(rest);
      return out.join('');
    }

    tikzpicture(body) {
      const T = tikz();
      if (T && T.tikzpicture) {
        return T.tikzpicture(body, {
          math: (t, display) => this.renderMath(t, display),
          text: (t) => this.flow(t, true),
          styles: this.tikzStyles || '',
          colors: this.tikzColors || null,
          macros: this.macros,
        });
      }
      return `<span class="graphic-placeholder">[tikzpicture diagram]</span>`;
    }

    /** Expand user macros that stand for a \tag (\newcommand{\mytag}[1]{\tag{…}}), so the row is not numbered twice. */
    expandTagMacros(row) {
      const re = /\\([A-Za-z]+)/g;
      let m;
      while ((m = re.exec(row))) {
        const mac = this.macros[m[1]];
        if (!mac || !/\\tag\b/.test(mac.body)) continue;
        let j = m.index + m[0].length;
        const args = [];
        for (let k = 0; k < mac.nargs; k++) {
          if (k === 0 && mac.def !== null) {
            const o = readOpt(row, j);
            if (o) j = o.end;
            args.push(o ? o.content : mac.def);
          } else {
            const a = readArg(row, j);
            j = a.end;
            args.push(a.content);
          }
        }
        const body = mac.body.replace(/#(\d)/g, (_, d) => args[d - 1] || '');
        row = row.slice(0, m.index) + body + row.slice(j);
        re.lastIndex = m.index + body.length;
      }
      return row;
    }

    /** Number one equation row, registering its labels. */
    numberRow(row, numbered, id) {
      const labels = [];
      row = row.replace(/\\label\s*\{([^}]*)\}/g, (_, l) => { labels.push(l); return ''; });
      if (/\\(nonumber|notag)\b/.test(row)) {
        numbered = false;
        row = row.replace(/\\(nonumber|notag)\b/g, '');
      }
      row = this.expandTagMacros(row);
      let tag = '';
      let num = '';
      const t = /\\tag(\*?)\s*\{([^}]*)\}/.exec(row);
      if (t) {
        row = row.replace(t[0], '');
        num = t[2];
        tag = `\\tag${t[1]}{${t[2]}}`;
      } else if (numbered) {
        this.step('equation');
        num = this.fmt('equation');
        tag = `\\tag{${num}}`;
      }
      for (const l of labels) this.setLabel(l, { num, kind: 'equation', id, name: num });
      return { tex: row, tag };
    }
  }

  // ---------------------------------------------------------------------------
  // More helpers
  // ---------------------------------------------------------------------------

  function attachHead(head, content) {
    // Put a run-in heading ("Theorem 1.2.") inside the first paragraph.
    if (content.startsWith('<p>')) return '<p>' + head + content.slice(3);
    return `<p class="thm-head-only">${head}</p>${content}`;
  }

  /**
   * Where $…$ (or $$…$$) that starts at `from` ends: the first unescaped
   * token outside braces, so $x^{\text{$a$}}$ stays one formula. Unbalanced
   * braces fall back to the first unescaped token.
   */
  function findMathEnd(src, token, from) {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { if (--depth < 0) break; }
      else if (depth === 0 && src.startsWith(token, i)) return i;
      else if (c === '\n' && /^\n[ \t]*\n/.test(src.slice(i, i + 40))) break;
    }
    return findUnescaped(src, token, from);
  }

  function findUnescaped(src, token, from) {
    for (let i = from; i < src.length; i++) {
      if (src.startsWith(token, i)) return i;
      if (src[i] === '\\') i++;
    }
    return src.length;
  }

  function skipAfterWord(src, i) {
    // TeX ignores spaces (and one newline) after a control word.
    return skipWhite(src, i);
  }

  /** Where `delim` next occurs in src from i, outside braces (src.length if nowhere). */
  function findDelim(src, i, delim) {
    let depth = 0;
    for (let k = i; k < src.length; k++) {
      const c = src[k];
      if (depth === 0 && src.startsWith(delim, k)) return k;
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    return src.length;
  }

  function skipInline(src, i) {
    while (src[i] === ' ' || src[i] === '\t') i++;
    return i;
  }

  function dropArgs(src, i) {
    let j = readStar(src, i).end;
    for (;;) {
      const k = skipInline(src, j);
      if (src[k] === '[') {
        const o = readOpt(src, k);
        if (!o) break;
        j = o.end;
      } else if (src[k] === '{') j = readGroup(src, k).end;
      else break;
    }
    return j;
  }

  function formatEnum(depth, v, template) {
    if (template) {
      const map = { alph: alpha(v), Alph: alpha(v, true), roman: roman(v), Roman: roman(v, true), arabic: String(v) };
      let label;
      if (/\\(alph|Alph|roman|Roman|arabic)/.test(template)) {
        label = template.replace(/\\(alph|Alph|roman|Roman|arabic)\*?/g, (_, k) => map[k]);
      } else {
        // enumerate package style: [(a)], [i.], [A)]
        label = template.replace(/\b([aAiI1])\b/, (k) => ({ a: map.alph, A: map.Alph, i: map.roman, I: map.Roman, 1: map.arabic })[k]);
      }
      label = label.replace(/[{}]/g, '').replace(/\\/g, '');
      return { label, ref: label.replace(/\.$/, '') };
    }
    switch ((depth - 1) % 4) {
      case 0: return { label: `${v}.`, ref: String(v) };
      case 1: return { label: `(${alpha(v)})`, ref: alpha(v) };
      case 2: return { label: `${roman(v)}.`, ref: roman(v) };
      default: return { label: `${alpha(v, true)}.`, ref: alpha(v, true) };
    }
  }

  function formatToday() {
    const d = new Date();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function defaultRenderMath(tex, display, macros) {
    const k = typeof katex !== 'undefined' ? katex : null; // eslint-disable-line no-undef
    if (k) return k.renderToString(tex, { displayMode: display, throwOnError: false, macros, strict: 'ignore' });
    return `<code class="math-src">${escapeHtml(tex)}</code>`;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Render a LaTeX document to HTML.
   *
   * options.renderMath(tex, displayMode, macros) -> html   (defaults to global katex)
   * options.resolveImage(path) -> url | null
   * options.today  string used for \today
   * options.sourceMap  wrap each top-level block in <div class="src-block"
   *   data-s data-e> giving its range in the (newline-normalised) source
   *
   * Returns { html, title, labels, toc, warnings }, plus with sourceMap
   * `blocks`: the top-level blocks whose HTML, joined by newlines, is `html`
   * (the viewer uses them to update only the blocks that changed).
   */
  function render(source, options) {
    options = options || {};
    const stripped = stripCommentsMap(String(source).replace(/\r\n?/g, '\n'));
    const src = stripped.text;
    const first = new Renderer(options, null);
    first.run(src);
    const known = { labels: first.labels, toc: first.toc, cites: first.cites };
    const second = new Renderer(options, known);
    if (options.sourceMap) second.srcMap = stripped.map;
    const html = second.run(src);
    const warnings = Array.from(new Set(first.warnings.filter((w) => !/^Unknown command/.test(w)).concat(second.warnings)));
    return {
      html,
      blocks: options.sourceMap ? second.blocks || [] : undefined,
      title: second.meta.title ? stripTags(second.flow(second.meta.title, true)).trim() : null,
      labels: second.labels,
      toc: second.toc,
      // The paper's own macros, for the notation index (src/insight.js) and renderSnippets.
      defs: { macros: second.macros, paired: second.paired, triple: second.triple },
      warnings,
      unknownCommands: Array.from(new Set(first.warnings.filter((w) => /^Unknown command/.test(w)).map((w) => w.slice(16, -1)))),
    };
  }

  /**
   * Render small formulas with a document's macros (render(...).defs), such
   * as the symbols of its notation index. Returns one piece of HTML per formula.
   */
  function renderSnippets(defs, texs, options) {
    const r = new Renderer(options || {}, { labels: Object.create(null), toc: [], cites: Object.create(null) });
    if (defs) {
      Object.assign(r.macros, defs.macros || {});
      Object.assign(r.paired, defs.paired || {});
      if (defs.triple) r.triple = defs.triple.slice();
    }
    return texs.map((t) => r.renderMath(String(t), false));
  }

  return { render, renderSnippets, stripComments, escapeHtml };
});
