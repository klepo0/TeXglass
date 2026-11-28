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
    const t = String(tex).replace(/\\label\s*(?:\[[^\]]*\]\s*)?\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b[ \t]*/g, '').replace(/[ \t]+$/gm, '').trim();
    return t ? ` data-tex="${escapeHtml(t)}"` : '';
  };

  /**
   * A picture drawn only in part, or not at all, keeps its LaTeX source in
   * data-tg-source, so a host with a TeX installation can draw it instead
   * (src/texfallback.js). Pictures drawn in full carry nothing extra.
   */
  const withSource = (html, env, body) =>
    /class="(?:tikz-note|graphic-placeholder)|tikz-fallback/.test(html)
      ? html.replace(/^<(span|div)\b/, (m) => `${m} data-tg-source="${escapeHtml(`\\begin{${env}}${body}\\end{${env}}`)}"`)
      : html;

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


  // --- live parameters (texglass.sty \tgparam, \tgvalue; src/params.js) ---------

  const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
  // Commands LaTeX already has, which \tgparam leaves alone (\@ifundefined in texglass.sty)
  const LATEX_HAS = /^(a|b|c|d|H|i|j|k|l|L|o|O|P|r|S|t|u|v|aa|AA|ae|AE|oe|OE|ss|dh|DH|dj|DJ|ng|NG|th|TH|arg|cos|cot|coth|csc|deg|det|dim|exp|gcd|hom|inf|ker|lg|lim|ln|log|max|min|Pr|sec|sin|sinh|sup|tan|tanh|to|top|wp|ell|hbar|Re|Im|aleph|beth|mho|bot|vee|wedge|cap|cup|div|mid|ne|neq|le|leq|ge|geq|ll|gg|in|ni|pm|mp|cdot|times|star|ast|circ|bullet|prime|forall|exists|emptyset|nabla|partial|infty|sum|prod|int|oint|sqrt|frac|over|left|right|big|Big|line|par|item|label|ref|cite|text|mbox|hat|bar|vec|dot|ddot|tilde|check|breve|acute|grave|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)$/;
  const GREEK = /^(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)$/;

  /** A step of about a hundredth of the range, rounded to 1, 2 or 5 times a power of ten. */
  function niceStep(range) {
    if (!(range > 0)) return 1;
    const raw = range / 100;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * pow;
  }

  /**
   * \tgparam[start]{name}{min}{max} or \tgparam[start=2, step=0.5, label={$p$}]{name}{min}{max}
   * at src[i] (just after the command name): { param, end }, param null if it makes no sense.
   */
  function readParam(src, i) {
    const o = readOpt(src, i);
    const n = readArg(src, o ? o.end : i);
    const lo = readArg(src, n.end);
    const hi = readArg(src, lo.end);
    const name = n.content.trim().replace(/^\\/, '');
    const min = lo.content.trim();
    const max = hi.content.trim();
    if (!/^[A-Za-z]+$/.test(name) || !NUMBER_RE.test(min) || !NUMBER_RE.test(max) || +min >= +max) return { param: null, end: hi.end };
    const p = { name, min, max, start: null, step: null, label: null };
    const opt = o ? o.content.trim() : '';
    if (opt.includes('=')) {
      for (const part of splitTop(opt, (s, k) => (s[k] === ',' ? 1 : 0))) {
        const m = /^\s*(start|step|label)\s*=\s*([\s\S]*?)\s*$/.exec(part);
        if (m) p[m[1]] = m[2].replace(/^\{([\s\S]*)\}$/, '$1').trim();
      }
    } else if (opt) p.start = opt;
    if (p.start !== null && !NUMBER_RE.test(p.start)) p.start = null;
    if (p.step !== null && !(NUMBER_RE.test(p.step) && +p.step > 0)) p.step = null;
    if (p.start !== null) p.start = String(Math.min(+max, Math.max(+min, +p.start)));
    return { param: p, end: hi.end };
  }

  /** Every \tgparam of the document, by name (the first one of each name counts). */
  function scanParams(src) {
    const out = new Map();
    for (const m of src.matchAll(/\\tgparam(?![A-Za-z@])/g)) {
      const r = readParam(src, m.index + m[0].length);
      if (r.param && !out.has(r.param.name)) out.set(r.param.name, r.param);
    }
    return out;
  }

  /** Set the definitions of \name in TeX code (\def, \newcommand, \pgfmathsetmacro …) to value. */
  function setDefinitions(tex, name, value) {
    const cs = '\\\\' + name + '(?![A-Za-z@])';
    return tex
      .replace(new RegExp('(\\\\(?:[egx]?def)\\s*' + cs + '\\s*)\\{(?:[^{}]|\\{[^{}]*\\})*\\}', 'g'), (_, a) => `${a}{${value}}`)
      .replace(new RegExp('(\\\\(?:newcommand|renewcommand|providecommand)\\*?\\s*(?:\\{\\s*' + cs + '\\s*\\}|' + cs + ')\\s*)\\{(?:[^{}]|\\{[^{}]*\\})*\\}', 'g'), (_, a) => `${a}{${value}}`)
      .replace(new RegExp('(\\\\pgfmath(set|truncate)macro\\s*(?:\\{\\s*' + cs + '\\s*\\}|' + cs + ')\\s*)\\{(?:[^{}]|\\{[^{}]*\\})*\\}', 'g'),
        (_, a, kind) => `${a}{${kind === 'truncate' ? Math.trunc(+value) : value}}`);
  }

  const DIAGRAM_RE = /\\begin\s*\{(tikzcd|tikzpicture|diagram)\}|\\xymatrix(?![A-Za-z])/;

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

  const VERBATIM_ENVS = ['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted'];

  /**
   * Read a delimiter-based inline code span without consuming the following
   * line. \lstinline also takes {code}, closed by }.
   */
  function inlineCode(src, i, braces = false) {
    i = skipWhite(src, i);
    const delim = src[i];
    if (!delim || /\s/.test(delim)) return { content: '', end: i };
    const close = src.indexOf(braces && delim === '{' ? '}' : delim, i + 1);
    const newline = src.indexOf('\n', i + 1);
    const limit = newline < 0 ? src.length : newline;
    const stop = close < 0 || close >= limit ? limit : close;
    return { content: src.slice(i + 1, stop), end: stop < limit ? stop + 1 : stop };
  }

  /**
   * Remove % comments, keeping \% and literal code intact.
   * Returns the stripped text and, for each character, its original offset.
   */
  function stripCommentsMap(src) {
    const verbatim = new Set(VERBATIM_ENVS);
    const commands = /\\(?:(begin)\s*\{([^{}]+)\}|(verb|lstinline)(?![A-Za-z@])\*?|(newtcblisting)(?![A-Za-z@]))/y;
    const out = [];
    const map = [];
    const copy = (from, to) => {
      for (let k = from; k < to; k++) { out.push(src[k]); map.push(k); }
    };
    for (let i = 0; i < src.length;) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length) {
        commands.lastIndex = i;
        const m = commands.exec(src);
        let end = i + 2;
        if (m && m[1] && (verbatim.has(m[2]) || m[2] === 'comment')) {
          const closing = '\\end{' + m[2] + '}';
          const at = src.indexOf(closing, commands.lastIndex);
          end = at < 0 ? src.length : at + closing.length;
          if (m[2] === 'comment') { i = end; continue; }
        } else if (m && m[3]) {
          const start = skipWhite(src, commands.lastIndex);
          const opt = m[3] === 'lstinline' ? readOpt(src, start) : null;
          end = inlineCode(src, opt ? opt.end : start, m[3] === 'lstinline').end;
        } else if (m && m[4]) {
          const start = commands.lastIndex;
          const opt = readOpt(src, start);
          const name = readArg(src, opt ? opt.end : start).content.trim();
          if (/^[\w*-]+$/.test(name)) verbatim.add(name);
        }
        copy(i, end);
        i = end;
      } else if (c === '%') {
        // A comment also swallows the newline and the next line's indentation.
        const next = src.indexOf('\n', i);
        i = next < 0 ? src.length : next + 1;
        while (src[i] === ' ' || src[i] === '\t') i++;
      } else {
        copy(i, i + 1);
        i++;
      }
    }
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
    '\\boxbar': '\\mathbin{\\text{◫}}',
    '\\Tilde': '\\tilde{#1}',
    '\\Bar': '\\bar{#1}',
    '\\upshape': '',
    // symbols from fdsymbol/MnSymbol and amsmath spacing that KaTeX lacks
    '\\shortleftarrow': '\\mathrel{\\scriptstyle\\leftarrow}',
    '\\shortrightarrow': '\\mathrel{\\scriptstyle\\rightarrow}',
    '\\mspace': '\\mskip#1',
    // more package symbols KaTeX lacks: centernot, mathabx/txfonts, stmaryrd, wasysym, revtex
    '\\centernot': '\\not',
    '\\bigtimes': '\\mathop{\\vcenter{\\Large\\times}}',
    '\\bigsqcap': '\\mathop{\\vcenter{\\Large\\sqcap}}',
    '\\longhookrightarrow': '\\mathrel{\\xhookrightarrow{\\,}}',
    '\\longhookleftarrow': '\\mathrel{\\xhookleftarrow{\\,}}',
    '\\arrowvert': '\\vert',
    '\\Arrowvert': '\\Vert',
    '\\varolessthan': '\\mathbin{\\text{⧀}}',
    '\\varogreaterthan': '\\mathbin{\\text{⧁}}',
    '\\lightning': '\\mathord{\\text{↯}}',
    '\\checked': '\\checkmark',
    '\\mathsection': '\\S',
    '\\agt': '\\gtrsim',
    // rules that stretch to fill a box: drawn at a fixed width in a formula
    '\\hrulefill': '\\rule[0.25em]{1.5em}{0.4pt}',
    '\\leftarrowfill': '\\xleftarrow{\\quad}',
    '\\rightarrowfill': '\\xrightarrow{\\quad}',
    '\\expandafter': '',
    // plain TeX displays: \eqalign{a &= b\cr …} and \displaylines{…\cr …}
    '\\eqalign': '\\begin{aligned}#1\\end{aligned}',
    '\\displaylines': '\\begin{gathered}#1\\end{gathered}',
    // \xspace adds nothing in a formula (\ensuremath: see below)
    '\\xspace': '',
    // amsmath \sideset{_a^b}{^*}\sum: scripts beside the operator, its limits still above and below
    '\\sideset': '\\mathop{{}#1#3\\nolimits#2}',
    '\\MoveEqLeft': '',
    // vertical space between the rows of an array: the row gaps are KaTeX's own
    '\\smallskip': '',
    '\\medskip': '',
    '\\bigskip': '',
    '\\intertext': '\\text{#1}',
    // \mbox{…} in a formula is a box of text, which may hold maths of its own
    // ($x = \mbox{$y$ if $z>0$}$); KaTeX has no \mbox, but its \text works the same.
    '\\mbox': '\\text{#1}',
    // more boxes of text that may hold maths of their own: \parbox[t]{15em}{… $x$ …},
    // \textsc{$\lambda$-terms} (KaTeX has no small capitals), \rotatebox{-90}{$\to$}
    // (drawn unturned)
    '\\parbox': (ctx) => { optBracket(ctx); ctx.consumeArgs(1); return `\\text{${group(ctx)}}`; },
    '\\textsc': '\\text{#1}',
    '\\rotatebox': (ctx) => { optBracket(ctx); ctx.consumeArgs(1); return `\\text{${group(ctx)}}`; },
    // \ooalign{$\preceq$\cr\hidewidth\raise0.2ex\hbox{$\cdot$}\cr}: symbols drawn over each other
    '\\ooalign': (ctx) => {
      const rows = group(ctx)
        .split(/\\cr(?![A-Za-z@])/)
        .map((r) => r.replace(/\\hidewidth(?![A-Za-z@])/g, '')
          .replace(/\\(raise|lower)\s*(-?[\d.]+\s*[a-z]{2})\s*\\hbox\s*/g, (_, w, d) => `\\raisebox{${w === 'lower' ? '-' : ''}${d.replace(/\s/g, '')}}`)
          .trim().replace(/^\$([\s\S]*)\$$/, '$1'))
        .filter(Boolean);
      return rows.slice(1).map((r) => `\\mathrlap{${r}}`).join('') + (rows[0] || '');
    },
    // \boldmath switches the maths inside a box to bold; KaTeX has no such switch.
    '\\boldmath': '',
    '\\unboldmath': '',
    // dsfont's double-struck letters; KaTeX's \mathbb is the closest.
    '\\mathds': '\\mathbb{#1}',
    // \lefteqn{…}: its content takes no width, so the next line can start further left.
    '\\lefteqn': '\\mathrlap{\\displaystyle #1}',
    '\\shortintertext': '\\text{#1}',
    // esint: the averaged integral ⨏
    '\\fint': '\\mathop{\\rlap{\\hspace{0.32em}\\raisebox{0.05em}{\\text{-}}}{\\int}}\\nolimits',
    '\\dashint': '\\fint',
    '\\iiiint': '\\mathop{\\int\\!\\!\\int\\!\\!\\int\\!\\!\\int}\\nolimits',
    '\\dprod': '\\displaystyle\\prod',
    '\\pmqty': '\\begin{pmatrix}#1\\end{pmatrix}',
    '\\bmqty': '\\begin{bmatrix}#1\\end{bmatrix}',
    '\\vmqty': '\\begin{vmatrix}#1\\end{vmatrix}',
    '\\mathlarger': '{\\displaystyle #1}',
    '\\EuScript': '\\mathcal{#1}',
    '\\sc': '', // KaTeX has no small capitals
    '\\sp': '^',
    '\\sb': '_',
    '\\hfill': '\\quad',
    '\\vspace': (ctx) => { optStar(ctx); ctx.consumeArgs(1); return ''; },
    // \cline and \hhline draw partial rules, which KaTeX arrays cannot draw.
    '\\cline': (ctx) => { ctx.consumeArgs(1); return ''; },
    '\\hhline': (ctx) => { ctx.consumeArgs(1); return ''; },
    '\\CancelColor': '\\color{black}',
    // a \label that reaches KaTeX through a user macro: drop it
    '\\label': (ctx) => {
      // cleveref's \label[type]{key}: drop the [type] too
      if (ctx.future().text === '[') { let t; do t = ctx.popToken(); while (t.text !== ']' && t.text !== 'EOF'); }
      ctx.consumeArgs(1);
      return '';
    },
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
   * \left\llbracket … \right\rrbracket (stmaryrd's ⟦ ⟧, and \lBrace ⦃ ⦄), \bigl\llbracket, …:
   * KaTeX draws these with \html@mathml, which \left and \big cannot take, so
   * size two brackets, as KaTeX itself draws them at normal size.
   */
  const DOUBLE_BRACKETS = { llbracket: ['[', 3.2], rrbracket: [']', 3.2], lBrace: ['\\{', 3.2], rBrace: ['\\}', 3.2] };
  function doubleBrackets(tex) {
    if (!/\\(llbracket|rrbracket|lBrace|rBrace)|[\u27e6\u27e7]/.test(tex)) return tex;
    return tex.replace(/(\\(?:left|right|middle|[bB]igg?[lrm]?))\s*(?:\\(llbracket|rrbracket|lBrace|rBrace)(?![A-Za-z@])|([\u27e6\u27e7]))/g, (_, pre, name, ch) => {
      const key = name || (ch === '\u27e6' ? 'llbracket' : 'rrbracket');
      const [d, mu] = DOUBLE_BRACKETS[key];
      const inner = key === 'lBrace' ? '[' : key === 'rBrace' ? ']' : d;
      // ⦃ is a brace then a bracket, ⦄ a bracket then a brace
      const [a, b] = key === 'rBrace' ? [inner, d] : [d, inner];
      return `${pre}${a}\\mkern-${mu}mu${pre}${b}`;
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
    const content = tokText(args[n - 1]);
    // Keep inner math shifts in text nested inside the box.
    if (ctx.mode === 'text') return content;
    const unwrapped = unwrapMathShift(content);
    return unwrapped === content && content.includes('$') ? `\\text{${content}}` : unwrapped;
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
  // LaTeX allows rules in text boxes. KaTeX's built-in rule requires math mode.
  MATH_MACROS['\\rule'] = (ctx) => {
    if (ctx.mode !== 'text') return { tokens: [{ text: '\\rule', noexpand: true }], numArgs: 0 };
    const shift = optBracket(ctx);
    const width = group(ctx);
    const height = group(ctx);
    return '$\\rule' + (shift === null ? '' : '[' + shift + ']') + '{' + width + '}{' + height + '}$';
  };
  // A command that only works in math, reached in a text box inside a formula
  // (\text{\ensuremath{\vec\psi}}, \tag*{\qed}): set as math there.
  const mathIn = (tex) => (ctx) => (ctx.mode === 'text' ? '$' + tex + '$' : tex);
  // \ensuremath{…} is just its argument in math; in a text box it is math again.
  MATH_MACROS['\\ensuremath'] = (ctx) => {
    const body = group(ctx);
    return ctx.mode === 'text' ? '$' + body + '$' : body;
  };
  // KaTeX reads the character · in a text box as \cdotp, which is a math symbol.
  MATH_MACROS['\\cdotp'] = (ctx) => (ctx.mode === 'text' ? '\\char183{}' : '\\mathpunct{\\cdot}');
  for (const n of ['\\hrulefill', '\\leftarrowfill', '\\rightarrowfill']) MATH_MACROS[n] = mathIn(MATH_MACROS[n]);
  MATH_MACROS['\\qed'] = mathIn('\\square');
  MATH_MACROS['\\qedsymbol'] = mathIn('\\square');
  // the dotless i and j of text, written in a formula
  MATH_MACROS['\\i'] = (ctx) => (ctx.mode === 'text' ? { tokens: [{ text: '\\i', noexpand: true }], numArgs: 0 } : '\\imath');
  MATH_MACROS['\\j'] = (ctx) => (ctx.mode === 'text' ? { tokens: [{ text: '\\j', noexpand: true }], numArgs: 0 } : '\\jmath');
  // \noalign{\medskip} between the rows of an array (as computer algebra
  // systems write matrices): KaTeX keeps its own row gaps.
  MATH_MACROS['\\noalign'] = (ctx) => { ctx.consumeArgs(1); return ''; };
  // page breaks inside a display mean nothing on a web page
  MATH_MACROS['\\displaybreak'] = (ctx) => { optBracket(ctx); return ''; };
  MATH_MACROS['\\allowdisplaybreaks'] = (ctx) => { optBracket(ctx); return ''; };
  // adjustbox's \adjustbox{scale=0.8}{…}: a box of its content, unscaled
  MATH_MACROS['\\adjustbox'] = (ctx) => {
    ctx.consumeArgs(1);
    ctx.consumeSpaces();
    return ctx.future().text === 'EOF' ? '' : `\\hbox{${group(ctx)}}`;
  };
  // glue that fills a box (\hbox{\hfil$\sim$\hfil}): boxes in KaTeX are only as wide as what they hold
  // paragraph alignment inside a box in a formula
  for (const n of ['centering', 'raggedright', 'raggedleft']) MATH_MACROS['\\' + n] = '';
  MATH_MACROS['\\hfil'] = '';
  MATH_MACROS['\\hss'] = '';

  /** em per unit, in a 10pt font; the sizes of plain TeX rules. */
  const EM_PER = { pt: 0.1, bp: 0.10037, mm: 0.28453, cm: 2.8453, in: 7.227, pc: 1.2, dd: 0.107, cc: 1.284, sp: 0.1 / 65536, em: 1, ex: 0.431, mu: 1 / 18 };
  /** The next tokens, if they spell one of words (height, depth, width): the word; else nothing is read. */
  function katexKeyword(ctx, words) {
    ctx.consumeSpaces();
    const read = [];
    let s = '';
    for (;;) {
      const t = ctx.future();
      if (!/^[a-z]$/i.test(t.text) || !words.some((w) => w.startsWith(s + t.text.toLowerCase()))) break;
      read.push(ctx.popToken());
      s += t.text.toLowerCase();
      if (words.includes(s)) return s;
    }
    for (let k = read.length - 1; k >= 0; k--) ctx.pushToken(read[k]);
    return null;
  }
  /**
   * A TeX size after a keyword (height 1.6ex, width.4pt, depth -0.5em), in em.
   * A size made from a box or register (0.9\ht0) is read and gives null.
   */
  function katexDimen(ctx) {
    ctx.consumeSpaces();
    if (ctx.future().text === '=') { ctx.popToken(); ctx.consumeSpaces(); }
    let s = '';
    for (let t = ctx.future(); /^[-+0-9.,]$/.test(t.text); t = ctx.future()) { s += t.text === ',' ? '.' : t.text; ctx.popToken(); }
    ctx.consumeSpaces();
    const t = ctx.future();
    if (/^\\[A-Za-z@]+$/.test(t.text)) {
      ctx.popToken();
      // \ht0, \wd\mybox: the box's number or name too
      if (/^\\(ht|wd|dp)$/.test(t.text)) {
        ctx.consumeSpaces();
        if (/^\\/.test(ctx.future().text)) ctx.popToken();
        else while (/^\d$/.test(ctx.future().text)) ctx.popToken();
      }
      return null;
    }
    const unit = katexKeyword(ctx, Object.keys(EM_PER));
    const n = parseFloat(s === '-' || s === '+' || s === '' ? s + '1' : s);
    return unit && !isNaN(n) ? n * EM_PER[unit] : null;
  }
  // Plain TeX rules in a formula (\def\restriction{\vrule height 1.6ex depth 0pt
  // width 0.13ex\vrule height 0.13ex width 1.3ex}): KaTeX's \rule of the same
  // size. TeX stretches a rule with no height to the line; here it is a strut's.
  const plainRule = (vertical) => (ctx) => {
    const size = vertical ? { width: 0.04, height: 0.75, depth: 0.25 } : { width: 1, height: 0.04, depth: 0 };
    for (let word; (word = katexKeyword(ctx, ['height', 'depth', 'width'])); ) {
      const v = katexDimen(ctx);
      if (v !== null) size[word] = v;
    }
    const r = (x) => Math.round(x * 1000) / 1000;
    return `\\rule[${r(-size.depth)}em]{${r(Math.max(0, size.width))}em}{${r(Math.max(0, size.height + size.depth))}em}`;
  };
  // Plain TeX box registers in a formula (\setbox1=\hbox{$x$} … \box1): the
  // box's content is kept and put back. A register is a KaTeX macro, so it is
  // local to its group and to the formula; \box empties it, \copy does not.
  // Their sizes (\wd1) are not known.
  const boxNumber = (ctx) => {
    ctx.consumeSpaces();
    let t = ctx.popToken();
    if (/^\\/.test(t.text)) return t.text;
    let n = '';
    while (/^\d$/.test(t.text)) { n += t.text; t = ctx.popToken(); }
    ctx.pushToken(t);
    return n;
  };
  const boxKey = (n) => '\\texglassBox@' + n;
  MATH_MACROS['\\setbox'] = (ctx) => {
    const n = boxNumber(ctx);
    ctx.consumeSpaces();
    if (ctx.future().text === '=') ctx.popToken();
    ctx.consumeSpaces();
    const kind = ctx.future().text;
    if (!/^\\(hbox|vbox|vtop)$/.test(kind)) return '';
    ctx.popToken();
    ctx.macros.set(boxKey(n), { tokens: [], numArgs: 0, texglassBox: group(ctx) });
    return '';
  };
  // \box empties the box it reads, also after the group it is read in ends (the
  // same box object is emptied, so an outer box another group set stays)
  const useBox = (empty) => (ctx) => {
    const box = ctx.macros.get(boxKey(boxNumber(ctx)));
    if (!box || box.texglassBox === undefined) return '';
    const content = box.texglassBox;
    if (empty) box.texglassBox = undefined;
    return `\\hbox{${content}}`;
  };
  MATH_MACROS['\\box'] = useBox(true);
  MATH_MACROS['\\copy'] = useBox(false);
  // \ht2=0pt, \baselineskip=5pt: sizes of boxes and lines, which KaTeX sets itself
  const assignment = (box) => (ctx) => {
    if (box) boxNumber(ctx);
    ctx.consumeSpaces();
    if (ctx.future().text === '=') katexDimen(ctx);
    return '';
  };
  for (const n of ['ht', 'wd', 'dp']) MATH_MACROS['\\' + n] = assignment(true);
  for (const n of ['baselineskip', 'lineskip', 'lineskiplimit']) MATH_MACROS['\\' + n] = assignment(false);
  // \vtop{\box1\box2} and \vbox{\hbox{…}\hbox{…}}: the boxes stacked, one per row
  const vbox = (ctx) => {
    const body = group(ctx);
    const rows = [];
    const re = /\\(?:box|copy)\s*(?:\d+|\\[A-Za-z@]+)|\\hbox\s*(?=\{)/y;
    let k = 0;
    for (;;) {
      while (/\s/.test(body[k] || '')) k++;
      if (k >= body.length) break;
      re.lastIndex = k;
      const m = re.exec(body);
      if (!m) { rows.length = 0; break; }
      if (/^\\hbox/.test(m[0])) {
        const g = readGroup(body, re.lastIndex);
        rows.push(`\\hbox{${g.content}}`);
        k = g.end;
      } else {
        rows.push(m[0]);
        k = re.lastIndex;
      }
    }
    if (rows.length < 2) return `\\hbox{${body}}`;
    return `{\\def\\arraystretch{0.7}\\begin{array}{c}${rows.join('\\\\')}\\end{array}}`;
  };
  MATH_MACROS['\\vtop'] = vbox;
  MATH_MACROS['\\vbox'] = vbox;
  MATH_MACROS['\\vrule'] = plainRule(true);
  MATH_MACROS['\\hrule'] = plainRule(false);
  // diagrams.sty horizontal arrows outside a diagram's grid. The older
  // braced labels and the newer superscript/subscript syntax are equivalent.
  function diagramMathArrow([symbol, stretchy]) {
    return (ctx) => {
      optBracket(ctx);
      let above = optGroup(ctx);
      let below = above === null ? null : optGroup(ctx);
      for (let mark; /^[\^_]$/.test(mark = peekText(ctx));) {
        ctx.popToken();
        if (mark === '^') above = group(ctx);
        else below = group(ctx);
      }
      if (!above && !below) return symbol;
      if (stretchy) return stretchy + (below ? '[{' + below + '}]' : '') + '{' + (above || '') + '}';
      const lower = below ? '\\underset{' + below + '}{' + symbol + '}' : symbol;
      return '\\mathrel{' + (above ? '\\overset{' + above + '}{' + lower + '}' : lower) + '}';
    };
  }
  // settings that change nothing KaTeX draws: \mathversion{bold}, \setlength{\arraycolsep}{0pt}
  MATH_MACROS['\\mathversion'] = (ctx) => { group(ctx); return ''; };
  MATH_MACROS['\\setlength'] = (ctx) => { ctx.consumeArgs(2); return ''; };
  // scalerel: \scalerel*{\Huge K}{\big(} draws its first argument at about the size of the second
  // (the unstarred form prints the second argument after it; [width] is ignored)
  MATH_MACROS['\\scalerel'] = (ctx) => {
    const starred = peekText(ctx) === '*';
    if (starred) ctx.popToken();
    optBracket(ctx);
    const symbol = group(ctx).replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)(?![A-Za-z])/g, '');
    const reference = group(ctx);
    // the reference as it is, so an operator such as \sum keeps its limits
    return '{\\large ' + symbol + '}' + (starred ? '' : ' ' + reference);
  };
  MATH_MACROS['\\textsubscript'] = (ctx) => {
    const content = '_{\\text{' + group(ctx) + '}}';
    return ctx.mode === 'text' ? '$' + '{}' + content + '$' : content;
  };
  MATH_MACROS['\\ifstrempty'] = (ctx) => {
    const value = group(ctx);
    const empty = group(ctx);
    const nonempty = group(ctx);
    return value === '' ? empty : nonempty;
  };
  // For nested KaTeX arrays, reserve the columns occupied by the cell.
  MATH_MACROS['\\multicolumn'] = (ctx) => {
    const count = Math.max(1, Math.min(100, Number.parseInt(group(ctx), 10) || 1));
    const alignment = group(ctx);
    const text = group(ctx);
    const left = alignment.includes('r') ? count - 1 : alignment.includes('c') ? Math.floor((count - 1) / 2) : 0;
    return '&'.repeat(left) + text + '&'.repeat(count - 1 - left);
  };
  function inferenceRule(ctx, mathpartir) {
    const mark = peekText(ctx);
    if (mark === '*' || (!mathpartir && (mark === '=' || mark === '-'))) ctx.popToken();
    const label = optBracket(ctx);
    const first = group(ctx);
    const second = group(ctx);
    const upper = mathpartir ? first : second;
    const lower = mathpartir ? second : first;
    const premises = splitTop(upper, mathpartir ? rowSep : cellSep).join('\\qquad ');
    const rule = mark === '='
      ? `\\begin{array}{c}${premises}\\\\[-.5ex]\\hline\\hline ${lower}\\end{array}`
      : `\\dfrac{${premises}}{${lower}}`;
    return label ? `{${rule}\\;{\\scriptstyle ${label}}}` : rule;
  }
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
      // KaTeX has no [t]/[b] placement for an array: drop it
      out += tex.slice(last, m.index) + m[0].replace(/\[[^\]]*\]\s*/, '') + spec + '}';
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
   * Old papers draw blackboard-bold letters by hand, a roman letter with a
   * rule through it: \def\C{{\mathchoice{\setbox0=\hbox{$\displaystyle\rm C$}
   * \hbox{\hbox to0pt{\kern0.4\wd0\vrule height0.9\ht0\hss}\box0}}…}}. The
   * letter they stand for (\mathbb{C}), or null for another macro.
   */
  function handDrawnLetter(body) {
    // the letter is measured, overlaid with a rule and put back with \box0
    if (!/\\setbox/.test(body) || !/\\vrule/.test(body) || !/\\box\s*0(?!\d)/.test(body)) return null;
    const letters = new Set();
    // the measured letter, the zero-width boxes with the rules, and the letter put back
    let rest = body
      .replace(/\\setbox\s*0\s*=?\s*\\hbox\s*\{([^{}]*)\}/g, (_, t) => { letters.add(t.replace(/\\[A-Za-z@]+/g, '').replace(/[\s$]/g, '')); return ''; })
      .replace(/\\hbox\s*to\s*0\s*pt\s*\{([^{}]*)\}/g, (m, t) => (/^\s*(?:\\kern\s*-?[\d.]*\s*\\wd\s*0\s*)?\\vrule(?:\s*(?:height|depth|width)\s*-?[\d.]*\s*(?:\\(?:ht|wd|dp)\s*0|pt|em|ex)\s*)*\\hss\s*$/.test(t) ? '' : m))
      .replace(/\\raise\s*-?[\d.]*\s*\\ht\s*0/g, '')
      .replace(/\\box\s*0(?!\d)|\\hbox(?![A-Za-z@])|\\mathchoice(?![A-Za-z@])/g, '');
    rest = rest.replace(/[\s{}]/g, '');
    if (rest || letters.size !== 1) return null;
    const [letter] = letters;
    if (/^[A-Z]$/.test(letter)) return `\\mathbb{${letter}}`;
    if (/^[a-z0-9]$/.test(letter)) return `\\mathbbm{${letter}}`;
    return null;
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
    'long', 'outer', 'listoftodos', 'reversemarginpar', 'normalmarginpar', 'expandafter',
    // imsart (IMS journals) wraps the preamble's definitions in these
    'startlocaldefs', 'endlocaldefs',
  ]);

  /** Commands texglass.sty defines: TeXglass reads them itself, so a copy of the package never redefines them. */
  // Plain TeX \font\cs=wncyr10: the Washington Cyrillic fonts, typed in
  // Latin letters (OT2 transliteration), as in \text{\Shafont SH} for Ш.
  const CYRILLIC = [
    ['shch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['kh', 'х'], ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'],
    ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['z', 'з'], ['i', 'и'], ['j', 'й'], ['k', 'к'],
    ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'],
    ['x', 'х'], ['c', 'ц'], ['y', 'ы'], ['h', 'х'],
  ];
  /** Latin letters as the wncyr fonts draw them: "SH" -> "Ш", "Shch" -> "Щ". */
  function cyrillic(text) {
    let out = '';
    for (let i = 0; i < text.length;) {
      const rest = text.slice(i).toLowerCase();
      const hit = CYRILLIC.find(([l]) => rest.startsWith(l));
      if (!hit) { out += text[i++]; continue; }
      out += text[i] === text[i].toUpperCase() && /[A-Za-z]/.test(text[i]) ? hit[1].toUpperCase() : hit[1];
      i += hit[0].length;
    }
    return out;
  }
  // \texglassCyr: the letters after it, up to the end of the group, in Cyrillic
  MATH_MACROS['\\texglassCyr'] = (ctx) => {
    let letters = '';
    while (/^[ A-Za-z]$/.test(ctx.future().text)) {
      const t = ctx.popToken().text;
      if (t !== ' ' || letters) letters += t;
    }
    return letters.trim() ? `\\text{${cyrillic(letters.trim())}}` : '';
  };

  // the marks of \thanks notes, as LaTeX's \fnsymbol
  const FN_SYMBOLS = ['∗', '†', '‡', '§', '¶', '‖', '∗∗', '††', '‡‡'];

  const TG_COMMANDS = new Set(['tgdefine', 'tguses', 'tgparam', 'tgvalue', 'tgstep', 'tghide', 'tgonly']);
  const TG_ENVS = new Set(['tghide', 'tgonly']);
  /** HTML of only the empty markers they leave. */
  const TG_MARKERS = /^(?:<span class="tg-(?:define|param|stepmark)"[^>]*><\/span>\s*)+$/;

  /** The symbol of \tgdefine{…}: TeX for a formula, with any $…$ or \(…\) around it taken off. */
  function tgSymbol(s) {
    s = String(s).trim();
    const m = /^\$([^$]*)\$$/.exec(s) || /^\\\(([\s\S]*)\\\)$/.exec(s);
    return (m ? m[1] : s).trim();
  }

  /**
   * Plain TeX in formulas that KaTeX does not read: \eqno and \leqno (an
   * equation number, as \tag), \buildrel A \over B (as \stackrel), and the
   * corners \ulcorner … \urcorner after \left and \right (KaTeX does not
   * stretch them, so they are drawn at their own size).
   */
  /**
   * \raisebox{-0.5\height}{…} centres a box (a picture, a figure) on the line:
   * KaTeX knows no \height, so a box lowered by about half its height is
   * centred with \vcenter, and other moves by its own size are dropped.
   */
  function raiseBySize(tex) {
    const re = /(?<!\\)\\raisebox\s*\{\s*([+-]?\s*(?:\d+(?:\.\d*)?|\.\d+)?)\s*\\(height|depth|totalheight|width)(?![A-Za-z@])\s*\}\s*(?:\[[^\]]*\]\s*){0,2}/g;
    let out = '';
    let last = 0;
    for (const m of tex.matchAll(re)) {
      if (m.index < last) continue;
      const at = m.index + m[0].length;
      if (tex[at] !== '{') continue;
      const box = readGroup(tex, at);
      const f = parseFloat((m[1] || '1').replace(/\s/g, '').replace(/^([+-])$/, '$11'));
      const centre = /height/.test(m[2]) && f <= -0.3 && f >= -0.7;
      out += tex.slice(last, m.index) + (centre ? `\\vcenter{\\hbox{${box.content}}}` : `\\hbox{${box.content}}`);
      last = box.end;
    }
    return out + tex.slice(last);
  }

  /**
   * Text environments written inside a formula. A tabular becomes an array
   * whose cells are text with maths in them; \begin{small} … \end{small} a
   * size switch in a group.
   */
  function textEnvsInMath(tex) {
    tex = tex.replace(/\\begin\s*\{(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\}/g, '{\\$1 ')
      .replace(/\\end\s*\{(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\}/g, '}');
    const re = /\\begin\s*\{tabular\}\s*(?:\[[^\]]*\]\s*)?/g;
    let m;
    for (let guard = 0; guard < 50 && (m = re.exec(tex)); guard++) {
      const at = m.index + m[0].length;
      if (tex[at] !== '{') continue;
      const spec = readGroup(tex, at);
      const e = findEnvEnd(tex, spec.end, 'tabular');
      const cell = (c) => {
        // rules before the row stay outside the text
        const lead = /^(\s*(?:\\hline|\\cline\s*\{[^{}]*\}|\\toprule|\\midrule|\\bottomrule)\s*)*/.exec(c)[0];
        let body = c.slice(lead.length).replace(/\\multicolumn\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
        // text, with its $…$ maths and groups as they are
        return lead + (body.trim() ? `\\text{${body}}` : body);
      };
      const rows = splitTop(tex.slice(spec.end, e.contentEnd), rowSep).map((row) => splitTop(row, cellSep).map(cell).join('&'));
      const array = `\\begin{array}{${spec.content}}${rows.join('\\\\')}\\end{array}`;
      tex = tex.slice(0, m.index) + array + tex.slice(e.end);
      re.lastIndex = m.index + 1;
    }
    return tex;
  }

  function plainTexMath(tex, display) {
    // Plain TeX's \aligned … \endaligned spelling for an AMS sub-display.
    tex = tex.replace(/(?<!\\)\\aligned(?![A-Za-z@])([\s\S]*?)(?<!\\)\\endaligned(?![A-Za-z@])/g, '\\begin{aligned}$1\\end{aligned}');
    tex = tex.replace(/(?<!\\)\\[hm]box\s*\{\s*\\eufm(?![A-Za-z@])\s*([^{}]*)\}/g, '\\mathfrak{$1}');
    // LaTeX accepts a braced delimiter argument; KaTeX expects a single token.
    tex = tex.replace(/(?<!\\)(\\(?:[bB]ig(?:g)?[lmr]?|left|middle|right)(?![A-Za-z@]))\s*\{\s*(\\(?:[A-Za-z@]+|[{}|])|[()[\]|./<>])\s*\}/g, '$1 $2 ');
    // Plain TeX moves an hbox by a size or a named length register. If the
    // register's value is unavailable, keep drawing the box at its baseline.
    tex = tex.replace(/\\(raise|lower)(?![A-Za-z@])\s*([+-]?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex)|\\[A-Za-z@]+)\s*\\hbox(?![A-Za-z@])\s*(?=\{)/g,
      (_, direction, size) => {
        if (size[0] === '\\') return '\\hbox';
        const length = size.replace(/\s/g, '');
        if (direction === 'raise') return `\\raisebox{${length}}`;
        return `\\raisebox{${length[0] === '-' ? length.slice(1) : '-' + length.replace(/^\+/, '')}}`;
      });
    // \hbox to 0pt{…} and \hbox spread 1em{…}: KaTeX's boxes are as wide as what they hold
    tex = tex.replace(/(?<!\\)\\hbox(?![A-Za-z@])\s*(?:to|spread)\s*(?:[+-]?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex)|[+-]?\s*(?:\d+(?:\.\d*)?|\.\d+)?\s*\\[A-Za-z@]+\s*\d*)\s*(?=\{)/g, '\\hbox');
    // space that fills the line (\hspace*{\fill} before an end-of-proof mark)
    tex = tex.replace(/(?<!\\)\\hspace\*?\s*\{\s*(?:\\(?:h?fill|hfil)|\\stretch\s*\{[^{}]*\})\s*\}/g, '\\quad');
    if (/\\raisebox\s*\{[^{}]*\\(?:height|depth|totalheight|width)(?![A-Za-z@])/.test(tex)) tex = raiseBySize(tex);
    if (/\\l?eqno(?![A-Za-z@])/.test(tex)) {
      const tags = tex.match(/\\l?eqno(?![A-Za-z@])/g).length;
      tex = tex.replace(/\\l?eqno(?![A-Za-z@])\s*((?:[^\\]|\\(?!\\|cr(?![A-Za-z@])|end(?![A-Za-z@])))*)/g, (_, num) => {
        const n = num.trim();
        if (!n) return '';
        // one number on a whole display: an equation tag; several (one per row), text at the row's end
        if (display && tags === 1) return `\\tag{${n.replace(/^\(([\s\S]*)\)$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1')}}`;
        return `\\qquad ${n}`;
      });
    }
    // a superscript or subscript on a space (\fix^{k} with \newcommand{\fix}{\theta\,}):
    // TeX puts it on an empty box, KaTeX stops with an error
    tex = tex.replace(/(?<!\\)(\\(?:[,;:!>]|(?:q?quad|thinspace|medspace|thickspace|enspace|negthinspace|negmedspace|negthickspace)(?![A-Za-z@])))(\s*)(?=[\^_']|$)/g, '$1{}$2');
    tex = tex.replace(/(?<!\\)(\\hspace\*?\s*\{[^{}]*\})(\s*)(?=[\^_'])/g, '$1{}$2');
    // KaTeX already inserts no space for a null delimiter.
    tex = tex.replace(/(?<!\\)\\kern\s*[+-]?\s*\\nulldelimiterspace(?![A-Za-z@])/g, '');
    // The table still has KaTeX's default column padding.
    tex = tex.replace(/(?<!\\)\\arraycolsep\s*=?\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|cm|mm|in|bp|pc|sp|dd|cc)\b/g, '');
    // \uppercase\expandafter{\romannumeral 2} (II) and \romannumeral 2 (ii)
    if (/\\romannumeral/.test(tex)) {
      tex = tex.replace(/\\uppercase\s*(?:\\expandafter\s*)?\{\s*\\romannumeral\s*(\d+)\s*\}/g, (_, n) => `\\mathrm{${roman(+n).toUpperCase()}}`)
        .replace(/\\romannumeral\s*(\d+)/g, (_, n) => `\\mathrm{${roman(+n)}}`);
    }
    if (/\\buildrel(?![A-Za-z@])/.test(tex)) {
      tex = tex.replace(/\\buildrel(?![A-Za-z@])\s*((?:[^\\]|\\(?!over(?![A-Za-z@])))*?)\\over(?![A-Za-z@])\s*(\\[A-Za-z@]+|\{[^{}]*\}|\S)/g,
        (_, top, rel) => `\\stackrel{${top.trim()}}{${rel}}`);
    }
    if (/\\(?:left|right)\s*\\(?:ul|ur|ll|lr)corner/.test(tex)) {
      tex = tex.replace(/\\left\s*\\((?:ul|ll|ur|lr)corner)(?![A-Za-z@])/g, '\\mathopen{\\$1}').replace(/\\right\s*\\((?:ul|ll|ur|lr)corner)(?![A-Za-z@])/g, '\\mathclose{\\$1}');
    }
    return tex;
  }

  /** TeX length registers set in preambles, as in \textwidth 16cm or \topmargin=-1in. */
  const TEX_LENGTHS = new Set([
    'textwidth', 'textheight', 'oddsidemargin', 'evensidemargin', 'topmargin', 'headheight', 'headsep',
    'footskip', 'marginparwidth', 'marginparsep', 'marginparpush', 'hoffset', 'voffset', 'columnsep',
    'columnseprule', 'parindent', 'parskip', 'baselineskip', 'lineskip', 'lineskiplimit', 'topskip',
    'footnotesep', 'arraycolsep', 'tabcolsep', 'arrayrulewidth', 'doublerulesep', 'jot', 'mathindent',
    'abovedisplayskip', 'belowdisplayskip', 'abovedisplayshortskip', 'belowdisplayshortskip',
    'labelsep', 'labelwidth', 'leftmargin', 'rightmargin', 'itemsep', 'itemindent', 'listparindent',
    'partopsep', 'topsep', 'emergencystretch', 'hsize', 'vsize', 'unitlength', 'fboxsep', 'fboxrule',
    'leftmargini', 'leftmarginii', 'leftmarginiii', 'textfloatsep', 'floatsep', 'intextsep', 'parfillskip',
  ]);
  /** Plain TeX spacing commands that take a size without braces. */
  const TEX_SKIPS = new Set(['vskip', 'hskip', 'kern', 'mkern', 'vglue', 'hglue', 'moveleft', 'moveright']);

  /** The end of a TeX size after src[i], as in "=-1in", " 2pt plus 1pt minus 1fil" or " 0.5\textwidth". */
  function skipGlue(src, i) {
    const num = '[-+]?\\s*(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)';
    const unit = '(?:true\\s*)?(?:pt|cm|mm|in|em|ex|bp|pc|sp|dd|cc|mu|fil+)\\b';
    const size = `(?:${num}\\s*(?:${unit}|\\\\[A-Za-z@]+)|[-+]?\\s*\\\\[A-Za-z@]+)`;
    const re = new RegExp(`^\\s*=?\\s*${size}(?:\\s*plus\\s*${size})?(?:\\s*minus\\s*${size})?`);
    const m = re.exec(src.slice(i, i + 200));
    return m ? i + m[0].length : i;
  }

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
    'ProvidesPackage', 'ProvidesClass', 'hyphenation', 'typeout',
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
      this.fnSymbols = [];
      this.warnings = [];
      this.macros = Object.create(null); // name (without backslash) -> {nargs, def, body}
      this.params = new Map(); // \tgparam by name (scanParams); values set by sliders in options.params
      this.liveValues = options.params || null;
      this.inPicture = 0; // inside a TikZ picture, whose maths goes with the picture
      this.paired = Object.create(null); // \DeclarePairedDelimiter definitions
      this.triple = DEFAULT_TRIPLE.slice(); // delimiters drawn as three bars (\vvvert)
      this.envs = Object.create(null); // \newenvironment definitions
      this.verbatim = new Set(VERBATIM_ENVS);
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
      // \newif flags (and a few that packages set), by their \if… name
      this.flags = new Map(Object.entries(DEFAULT_FLAGS));
      this.isCond = (n) => PRIMITIVE_IFS.has(n) || /^if@/.test(n) || this.flags.has(n);
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
            if (cmd === 'cref' && !this.crefCap) name = kind ? kind[0] : name.toLowerCase();
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
    mathRefs(tex, missing) {
      return tex.replace(/\\(eqref|ref|cref|Cref|autoref)\s*\{([^}]*)\}/g, (_, cmd, key) => {
        const info = this.lookup(key);
        if (!info && missing) missing.add(key.trim());
        let num = info ? info.num : '??';
        if (cmd === 'eqref') num = `(${num})`;
        return `\\text{${num.replace(/([{}\\#$%&_^~])/g, '\\$1')}}`;
      });
    }

    renderMath(tex, display) {
      // the paper's environments first, so what they bring in (\ref, \footnote) is read like the rest
      tex = this.mathEnvs(tex);
      if (/\\begin\s*\{(?:tabular|tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\}/.test(tex)) tex = textEnvsInMath(tex);
      if (/\\footnote(?![A-Za-z@])/.test(tex)) tex = this.mathFootnotes(tex);
      const missing = this.options.sourceMap && this.known ? new Set() : null;
      tex = this.sizeDoubles(tripleBars(arraySpecs(this.mathRefs(tex, missing)), this.triple));
      // references a macro brings in are looked up while KaTeX expands it (see katexMacros)
      const outerMissing = this.mathRefMissing;
      const outerImages = this.mathImages;
      const outerTex = this.mathImageTex;
      this.mathRefMissing = missing;
      this.mathImages = null;
      this.mathImageTex = tex;
      try {
        return this.renderMathBody(tex, display, missing);
      } finally {
        this.mathRefMissing = outerMissing;
        this.mathImages = outerImages;
        this.mathImageTex = outerTex;
      }
    }

    renderMathBody(tex, display, missing) {
      tex = tex.replace(/\\(qedhere|nonumber|notag)\b/g, '').replace(/\\label\s*(?:\[[^\]]*\]\s*)?\{[^}]*\}/g, '');
      // a formula that uses a \tgparam: a mark with its TeX, to draw it again when a slider moves
      const live = this.params.size && !this.inPicture ? this.liveMark(tex, display ? ' data-tg-display=""' : '') : '';
      if (this.params.size) tex = this.putValues(tex);
      tex = plainTexMath(tex, display);
      const refs = () => (missing ? Array.from(missing, (key) => `<span hidden data-math-ref-missing="${escapeHtml(key)}"></span>`).join('') : '');
      try {
        // the paper's own definitions (macros, paired delimiters, …) win over the probes
        const macros = this.mathProbe ? Object.assign({}, this.mathProbe, this.katexMacros(tex)) : this.katexMacros(tex);
        const html = closeEmptyMathml(this.renderMathFn(tex, display, macros));
        let out = this.trees && /color:#a5[0-9a-f]{4}/.test(html) ? this.putTrees(html) : html;
        if (this.mathImages && this.mathImages.size) out = this.putImages(out);
        return out + refs() + live;
      } catch (e) {
        return `<span class="math-error" title="${escapeHtml(e.message || e)}">${escapeHtml(tex)}</span>` + refs() + live;
      }
    }

    /**
     * The paper's own environments inside a formula, written out
     * (\newenvironment{stack}{\begin{array}[t]{l}}{\end{array}}), since KaTeX
     * knows only its own.
     */
    mathEnvs(tex) {
      if (!/\\begin/.test(tex)) return tex;
      const re = /\\begin\s*\{([^{}]+)\}/g;
      let m;
      for (let guard = 0; guard < 200 && (m = re.exec(tex)); guard++) {
        const name = m[1].trim();
        const e = Object.prototype.hasOwnProperty.call(this.envs, name) ? this.envs[name] : null;
        if (!e) continue;
        const at = m.index + m[0].length;
        const end = findEnvEnd(tex, at, m[1]);
        const args = [];
        let j = at;
        for (let k = 0; k < e.nargs; k++) {
          if (k === 0 && e.def !== null) {
            const o = readOpt(tex, j);
            args.push(o ? o.content : e.def);
            if (o) j = o.end;
            continue;
          }
          const a = readArg(tex, j);
          args.push(a.content);
          j = a.end;
        }
        const sub = (t) => t.replace(/#(\d)/g, (_, d) => args[d - 1] || '');
        // an environment is a group, as in LaTeX, that keeps the spacing of what it holds
        // (\begingroup, not braces); spaces keep \alpha from running into x
        tex = tex.slice(0, m.index) + '\\begingroup ' + sub(e.begin) + ' ' + tex.slice(j, end.contentEnd) + ' ' + sub(e.end) + '\\endgroup ' + tex.slice(end.end);
        // look again from here: the written-out text may hold more of the paper's environments
        re.lastIndex = m.index;
      }
      return tex;
    }

    /** A hidden mark for a formula or picture (tex) that uses parameters, read by src/params.js. */
    liveMark(tex, extra) {
      const u = this.paramUses(tex);
      if (!u.params.length || this.liveOnly) return '';
      let defs = this.liveDefs(u.macros, u.arrows);
      // diagrams.sty arrows (\rTo) inferred from a diagram, not the preamble: the redraw needs them too
      const arrowIn = (t) => /\\[lr][A-Z]/.test(t);
      if (this.taylorDiagrams && (arrowIn(tex) || u.macros.some((n) => arrowIn(String(this.macros[n]?.body || ''))))) defs = '\\diagramstyle' + (defs ? '\n' + defs : '');
      return `<span class="tg-live" hidden data-tg-params="${u.params.join(' ')}" data-tg-tex="${escapeHtml(tex)}"${defs ? ` data-tg-defs="${escapeHtml(defs)}"` : ''}${extra}></span>`;
    }

    /**
     * A \footnote inside a formula (often after the last symbol of a display)
     * goes with the other footnotes; the formula keeps its number.
     */
    mathFootnotes(tex) {
      const notes = this.mathNotes || (this.mathNotes = new Map());
      let out = '';
      let last = 0;
      for (const m of tex.matchAll(/\\footnote(?![A-Za-z@])\s*(?:\[[^\]]*\]\s*)?(?=\{)/g)) {
        if (m.index < last) continue;
        const g = readGroup(tex, m.index + m[0].length);
        // the same formula may be drawn more than once; its note is made once
        if (!notes.has(g.content)) {
          this.footnote(g.content);
          notes.set(g.content, this.footnotes.length);
        }
        out += tex.slice(last, m.index) + `{}^{${this.fnLabel(notes.get(g.content))}}`;
        last = g.end;
      }
      return out + tex.slice(last);
    }

    /** \left\llangle, \big\llbracket, …, unless the paper defines these delimiters itself. */
    sizeDoubles(tex) {
      if (typeof tex !== 'string') return tex;
      if (!this.macros.llangle && !this.macros.rrangle) tex = doubleAngles(tex);
      if (!this.macros.llbracket && !this.macros.rrbracket) tex = doubleBrackets(tex);
      return tex;
    }

    katexMacros(tex) {
      if (!this._katexMacros) {
        const m = Object.assign({}, MATH_MACROS, CONDITIONAL_MACROS);
        if (this.taylorDiagrams) {
          const arrows = tikz()?.taylorMathArrows?.(this.diagramArrows) || {
            '\\rTo': ['\\rightarrow', '\\xrightarrow'],
            '\\lTo': ['\\leftarrow', '\\xleftarrow'],
          };
          for (const [name, shape] of Object.entries(arrows)) m[name] = diagramMathArrow(shape);
        }
        m['\\cite'] = (ctx) => {
          const note = optBracket(ctx);
          const cites = this.known ? this.known.cites : this.cites;
          const labels = group(ctx).split(',').map((key) => {
            const id = key.trim();
            return (cites[id] ? cites[id].label : id).replace(/([{}\\#$%&_^~])/g, '\\$1');
          });
          const citation = '[' + labels.join(', ') + (note ? ', ' + note : '') + ']';
          return ctx.mode === 'text' ? citation : '\\text{' + citation + '}';
        };
        // figures in a formula, also from a macro: drawn after KaTeX (see mathImage). These and
        // the references below come before the paper's macros, which may define them itself.
        m['\\includegraphics'] = (ctx) => {
          optStar(ctx);
          const opts = optBracket(ctx);
          return this.mathImage(opts, group(ctx).trim());
        };
        // \eqref and \ref that reach KaTeX through a macro (\def\eq#1{\eqref{#1}}): the number as text
        for (const cmd of ['ref', 'eqref']) {
          m['\\' + cmd] = (ctx) => {
            const key = group(ctx).trim();
            const info = this.lookup(key);
            if (!info && this.mathRefMissing) this.mathRefMissing.add(key);
            let num = info ? info.num : '??';
            if (cmd === 'eqref') num = `(${num})`;
            num = String(num).replace(/([{}\\#$%&_^~])/g, '\\$1');
            return ctx.mode === 'text' ? num : `\\text{${num}}`;
          };
        }
        for (const [flag, value] of this.flags) {
          m['\\' + flag] = value ? '\\iftrue' : '\\iffalse';
          m['\\' + flag.slice(2) + 'true'] = '';
          m['\\' + flag.slice(2) + 'false'] = '';
        }
        const lowLevel = new Map();
        const isLowLevel = (name, depth) => {
          if (lowLevel.has(name)) return lowLevel.get(name);
          lowLevel.set(name, false);
          const mac = this.macros[name];
          let v = !!mac && LOW_LEVEL.test(mac.body);
          if (mac && !v && depth < 6) {
            for (const r of mac.body.matchAll(/\\([A-Za-z@]+)/g)) if (r[1] !== name && isLowLevel(r[1], depth + 1)) { v = true; break; }
          }
          lowLevel.set(name, v);
          return v;
        };
        // macros made only of category-code changes and other settings for
        // verbatim text (\catcode`\^^M=\active\let^^M=\par, \ttfamily, …), maybe
        // through other such macros: they draw nothing in a formula
        const setupOnly = new Map(); // name -> { pure: only settings, cat: changes catcodes }
        const setupOf = (name, depth) => {
          if (setupOnly.has(name)) return setupOnly.get(name);
          const v = { pure: false, cat: false };
          setupOnly.set(name, v);
          const mac = this.macros[name];
          if (!mac || mac.nargs || mac.delims || depth > 6) return v;
          v.cat = /\\catcode(?![A-Za-z@])/.test(mac.body);
          let rest = mac.body
            .replace(/\\catcode\s*`\s*(?:\\\^\^.|\^\^.|\\.|.)\s*=?\s*(?:\d+|\\active|\\other)/g, '')
            .replace(/\\let\s*(?:\^\^.|\\[A-Za-z@]+|\\.|.)\s*=?\s*(?:\\[A-Za-z@]+|\\.|.)/g, '')
            .replace(/\\@makeother\s*\\./g, '')
            .replace(/\\(?:par(?:sep|indent|skip)|baselineskip|leftskip|rightskip)\s*=?\s*-?[\d.]+\s*[a-z]{2}/g, '')
            .replace(/\\def\s*\\.\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
            .replace(/\\(?:ttfamily|tt|frenchspacing|nonfrenchspacing|obeylines|obeyspaces|relax)(?![A-Za-z@])/g, '');
          rest = rest.replace(/\\([A-Za-z@]+)/g, (c, n) => {
            const sub = n !== name && setupOf(n, depth + 1);
            if (!sub || !sub.pure) return c;
            if (sub.cat) v.cat = true;
            return '';
          });
          v.pure = !rest.replace(/[\s{}%]/g, '');
          return v;
        };
        const isSetupOnly = (name) => { const v = setupOf(name, 0); return v.pure && v.cat; };
        const keep = new Set();
        for (const name in this.macros) {
          const mac = this.macros[name];
          const target = mac.let && mac.body.slice(1);
          if (target && this.macros[target] && !this.macros[target].let) keep.add(target);
        }
        for (const name in this.macros) {
          // KaTeX's own macros use \char (\neq does), so a paper's \char stays out of formulas
          if (name === 'char') continue;
          let mac = this.macros[name];
          // a conditional or \else redefined by package code: keep ours
          if (CONDITIONAL_MACROS['\\' + name] !== undefined) continue;
          // \let\oldcirc\circ before \renewcommand{\circ}{…\oldcirc…} would loop
          // in KaTeX, which cannot keep the old meaning apart: both are KaTeX's own \circ
          if (keep.has(name)) continue;
          // a letter drawn by hand from box registers (\setbox0\hbox{\rm C}…\vrule…\box0): KaTeX has
          // no boxes to measure, so the blackboard letter it stands for
          const letter = !mac.nargs && !mac.delims && handDrawnLetter(mac.body);
          if (letter) { m['\\' + name] = letter; continue; }
          // a macro that changes category codes (\catcode`\^^M=\active…, set up for
          // verbatim code) draws nothing in a formula
          if (isSetupOnly(name)) { m['\\' + name] = ''; continue; }
          // a test of the paper's own that it never made with \newif: false (not
          // etoolbox's \ifdef{…}{…}{…} and the like, which have no \fi)
          if (/\\fi(?![A-Za-z@])/.test(mac.body)) for (const r of mac.body.matchAll(/\\(if[A-Za-z@]*)/g)) {
            if (!m['\\' + r[1]] && !this.macros[r[1]] && !/^if(f|thenelse)$/.test(r[1]) && !this.flags.has(r[1]) && !PRIMITIVE_IFS.has(r[1])) m['\\' + r[1]] = '\\iffalse';
          }
          // \newcommand{\bk}[1]{\left\llbracket#1\right\rrbracket}: KaTeX expands the
          // body itself, so size double brackets and angles in it here. KaTeX
          // also reads a space from the body between a command and its argument
          // ({…}\n {…} after \mathchoice), which TeX skips.
          const body = plainTexMath(this.sizeDoubles(mac.body).replace(/\}\s+(?=\{)/g, '}'), false);
          if (body !== mac.body) mac = Object.assign({}, mac, { body });
          const own = mac.nargs || mac.delims ? userMathMacro(mac) : mac.body;
          const low = isLowLevel(name, 0);
          if (low && name === 'infer' && this.macros['@infer']) m['\\infer'] = (ctx) => inferenceRule(ctx, false);
          else if (name === 'inferrule' && this.macros['mpr@inferrule']) m['\\inferrule'] = (ctx) => inferenceRule(ctx, true);
          else m['\\' + name] = low ? lowLevelMacro('\\' + name, own) : own;
        }
        // a paper's own \text may be made of \mbox ({\mbox{#1}}): then \mbox is KaTeX's \textrm
        if (this.macros.text) m['\\mbox'] = '\\textrm{#1}';
        for (const name in this.paired) {
          const paired = pairedMacro(this.paired[name], this.triple);
          m['\\' + name] = (ctx) => this.sizeDoubles(paired(ctx));
        }
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

    setPreamble(pre) {
      this.preamble = pre;
      this.taylorDiagrams = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{(?:[^{}]*,)?\s*diagrams\s*(?:,[^{}]*)?\}|\\input(?:\s*\{\s*(?:\.\/)*diagrams(?:\.tex)?\s*\}|\s+(?:\.\/)*diagrams(?:\.tex)?(?=\s|$))/.test(pre);
    }

    run(src) {
      let pre = '';
      let body = src;
      let bodyStart = 0;
      const begin = documentMark(src, 'begin');
      if (begin) {
        pre = src.slice(0, begin.at);
        bodyStart = begin.at + begin.length;
        body = src.slice(bodyStart);
        const end = documentMark(body, 'end');
        if (end) body = body.slice(0, end.at);
      }
      this.setPreamble(pre);
      // amsart, amsproc: an abstract written before \maketitle goes under the title
      this.amsTitle = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*ams(?:art|proc)\s*\}/.test(pre) && /\\maketitle\b/.test(body);
      this.heldAbstract = '';
      // cleveref's capitalise option: \cref says "Lemma 2.1", as \Cref does
      this.crefCap = /\\usepackage\s*\[[^\]]*\bcapitali[sz]e\b[^\]]*\]\s*\{[^}]*\bcleveref\b[^}]*\}/.test(pre);
      this.startParams(src);
      this.ulemEmph = /\\usepackage\s*(?:\[(?![^\]]*\bnormalem\b)[^\]]*\])?\s*\{[^}]*\bulem\b[^}]*\}/.test(pre);
      if (/\\chapter\b/.test(src)) {
        this.topLevel = 'chapter';
        this.counters.section.parent = 'chapter';
      }
      this.inPreamble = true;
      this.flow(pre, false); // preamble: definitions only, output discarded
      this.inPreamble = false;
      this.defineParams();
      this.trackDepth = this.depth + 1;
      this.trackBase = bodyStart;
      this.trackText = src;
      this.blocks = null;
      let html = this.flow(body, false);
      this.trackDepth = -1;
      if (this.footnotes.length) {
        const notes =
          '<section class="footnotes"><ol>' +
          this.footnotes.map((f, k) => {
            const label = this.fnLabel(k + 1);
            const mark = label === String(k + 1) ? '' : /^\d+$/.test(label) ? ` value="${label}"` : ` class="fn-symbol" data-mark="${escapeHtml(label)}"`;
            return `<li id="fn-${k + 1}"${mark}>${f} <a class="fn-back" href="#fnref-${k + 1}">↩</a></li>`;
          }).join('') +
          '</ol></section>';
        html += '\n' + notes;
        if (this.blocks) this.blocks.push(notes);
      }
      if (this.tgPreamble && this.tgPreamble.length) {
        // texglass.sty hints from the preamble hold for the whole paper
        const marks = this.tgPreamble.join('');
        html += '\n' + marks;
        if (this.blocks) this.blocks.push(marks);
      }
      const params = this.paramMarks();
      if (params) {
        html += '\n' + params;
        if (this.blocks) this.blocks.push(params);
      }
      return html;
    }

    // --- live parameters (texglass.sty \tgparam; sliders in src/params.js) --

    /** Read every \tgparam first, so that uses before the declaration count too. */
    startParams(src) {
      this.params = /\\tgparam(?![A-Za-z@])/.test(src) ? scanParams(src) : new Map();
      this.locked = new Set(); // params set by a slider (options.params)
      this.ownParamDefs = new Set(); // params the paper defines as macros itself
      this.paramCs = new Set(); // params whose macro \name is the parameter
      if (!this.liveValues) return;
      for (const [name, v] of Object.entries(this.liveValues)) {
        if (this.params.has(name) && NUMBER_RE.test(String(v))) this.locked.add(name);
      }
    }

    /** A definition of \key that a slider's value overrides (true: leave it out). */
    lockedDef(key) {
      if (!this.params.size || !this.params.has(key)) return false;
      this.ownParamDefs.add(key);
      return this.locked.has(key);
    }

    /**
     * As texglass.sty does at \begin{document}: \name holds the start value
     * unless the paper defines \name itself (or LaTeX has it). A slider's value
     * wins over both.
     */
    defineParams() {
      for (const [name, p] of this.params) {
        const own = this.ownParamDefs.has(name) || !!this.macros[name];
        if (!own && LATEX_HAS.test(name)) continue; // \name stays LaTeX's: only \tgvalue{name} is the parameter
        this.paramCs.add(name);
        if (this.locked.has(name)) this.macros[name] = { nargs: 0, def: null, body: String(this.liveValues[name]) };
        else if (!this.macros[name]) this.macros[name] = { nargs: 0, def: null, body: p.start !== null ? p.start : p.min };
        else continue;
        this._katexMacros = null;
      }
    }

    /** The value \tgvalue{name} prints: the slider's, else the start value (else the minimum). */
    paramValue(name) {
      const p = this.params.get(name);
      if (!p) return null;
      if (this.locked.has(name)) return String(this.liveValues[name]);
      return p.start !== null ? p.start : p.min;
    }

    /** \tgvalue{name} in TeX code, replaced by the value. */
    putValues(tex) {
      if (!this.params.size || !/\\tgvalue/.test(tex)) return tex;
      return tex.replace(/\\tgvalue\s*\{\s*([A-Za-z]+)\s*\}/g, (all, n) => {
        const v = this.paramValue(n);
        return v === null ? '??' : v;
      });
    }

    /**
     * The parameters TeX code depends on: \tgvalue{name}, \name, or a macro
     * of the paper that uses one, along with the macro and arrow definitions it reaches.
     */
    paramUses(tex) {
      const params = new Set();
      const macros = [];
      const arrows = new Set();
      if (!this.params.size) return { params: [], macros, arrows };
      const seen = new Set();
      const visit = (t, depth) => {
        if (depth > 20) return;
        for (const m of t.matchAll(/\\([A-Za-z]+)(?:\s*\{\s*([A-Za-z]+)\s*\})?/g)) {
          const cs = m[1];
          if (cs === 'tgvalue') { if (m[2] && this.params.has(m[2])) params.add(m[2]); continue; }
          if (this.paramCs.has(cs)) { params.add(cs); continue; }
          if (/^[lr]/.test(cs) && this.diagramArrows?.[cs.slice(1)]) arrows.add(cs.slice(1));
          if (seen.has(cs) || !this.macros[cs] || typeof this.macros[cs].body !== 'string') continue;
          seen.add(cs);
          visit(this.macros[cs].body, depth + 1);
          macros.push(cs);
        }
      };
      visit(tex, 0);
      return { params: Array.from(params), macros, arrows };
    }

    /** The paper's definitions of the macros a live piece uses, as TeX, to render it again on its own. */
    liveDefs(names, arrows) {
      const arrowDefs = Array.from(arrows, (name) => {
        const parts = this.diagramArrows[name].map((part) => '{' + part + '}').join('');
        return '\\newarrow{' + name + '}' + parts;
      });
      const macros = names.map((n) => {
        const m = this.macros[n];
        if (!m || m.delims || m.let) return '';
        return `\\renewcommand{\\${n}}${m.nargs ? `[${m.nargs}]` : ''}${m.nargs && m.def !== null ? `[${m.def}]` : ''}{${m.body}}`;
      });
      return arrowDefs.concat(macros).filter(Boolean).join('\n');
    }

    /** The parameters, for the sliders: hidden marks at the end of the page. */
    paramMarks() {
      if (!this.params.size || this.liveOnly) return '';
      const attr = (k, v) => (v === null || v === undefined ? '' : ` data-${k}="${escapeHtml(String(v))}"`);
      const label = (p) => {
        this.inPicture++; // no live marks in a label
        try {
          if (p.label) return this.flow(p.label, true).trim();
          const tex = p.name.length === 1 ? p.name : GREEK.test(p.name) ? '\\' + p.name : `\\mathrm{${p.name}}`;
          return this.renderMath(tex, false);
        } finally {
          this.inPicture--;
        }
      };
      const marks = Array.from(this.params.values()).map((p) => {
        // where the slider starts: the start value, else what the paper's \name holds, else the minimum
        const body = this.paramCs.has(p.name) && this.macros[p.name] ? String(this.macros[p.name].body).trim() : '';
        const value = p.start !== null ? p.start : p.seen || (NUMBER_RE.test(body) ? body : p.min);
        const step = p.step || String(+niceStep(+p.max - +p.min).toPrecision(1));
        return `<span class="tg-param"${attr('name', p.name)}${attr('min', p.min)}${attr('max', p.max)}${attr('value', value)}${attr('step', step)}${attr('label', label(p))}></span>`;
      });
      return `<div class="tg-params" hidden>${marks.join('')}</div>`;
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
          // a paragraph of nothing but texglass.sty markers is no paragraph
          out.push(inline ? para : TG_MARKERS.test(t) ? t : `<p>${t}</p>`);
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

      // TeX conditionals: run the branch the test picks (see skipConditional)
      if (name === 'fi' && !this.macros.fi) return res('', i);
      if ((name === 'else' || name === 'or') && !this.macros[name]) {
        const s = skipConditional(src, i, false, this.isCond);
        return res('', s ? s.end : i);
      }
      if (this.isCond(name)) return res('', this.conditional(name, src, i));
      if (name === 'newif') {
        const t = readToken(src, i);
        if (/^\\if[A-Za-z@]+$/.test(t.tok) && t.tok !== '\\iftexglass') {
          this.flags.set(t.tok.slice(1), false);
          this._katexMacros = null;
        }
        return res('', t.end);
      }
      {
        const f = /^(.+)(true|false)$/.exec(name);
        if (f && this.flags.has('if' + f[1]) && !this.macros[name]) {
          if (f[1] !== 'texglass') this.flags.set('if' + f[1], f[2] === 'true');
          this._katexMacros = null;
          return res('', i);
        }
      }

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
      // \fontsize{size}{baselineskip}: the sizes are dropped, not printed.
      if (name === 'fontsize') return res('', readArg(src, readArg(src, i).end).end);

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
        // diagrams.sty, unless the paper defines a command of that name itself
        case 'diagramstyle':
          if (this.macros[name]) break;
          this.taylorDiagrams = true;
          this._katexMacros = null;
          return res('', readOpt(src, i)?.end || i);
        case 'newarrow': {
          if (this.macros[name]) break;
          const bare = /^[A-Za-z]+/.exec(src.slice(i));
          const arrow = bare ? { content: bare[0], end: i + bare[0].length } : readArg(src, i);
          if (!/^[A-Za-z]+$/.test(arrow.content)) break;
          const parts = [];
          let end = arrow.end;
          for (let k = 0; k < 5; k++) {
            const part = readArg(src, end);
            parts.push(part.content.trim());
            end = part.end;
          }
          (this.diagramArrows ||= Object.create(null))[arrow.content] = parts;
          this.taylorDiagrams = true;
          this._katexMacros = null;
          return res('', end);
        }
        // texglass.sty (docs/GUIDE.md, "Hints for TeXglass in your own papers"):
        // hints that ordinary LaTeX ignores, read here.
        case 'tgdefine': {
          // \tgdefine{symbol}{meaning}: what a symbol means, for notation hovers and the index
          const s = readArg(src, i);
          const m = readArg(src, s.end);
          const sym = tgSymbol(s.content);
          if (!sym) return res('', m.end);
          // the meaning goes in an attribute, so that it is no running text of the page
          const meaning = escapeHtml(this.flow(m.content, true).trim());
          if (this.inPreamble) {
            (this.tgPreamble || (this.tgPreamble = [])).push(`<span class="tg-define" data-tg-sym="${escapeHtml(sym)}" data-tg-meaning="${meaning}" data-tg-scope="document"></span>`);
            return res('', m.end);
          }
          return res(`<span class="tg-define" data-tg-sym="${escapeHtml(sym)}" data-tg-meaning="${meaning}"></span>`, m.end);
        }
        case 'tguses': {
          // \tguses{lem:a,thm:b}: links for the dependency map that the text does not state
          const a = readArg(src, i);
          const links = a.content.split(',').map((k) => k.trim()).filter(Boolean).map((key) => {
            const info = this.lookup(key);
            if (!info) {
              if (this.known) this.warnings.push(`Undefined reference "${key}" in \\tguses.`);
              return '';
            }
            return `<a class="ref tg-uses" href="#${info.id}" data-label="${escapeHtml(key)}" aria-hidden="true" tabindex="-1"></a>`;
          });
          return res(links.join(''), a.end);
        }
        case 'tgparam': {
          // \tgparam[start]{name}{min}{max}: a parameter readers may vary with a slider.
          // All of them were read first (startParams); their marks go at the end of the page.
          const r = readParam(src, i);
          if (!r.param && this.known) this.warnings.push('A \\tgparam needs a name of letters and numbers min < max.');
          return res('', r.end);
        }
        case 'tgvalue': {
          // \tgvalue{name}: the parameter's value, which a slider changes (src/params.js)
          const a = readArg(src, i);
          const n = a.content.trim();
          const v = this.paramValue(n);
          if (v === null) {
            if (this.known) this.warnings.push(`Unknown parameter "${n}" in \\tgvalue.`);
            return res('??', a.end);
          }
          return res(this.inPicture ? v : `<span class="tg-value" data-tg-param="${escapeHtml(n)}">${escapeHtml(v)}</span>`, a.end);
        }
        case 'pgfmathsetmacro': case 'pgfmathtruncatemacro': {
          // \pgfmathsetmacro{\r}{2*\a} outside a picture: \r holds the number
          const nm = readArg(src, i);
          const val = readArg(src, nm.end);
          const key = nm.content.trim().replace(/^\\/, '');
          if (!/^[A-Za-z@]+$/.test(key) || this.lockedDef(key)) return res('', val.end);
          let body = this.putValues(val.content);
          const T = tikz();
          if (T && T._ && T._.evaluate) {
            try {
              const sub = body.replace(/\\([A-Za-z@]+)/g, (all, cs) => (this.macros[cs] && !this.macros[cs].nargs && NUMBER_RE.test(this.macros[cs].body.trim()) ? `(${this.macros[cs].body.trim()})` : all));
              const v = T._.evaluate(sub).v;
              if (typeof v === 'number' && isFinite(v)) body = String(name === 'pgfmathtruncatemacro' ? Math.trunc(v) : +v.toFixed(5));
            } catch (e) { /* keep the text */ }
          }
          this.macros[key] = { nargs: 0, def: null, body };
          this._katexMacros = null;
          return res('', val.end);
        }
        case 'tgstep': {
          // \tgstep[title]: an author's step break in a proof, for stepping through it (src/steps.js)
          const o = readOpt(src, i);
          const title = o ? stripTags(this.flow(o.content, true)).replace(/\s+/g, ' ').trim() : '';
          return res(`<span class="tg-stepmark" data-tg-step="${escapeHtml(title)}"></span>`, o ? o.end : i);
        }
        case 'tghide': {
          // \tghide{…}: in the PDF only
          const a = readArg(src, i);
          return res('', a.end);
        }
        case 'tgonly': {
          // \tgonly{…}: in TeXglass only (LaTeX leaves it out)
          const a = readArg(src, i);
          const pad = (re) => (re.test(a.content) ? ' ' : '');
          return res(pad(/^\s/) + this.flow(a.content, true).trim() + pad(/\s$/), a.end);
        }
        case 'label': {
          // cleveref's \label[type]{key}: the [type] only changes how \cref names it
          const o = readOpt(src, i);
          const a = readArg(src, o ? o.end : i);
          const t = this.target || { num: '', kind: 'none', id: this.newId('label') };
          this.setLabel(a.content, Object.assign({}, t));
          // a theorem's first label names it on the page (reading progress, src/progress.js)
          if (this.target && /^thm-/.test(t.id) && a.content.trim()) {
            if (!this.thmLabels) this.thmLabels = Object.create(null);
            if (!this.thmLabels[t.id]) this.thmLabels[t.id] = a.content.trim();
          }
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
          return res(this.footnote(a.content, true), a.end);
        }
        case 'texorpdfstring': {
          const tex = readArg(src, i);
          const pdf = readArg(src, tex.end);
          return res(this.flow(tex.content, inline), pdf.end);
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
        case 'verb': case 'lstinline': {
          const s = readStar(src, i);
          const opt = name === 'lstinline' ? readOpt(src, s.end) : null;
          const code = inlineCode(src, opt ? opt.end : s.end, name === 'lstinline');
          return res(`<code>${escapeHtml(code.content)}</code>`, code.end);
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
        case 'maketitle': {
          this.titleShown = true;
          const held = this.heldAbstract || '';
          this.heldAbstract = '';
          return res(this.titleBlock() + held, i, { block: true });
        }
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
          if (TG_COMMANDS.has(key) || this.lockedDef(key)) return res('', body.end);
          if (name !== 'providecommand' || !this.macros[key]) {
            this.macros[key] = { nargs: nargs ? parseInt(nargs.content, 10) || 0 : 0, def: def ? def.content : null, body: body.content };
            this._katexMacros = null;
          }
          return res('', body.end);
        }
        case 'def': case 'gdef': case 'edef': case 'xdef': {
          let nm = readArg(src, i);
          // \expandafter\def\csname name\endcsname{…}: a name built from text
          // (the \expandafter itself is dropped as an unknown command)
          if (nm && nm.content === '\\csname') {
            const e = src.indexOf('\\endcsname', nm.end);
            const cs = e >= 0 && src.slice(nm.end, e).trim();
            if (cs && /^[A-Za-z@]+$/.test(cs)) nm = { content: '\\' + cs, end: e + '\\endcsname'.length };
          }
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
          if (TG_COMMANDS.has(nm.content.replace(/^\\/, '')) || this.lockedDef(nm.content.replace(/^\\/, ''))) return res('', body.end);
          this.macros[nm.content.replace(/^\\/, '')] = mac;
          this._katexMacros = null;
          return res('', body.end);
        }
        case 'let': {
          const m = /^\s*\\([A-Za-z@]+)\s*=?\s*(\\[A-Za-z@]+|.)/.exec(src.slice(i));
          if (!m) return res('', i);
          // \let\cmd\@undefined (or \undefined) forgets \cmd, as before redefining it
          const target = m[2].replace(/^\\/, '');
          if (/^\\(@undefined|undefined)$/.test(m[2])) delete this.macros[m[1]];
          // \let\ifdone\iftrue: a flag set by hand
          else if (/^if[A-Za-z@]+$/.test(m[1]) && (target === 'iftrue' || target === 'iffalse')) this.flags.set(m[1], target === 'iftrue');
          // \let\a\b copies what \b means now, so \renewcommand{\b}{…\a…} does not loop
          else if (m[2][0] === '\\' && this.macros[target]) this.macros[m[1]] = Object.assign({}, this.macros[target]);
          else this.macros[m[1]] = { nargs: 0, def: null, body: m[2], let: m[2][0] === '\\' };
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
        case 'texglassCyr': {
          const m = /^[ \t]*([A-Za-z]+)/.exec(src.slice(i));
          return m ? res(escapeHtml(cyrillic(m[1])), i + m[0].length) : res('', i);
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
        case 'font': {
          // Plain TeX font declarations used as text selectors in math boxes.
          const font = /^\\([A-Za-z@]+)\s*=\s*(cmss|wncy[rbi])(\d+)(?![A-Za-z0-9])(?:\s+(?:at\s*[\d.]+\s*pt|scaled\s*(?:\\magstep\s*)?\d+))?/.exec(src.slice(i));
          if (!font) break;
          this.macros[font[1]] = { nargs: 0, def: null, body: font[2] === 'cmss' ? '\\sf' : '\\texglassCyr' };
          this._katexMacros = null;
          return res('', i + font[0].length);
        }
        case 'newtcblisting': {
          const init = readOpt(src, i);
          const listing = readArg(src, init ? init.end : i);
          const nargs = readOpt(src, listing.end);
          const def = nargs ? readOpt(src, nargs.end) : null;
          const settings = readArg(src, def ? def.end : nargs ? nargs.end : listing.end);
          this.verbatim.add(listing.content.trim());
          return res('', settings.end);
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
          if (TG_ENVS.has(nm.content.trim())) return res('', end.end);
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

      // A parameter's macro in text: its value, which a slider changes
      if (this.paramCs && this.paramCs.has(name) && !this.inPicture && this.macros[name] && !this.macros[name].nargs) {
        return res(`<span class="tg-value" data-tg-param="${escapeHtml(name)}">${this.flow(this.macros[name].body, true)}</span>`, i);
      }

      // User macros used in text.
      if (this.macros[name]) {
        const mac = this.macros[name];
        // another name for a command of ours, as in \newcommand{\newcom}{\newcommand}
        // or \let\eps\varepsilon: that command, reading its own arguments
        const alias = !mac.nargs && !mac.delims && /^\s*\\([A-Za-z@]+)\s*$/.exec(mac.body);
        if (alias && alias[1] !== name && !this.isMathBody(mac.body, 0) && !this.macros[alias[1]] && !this.isCond(alias[1])) return this.command(alias[1], src, i, inline);
        return this.expandMacro(mac, src, i, inline);
      }

      // Page-layout lengths and plain TeX spacing (\textwidth 16cm, \vskip 2pt plus 1pt):
      // nothing to show, and their sizes must not end up in the text.
      if (TEX_LENGTHS.has(name) || TEX_SKIPS.has(name)) return res('', skipGlue(src, i));
      if (name === 'newblock') return res(' ', i);
      if (name === 'romannumeral' || name === 'uppercase') {
        const m = /^\s*(?:\\expandafter\s*)?(\{\s*\\romannumeral\s*)?(\d+)\s*(\})?/.exec(src.slice(i));
        if (m && (name === 'romannumeral' ? !m[1] : m[1] && m[3])) {
          const r = roman(+m[2]);
          return res(name === 'uppercase' ? r.toUpperCase() : r, i + m[0].length);
        }
      }
      if (name === 'centerline') {
        const a = readArg(src, i);
        if (a) return res(`<span class="center" style="display:block">${this.flow(a.content, true)}</span>`, a.end);
      }

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

    /** Run the test of a conditional that starts at i; returns where reading goes on. */
    conditional(name, src, i) {
      let value = false;
      let j = i;
      switch (name) {
        case 'iftrue': case 'ifhmode': value = true; break;
        case 'iffalse': case 'ifmmode': case 'ifinner': case 'ifvmode': break;
        case 'ifx': {
          // \expandafter\ifx\csname foo\endcsname\relax: an unknown name made by
          // \csname means \relax
          const csname = (from) => {
            const t = readToken(src, from);
            if (t.tok !== '\\csname') return { tok: t.tok, mean: this.meaning(t.tok), end: t.end };
            const e = src.indexOf('\\endcsname', t.end);
            if (e < 0) return { tok: t.tok, mean: 'csname', end: t.end };
            const name = src.slice(t.end, e).trim();
            return { tok: '\\' + name, mean: this.macros[name] ? this.meaning('\\' + name) : 'prim:relax', end: e + '\\endcsname'.length };
          };
          const a = csname(j);
          const b = csname(a.end);
          j = b.end;
          value = a.tok === b.tok || a.mean === b.mean;
          break;
        }
        case 'if': case 'ifcat': {
          const a = readToken(src, j);
          const b = readToken(src, a.end);
          j = b.end;
          value = a.tok === b.tok;
          break;
        }
        case 'ifdefined': {
          const a = readToken(src, j);
          j = a.end;
          value = this.meaning(a.tok) !== 'undefined';
          break;
        }
        case 'ifcsname': {
          const e = src.indexOf('\\endcsname', j);
          if (e >= 0) {
            value = !!this.macros[src.slice(j, e).trim()];
            j = e + '\\endcsname'.length;
          }
          break;
        }
        case 'ifnum': case 'ifodd': {
          const a = readNumber(src, j);
          if (!a) break;
          if (name === 'ifodd') { value = a.value % 2 !== 0; j = a.end; break; }
          const rel = /^\s*([<=>])/.exec(src.slice(a.end, a.end + 8));
          const b = rel && readNumber(src, a.end + rel[0].length);
          if (b) {
            value = rel[1] === '<' ? a.value < b.value : rel[1] === '>' ? a.value > b.value : a.value === b.value;
            j = b.end;
          }
          break;
        }
        case 'ifcase': {
          const a = readNumber(src, j);
          let n = a ? a.value : 0;
          j = a ? a.end : j;
          while (n-- > 0) {
            const s = skipConditional(src, j, true, this.isCond);
            if (!s) return j;
            j = s.end;
            if (s.at !== 'or') break;
          }
          return j;
        }
        default:
          value = !!this.flags.get(name);
      }
      if (value) return j;
      const s = skipConditional(src, j, true, this.isCond);
      return s ? s.end : j;
    }

    /** What a token means, for \ifx: equal strings mean the same thing. */
    meaning(tok) {
      for (let k = 0; k < 8 && tok[0] === '\\'; k++) {
        const name = tok.slice(1);
        if (name === 'undefined' || name === '@undefined') return 'undefined';
        if (name === 'empty' || name === '@empty') return 'macro:0:';
        const m = this.macros[name];
        if (!m) return this.isCond(name) || name in SYMBOLS || NOOPS.has(name) || name in TEXT_STYLES || name in SECTIONS ? 'prim:' + name : 'undefined';
        // \let\a\b: \a means what \b means
        if (m.let) { tok = m.body; continue; }
        return `macro:${m.nargs}:${m.delims ? m.delims.join('#') : ''}:${m.body}`;
      }
      return 'char:' + tok;
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

    /**
     * A footnote; its mark is the next number, or for `symbol` (\thanks in the
     * title) the next of LaTeX's footnote symbols, which leave the numbers alone.
     */
    footnote(text, symbol) {
      this.footnotes.push(null);
      const k = this.footnotes.length;
      if (symbol) (this.fnSymbols || (this.fnSymbols = []))[k - 1] = FN_SYMBOLS[this.fnSymbols.filter(Boolean).length % FN_SYMBOLS.length];
      this.footnotes[k - 1] = this.flow(text, true);
      return `<sup class="fn"><a href="#fn-${k}" id="fnref-${k}">${escapeHtml(this.fnLabel(k))}</a></sup>`;
    }

    /** The mark of footnote k (from 1): its symbol, or its number among the numbered ones. */
    fnLabel(k) {
      const syms = this.fnSymbols || [];
      if (syms[k - 1]) return syms[k - 1];
      return String(k - syms.slice(0, k - 1).filter(Boolean).length);
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
        // A name, then lines of affiliation after \\ (in the text's own font, not the name's small capitals).
        const lineSep = (t, i) => {
          const b = /^\\\\\*?(?:\s*\[[^\]]*\])?/.exec(t.slice(i, i + 40));
          return b ? b[0].length : 0;
        };
        const authors = splitTop(m.author, commandSep('and')).map((a) => {
          const [name, ...lines] = splitTop(a.trim(), lineSep).map((l) => l.trim()).filter(Boolean);
          const affil = lines.map((l) => `<span class="affil">${this.flow(l, true)}</span>`).join('');
          return `<span class="author">${this.flow(name || '', true)}${affil}</span>`;
        });
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
      // The contents entry is itself a link: links in the title (\eqref, \cite) become plain text,
      // since a link inside a link breaks the entry apart.
      const tocTitle = (o ? this.flow(o.content, true) : title).replace(/<a\b[^>]*>|<\/a>/g, '');
      if (!s.star || level <= 2) this.toc.push({ level, num, title: tocTitle, id });
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
      const isVerbatim = this.verbatim.has(name);
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
        if (name === 'lstlisting' || name === 'Verbatim') code = code.replace(/^\s*\[[^\]]*\]/, '');
        return `<pre class="verbatim"><code>${escapeHtml(code.replace(/^\n/, '').replace(/\s+$/, ''))}</code></pre>`;
      }
      if (name === 'math') return this.inlineMath(body);
      if (name === 'mathpar' && this.macros['mpr@inferrule']) {
        const o = readOpt(body, 0);
        const content = o ? body.slice(o.end) : body;
        const and = commandSep('and');
        return splitTop(content, (src, i) => and(src, i) || (src[i] === '\n' ? (/^\n[ \t]*\n/.exec(src.slice(i)) || [''])[0].length : 0))
          .filter((rule) => rule.trim()).map((rule) => this.displayMath('displaymath', rule)).join('\n');
      }
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
        case 'tghide': // texglass.sty: in the PDF only
          return '';
        case 'tgonly': // texglass.sty: in TeXglass only
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
        case 'abstract': {
          const html = `<div class="abstract"><div class="abstract-title">Abstract</div>${this.flow(body, false)}</div>`;
          // AMS classes want the abstract before \maketitle and print it under the title
          if (this.amsTitle && !this.titleShown) {
            this.heldAbstract = (this.heldAbstract || '') + html;
            return '';
          }
          return html;
        }
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
        case 'diagram':
          return this.taylorDiagram(body);
        case 'tikzpicture':
          return withSource(this.tikzpicture(body), name, body);
        case 'picture': case 'pgfpicture': case 'axis':
          return withSource(`<div class="graphic-placeholder">[${escapeHtml(name)} diagram]</div>`, name, body);
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
      const label = this.thmLabels && this.thmLabels[id];
      return `<div class="${cls}" id="${id}" data-number="${escapeHtml(num)}"${label ? ` data-label="${escapeHtml(label)}"` : ''}>${attachHead(head, content)}</div>`;
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
      // enumitem keys (label=, ref=, start=, resume, resume*) or an enumerate-package template like [(i)]
      const keys = opt != null ? listKeys(opt) : {};
      if (!this.enumResume) this.enumResume = Object.create(null);
      const prev = isEnum ? this.enumResume[depth] : null;
      let template = null;
      let refTemplate = null;
      if (isEnum && opt != null) {
        if ('resume*' in keys && prev) ({ template, refTemplate } = prev);
        if ('label' in keys) template = keys.label;
        else if ('label*' in keys) template = keys['label*'];
        if ('ref' in keys) refTemplate = keys.ref;
        if (!template && !/=/.test(opt) && /\\(alph|Alph|roman|Roman|arabic)\*?|\b[aAiI1]\b/.test(opt)) template = opt;
      }
      if (isEnum) {
        this.newCounter(counter, null);
        let start = 0;
        if (('resume' in keys || 'resume*' in keys) && prev) start = prev.value;
        else if (/^-?\d+$/.test((keys.start || '').trim())) start = parseInt(keys.start, 10) - 1;
        this.counters[counter].value = start;
      }
      const parentNum = isEnum && this.enumRefPrefix ? this.enumRefPrefix : '';
      const items = splitTop(body, commandSep('item')).slice(1);
      const out = items.map((item) => {
        let label = '';
        const io = readOpt(item, 0);
        if (io) item = item.slice(io.end);
        const id = this.newId('item');
        if (io) label = this.flow(io.content, true);
        if (isEnum) {
          this.counters[counter].value++;
          const v = this.counters[counter].value;
          let num;
          if (template && /\\/.test(template)) {
            // A label with commands (\upshape, \textbf, \ref, ...): fill in the counter, then render it.
            const html = this.flow(fillEnum(template, v), true);
            if (!io) label = html;
            num = stripTags(this.flow(fillEnum(refTemplate || template.replace(/\$/g, ''), v), true)).trim();
            if (!refTemplate) num = num.replace(/\.$/, '');
          } else {
            const formatted = formatEnum(depth, v, template);
            if (!io) label = escapeHtml(formatted.label);
            num = refTemplate ? stripTags(this.flow(fillEnum(refTemplate, v), true)).trim() : formatted.ref;
          }
          this.target = { num: parentNum + num, kind: 'item', id, name: '' };
        } else if (!io) {
          label = ['•', '–', '∗', '·'][(depth - 1) % 4];
        }
        const savedPrefix = this.enumRefPrefix;
        if (isEnum) this.enumRefPrefix = this.target.num;
        const content = this.flow(item, false);
        this.enumRefPrefix = savedPrefix;
        return `<li class="item" id="${id}"><span class="item-label">${label}</span><div class="item-body">${content}</div></li>`;
      });
      if (isEnum) this.enumResume[depth] = { value: this.counters[counter].value, template, refTemplate };
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

    tabular(name, body, mathCells) {
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
      if (name === 'array' && !mathCells) {
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
          const html = mathCells && !/\\begin\s*\{minipage\}/.test(text) ? this.inlineMath(text) : this.flow(text, true);
          return `<td${span > 1 ? ` colspan="${span}"` : ''} style="text-align:${align}">${html}</td>`;
        });
        return `<tr>${tds.join('')}</tr>`;
      });
      return `<div class="table-wrap"><table class="tabular"><tbody>${trs.join('')}</tbody></table></div>`;
    }

    // --- display math with equation numbering -----------------------------

    displayMath(name, body) {
      const psbox = /^\s*(?:\\hspace\*?\s*\{[^{}]*\}\s*)?(?:\\psannotate\s*\{\s*)?\\psboxto\s*\([^()]*\)\s*\{([^{}]+)\}\s*(?:\}\s*\{\s*\})?\s*$/.exec(body);
      if (name === 'displaymath' && psbox) return `<div class="math-display">${this.flow(`\\includegraphics{${psbox[1]}}`, true)}</div>`;
      const starred = name.endsWith('*') || name === 'displaymath';
      const base = name.replace(/\*$/, '');
      const id = this.newId('eq');
      // The source to copy: the formula as written, with the environment kept
      // where its rows need it (align, gather, ...).
      const src = texAttr(/^(align|gather|flalign|alignat|eqnarray|multline)$/.test(base) ? `\\begin{${name}}${body}\\end{${name}}` : body);
      if (name === 'displaymath' && /\\(?:multicolumn(?![A-Za-z@])|begin\s*\{minipage\})/.test(body)) {
        const array = /^\s*\\begin\s*\{array\}/.exec(body);
        if (array) {
          const end = findEnvEnd(body, array[0].length, 'array');
          if (end.contentEnd < body.length && !body.slice(end.end).trim()) {
            return this.tabular('array', body.slice(array[0].length, end.contentEnd), true);
          }
        }
      }
      if (DIAGRAM_RE.test(body) && tikz()) {
        // A diagram (with maybe some math around it and an equation number).
        const r = this.numberRow(body.replace(/\\\\\s*$/, ''), !starred && base !== 'displaymath', id);
        const t = /\\tag(\*?)\{([\s\S]*)\}$/.exec(r.tag);
        // with no number, an empty tag still balances the spacer on the left, so the diagram is centred
        const label = t ? unwrapMathShift(t[2]) : '';
        const tag = `<span class="diagram-tag">${t ? this.renderMath(t[1] ? label : `(${label})`, false) : ''}</span>`;
        return `<div class="math math-display diagram-display" id="${id}"${src}><span class="diagram-row">${this.mathWithDiagrams(r.tex)}</span>${tag}</div>`;
      }
      const multiRow = /^(align|gather|flalign|alignat|eqnarray)$/.test(base);
      let tex;
      if (!multiRow) {
        const r = this.numberRow(body, !starred && base !== 'displaymath', id);
        let inner = r.tex;
        if (base === 'equation' && inner.includes('$$')) {
          // Some sources split one numbered equation with a plain-TeX display break.
          const rows = splitTop(inner, (s, i) => s.startsWith('$$', i) ? /^\$\$\s*\$\$/.exec(s.slice(i))?.[0].length || 0 : 0);
          if (rows.length > 1) inner = `\\begin{gathered}${rows.join(' \\\\ ')}\\end{gathered}`;
        }
        if (base === 'multline') inner = `\\begin{gathered}${inner}\\end{gathered}`;
        if (base === 'displaymath' && inner.includes('&') && inner.includes('\\\\')) {
          const rows = splitTop(inner, rowSep);
          if (rows.length > 1 && rows.some((row) => splitTop(row, cellSep).length > 1)) {
            inner = `\\begin{aligned}${rows.join(' \\\\ ')}\\end{aligned}`;
          }
        }
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

    /**
     * A figure inside a formula (\vcenter{\hbox{\includegraphics[height=3cm]{f}}},
     * or from a macro): KaTeX holds a rule of its size, tinted with a colour
     * that names it, and putImages swaps the image in.
     */
    mathImage(opts, file) {
      opts = (opts || '').replace(/\s+/g, ' ');
      const size = (key) => {
        const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(\\d+(?:\\.\\d*)?|\\.\\d+)\\s*(cm|mm|in|pt|bp|em|ex)`).exec(opts);
        return m ? parseFloat(m[1]) * EM_PER[m[2]] : 0;
      };
      const r = (x) => Math.round(x * 1000) / 1000;
      const width = size('width');
      const height = size('height') || size('totalheight');
      // with no size given, a figure about as tall as a few lines
      const h = height || (width ? width * 0.75 : 3);
      const w = width || h * 1.33;
      let html = this.flow(`\\includegraphics[${opts}]{${file}}`, true);
      if (!width && !height) html = html.replace(/^<img /, `<img style="height:${r(h)}em" `);
      const list = this.mathImages || (this.mathImages = new Map());
      const color = this.markerColor(list);
      list.set(color, { html, size: `border-right-width:${r(w)}em;border-top-width:${r(h)}em;` });
      return `\\textcolor{${color}}{\\rule{${r(w)}em}{${r(h)}em}}`;
    }

    /**
     * A colour for an image marker that neither this formula nor the paper's
     * macros write anywhere, so a rule the paper tints itself is never taken
     * for a marker. It follows from the formula, so the same formula gives the
     * same HTML each time.
     */
    markerColor(used) {
      const tex = this.mathImageTex || '';
      if (this._markerMacros !== this._katexMacros) {
        this._markerMacros = this._katexMacros;
        this._macroColors = new Set((JSON.stringify(this.macros) + JSON.stringify(this.paired || {})).toLowerCase().match(/#[0-9a-f]{6}/g) || []);
      }
      const own = new Set(tex.toLowerCase().match(/#[0-9a-f]{6}/g) || []);
      let h = 2166136261;
      for (let k = 0; k < tex.length; k++) h = Math.imul(h ^ tex.charCodeAt(k), 16777619);
      for (let n = used.size; ; n++) {
        // a letter first: KaTeX would read # and a digit in a macro's result as a parameter
        const x = Math.imul(h ^ n, 2654435761) >>> 0;
        const c = '#' + 'abcdef'[x % 6] + ((x >>> 3) & 0xfffff).toString(16).padStart(5, '0');
        if (!used.has(c) && !own.has(c) && !this._macroColors.has(c) && !/^#a5/.test(c)) return c;
      }
    }

    /** Put the figures where mathImage left their rules in KaTeX's output. */
    putImages(html) {
      return html.replace(/<span class="mord rule( mtight)?" style="color:(#[0-9a-f]{6});([^"]*)"><\/span>/g, (m, tight, color, style) => {
        // only this formula's markers, by colour and size
        const img = this.mathImages.get(color);
        return img && style.startsWith(img.size) ? `<span class="mord tg-math-figure${tight || ''}">${img.html}</span>` : m;
      });
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
        return this.displayMath(label || /\\(label|tag)\s*(?:\[[^\]]*\]\s*)?\{/.test(body) ? 'equation' : 'equation*', body + lab);
      }
      if (label) {
        // One number for the block: the rows go in an aligned inside an equation.
        const tags = [];
        body = body.replace(/\\(?:nonumber|notag)\b/g, '').replace(/\\tag\*?\s*\{[^}]*\}/g, (t) => { tags.push(t); return ''; });
        return this.displayMath('equation', `\\begin{aligned}${body}\\end{aligned}${lab}${tags.slice(0, 1).join('')}`);
      }
      const rows = splitTop(body, rowSep).map((r) => (!r.trim() || /\\(label|tag)\s*(?:\[[^\]]*\]\s*)?\{/.test(r) ? r : `${r} \\nonumber`));
      return this.displayMath('align', rows.join(' \\\\ '));
    }

    /** Math that contains tikzcd, xymatrix or tikzpicture: diagrams between pieces of KaTeX. */
    mathWithDiagrams(tex) {
      const T = tikz();
      const math = (t, display) => this.renderMath(t, display);
      const out = [];
      let rest = unwrapDiagrams(tex.replace(/\\index\s*\{[^}]*\}|\\SelectTips\s*\{[^}]*\}\s*\{[^}]*\}/g, ''));
      rest = rest.replace(/\\begin\s*\{xy\}(\s*\\xymatrix[\s\S]*?)\\end\s*\{xy\}/g, '$1');
      // \xymatrixcolsep{…} and \xymatrixrowsep{…} apply to the next \xymatrix
      rest = rest.replace(/\\xymatrix(col|row)sep\s*\{([^}]*)\}\s*([\s\S]*?)\\xymatrix(?![A-Za-z])/g, (m, w, v, between) =>
        `${between}\\xymatrix@${w === 'col' ? 'C' : 'R'}=${v}`);
      const piece = (t) => {
        t = balanceMath(t).replace(/\\vcenter\s*$/, '').replace(/\\(?=[\n\r\t])/g, '\\ ').replace(/^\s+/, '').replace(/(?<!\\)\s+$/, '');
        if (t.trim()) out.push(`<span class="diagram-math">${this.renderMath(`\\displaystyle ${t}`, false)}</span>`);
      };
      for (let guard = 0; guard < 100; guard++) {
        const m = DIAGRAM_RE.exec(rest);
        if (!m) break;
        // A diagram can be a numerator or denominator. Render each complete
        // argument, so neither the fraction nor its diagrams are cut in half.
        let fraction = null;
        for (const f of rest.matchAll(/\\(?:frac|dfrac|tfrac)\s*(?=\{)/g)) {
          if (f.index >= m.index) break;
          const numerator = readGroup(rest, f.index + f[0].length);
          const bottom = skipWhite(rest, numerator.end);
          if (rest[bottom] !== '{') continue;
          const denominator = readGroup(rest, bottom);
          if (rest[denominator.end - 1] !== '}' || m.index >= denominator.end) continue;
          fraction = { at: f.index, numerator, denominator };
          break;
        }
        if (fraction) {
          piece(rest.slice(0, fraction.at));
          const top = this.mathWithDiagrams(fraction.numerator.content);
          const bottom = this.mathWithDiagrams(fraction.denominator.content);
          out.push(`<span class="diagram-fraction"><span>${top}</span><span>${bottom}</span></span>`);
          rest = rest.slice(fraction.denominator.end);
          continue;
        }
        piece(rest.slice(0, m.index));
        if (m[1]) {
          const at = m.index + m[0].length;
          const e = findEnvEnd(rest, at, m[1]);
          const body = rest.slice(at, e.contentEnd);
          if (m[1] === 'diagram') out.push(this.taylorDiagram(body));
          else out.push(m[1] === 'tikzcd' ? T.tikzcd(body, math) : this.tikzpicture(body));
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

    taylorDiagram(body) {
      // A diagram means diagrams.sty, even without \usepackage: cells such as
      // \rTo^f B draw \rTo as an inline arrow.
      if (!this.taylorDiagrams) { this.taylorDiagrams = true; this._katexMacros = null; }
      // footnotes in the cells are made while drawing; a diagram that falls back to source takes them back
      // (and the labels in them)
      const notes = this.footnotes.length;
      const symbols = this.fnSymbols ? this.fnSymbols.length : 0;
      const labels = Object.assign(Object.create(null), this.labels);
      // An arrow with no inline form, reached while KaTeX expands a cell, is
      // reported by a probe macro, not read from the drawn markup.
      const T = tikz();
      let hit = false;
      const probe = Object.create(null);
      for (const name of T?.taylorBlockArrows?.(this.diagramArrows) || []) {
        if (!this.macros[name]) probe['\\' + name] = () => { hit = true; return '\\square'; };
      }
      const outer = this.mathProbe;
      this.mathProbe = probe;
      // the first pass skips maths, but whether this grid is kept decides its footnotes' labels
      const draw = this.renderMathFn;
      if (!this.known) this.renderMathFn = this.options.renderMath || defaultRenderMath;
      let html;
      try {
        html = T?.taylorDiagram(body, (tex) => this.renderMath(tex, false), this.diagramArrows,
          (name) => this.macros[name] || this.paired[name] || null, () => hit);
      } finally {
        this.mathProbe = outer;
        this.renderMathFn = draw;
      }
      if (!html && this.footnotes.length > notes) {
        this.footnotes.length = notes;
        if (this.fnSymbols) this.fnSymbols.length = Math.min(symbols, this.fnSymbols.length);
        for (const [key, k] of this.mathNotes || []) if (k > notes) this.mathNotes.delete(key);
        for (const key of Object.keys(this.labels)) if (!(key in labels)) delete this.labels[key];
        Object.assign(this.labels, labels);
      }
      return html || withSource('<span class="graphic-placeholder">[commutative diagram]</span>', 'diagram', body);
    }

    tikzpicture(body) {
      const T = tikz();
      if (T && T.tikzpicture) {
        let live = '';
        if (this.params.size && !this.inPicture) {
          // a picture that uses a \tgparam is drawn again when a slider moves (src/params.js)
          live = this.liveMark(body, ' data-tg-picture=""');
          for (const name of this.paramCs) {
            const p = this.params.get(name);
            const own = new RegExp('\\\\(?:[egx]?def|pgfmathsetmacro|(?:re)?newcommand)\\s*\\{?\\s*\\\\' + name + '(?![A-Za-z@])\\s*\\}?\\s*\\{\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+))\\s*\\}').exec(body);
            if (own && p.seen === undefined) p.seen = own[1];
            if (this.locked.has(name)) body = setDefinitions(body, name, this.paramValue(name));
          }
          body = this.putValues(body);
        }
        this.inPicture++;
        let html;
        try {
          html = T.tikzpicture(body, {
            math: (t, display) => this.renderMath(t, display),
            text: (t) => this.flow(t, true),
            styles: this.tikzStyles || '',
            colors: this.tikzColors || null,
            macros: this.macros,
          });
        } finally {
          this.inPicture--;
        }
        // the mark goes inside the picture's element, which src/params.js replaces
        return live ? html.replace(/^(<(?:span|div) class="tg-diagram[^"]*">)/, (m) => m + live) : html;
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
      row = row.replace(/\\label\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g, (_, l) => { labels.push(l); return ''; });
      if (/\\(nonumber|notag)\b/.test(row)) {
        numbered = false;
        row = row.replace(/\\(nonumber|notag)\b/g, '');
      }
      row = this.expandTagMacros(row);
      let tag = '';
      let num = '';
      const t = /\\tag(\*?)\s*(?=\{)/.exec(row);
      if (t) {
        // the tag may hold braces of its own: \tag*{$\mathsf{R_{ab}}$}
        const g = readGroup(row, t.index + t[0].length);
        row = row.slice(0, t.index) + row.slice(g.end);
        num = g.content;
        tag = `\\tag${t[1]}{${g.content}}`;
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

  /**
   * Where \begin{document} (or \end{document}) is: { at, length }, or null.
   * Some papers hide it behind a macro of their own, as in
   * \newcommand{\bd}{\begin{document}} … \bd, so the first use of such a macro counts too.
   */
  function documentMark(src, which) {
    // the first one that is not inside such a definition
    for (const m of src.matchAll(new RegExp(String.raw`\\${which}\s*\{document\}`, 'g'))) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
      if (!/\\(?:(?:re)?newcommand|providecommand|[gex]?def)(?![A-Za-z@])/.test(line)) return { at: m.index, length: m[0].length };
    }
    const def = new RegExp(String.raw`\\(?:(?:re)?newcommand\*?\s*\{?\s*|def\s*)\\([A-Za-z]+)\s*\}?\s*\{\s*\\${which}\s*\{document\}\s*\}`).exec(src);
    if (!def) return null;
    const use = new RegExp(String.raw`\\${def[1]}(?![A-Za-z@])`, 'g');
    use.lastIndex = def.index + def[0].length;
    const m = use.exec(src);
    return m ? { at: m.index, length: m[0].length } : null;
  }

  /**
   * Macros that stand for half of an environment, as in \def\be{\begin{equation}}
   * and \def\ee{\end{equation}}, are written out in the source first, so the
   * environment is seen whole. (Expanded one at a time, \be would make an empty
   * equation.) Also follows a paper's own name for \newcommand, as in
   * \newcommand{\newcom}{\newcommand}. `map` (source offsets, as from
   * stripCommentsMap) is kept in step: written-out text maps to the macro it came from.
   */
  function expandEnvShorthands(text, map) {
    const DEFINERS = ['newcommand', 'renewcommand', 'providecommand', 'def', 'gdef', 'edef', 'xdef'];
    for (let pass = 0; pass < 3; pass++) {
      const definers = DEFINERS.slice();
      const alias = /\\(?:(?:re)?newcommand\*?\s*\{\s*\\([A-Za-z@]+)\s*\}\s*\{\s*|let\s*\\([A-Za-z@]+)\s*=?\s*)\\((?:re)?newcommand|providecommand|[gex]?def)(?![A-Za-z@])\s*\}?/g;
      for (const m of text.matchAll(alias)) definers.push(m[1] || m[2]);
      const def = new RegExp(String.raw`\\(?:${definers.join('|')})\*?(?![A-Za-z@])\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?=\{)`, 'g');
      const defs = Object.create(null); // name -> [{ from, body }] in source order
      let found = false;
      for (const m of text.matchAll(def)) {
        const g = readGroup(text, m.index + m[0].length);
        const name = m[1] || m[2];
        const counts = Object.create(null);
        let first = null;
        for (const e of g.content.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
          if (!first) first = e[1];
          counts[e[2]] = (counts[e[2]] || 0) + (e[1] === 'begin' ? 1 : -1);
        }
        const unbalanced = first === 'end' || Object.values(counts).some((c) => c !== 0);
        (defs[name] || (defs[name] = [])).push({ from: g.end, body: unbalanced ? g.content : null });
        if (unbalanced) found = true;
      }
      if (!found) break;
      const out = [];
      const outMap = map ? [] : null;
      let last = 0;
      let changed = false;
      for (const m of text.matchAll(/\\([A-Za-z@]+)|\\./g)) {
        const list = m[1] && defs[m[1]];
        if (!list) continue;
        let d = null;
        for (const x of list) if (x.from <= m.index) d = x;
        if (!d || d.body === null) continue;
        // the name in a later \renewcommand{\be}… stays as it is
        if (/\\(?:(?:re)?newcommand|providecommand)\*?\s*\{?\s*$|\\(?:[gex]?def|let)\s*$/.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
        out.push(text.slice(last, m.index), d.body);
        if (outMap) {
          for (let k = last; k < m.index; k++) outMap.push(map[k]);
          for (let k = 0; k < d.body.length; k++) outMap.push(map[m.index]);
        }
        last = m.index + m[0].length;
        changed = true;
      }
      if (!changed) break;
      out.push(text.slice(last));
      if (outMap) {
        for (let k = last; k < text.length; k++) outMap.push(map[k]);
        map = outMap;
      }
      text = out.join('');
    }
    return { text, map };
  }

  // --- TeX conditionals --------------------------------------------------------
  //
  // Authors' macros, and the copies of package code that come with some
  // papers, test things with \ifx, \ifmmode, \ifnum or flags made with \newif,
  // then pick a branch with \else … \fi. Both in text and inside formulas
  // (through KaTeX macros) one branch is chosen, as TeX would, where the
  // test can be worked out; tests about TeX's internals (\ifdim, \ifvoid …)
  // count as false.

  const PRIMITIVE_IFS = new Set([
    'if', 'ifcat', 'ifnum', 'ifdim', 'ifodd', 'ifvmode', 'ifhmode', 'ifmmode', 'ifinner', 'ifvoid', 'ifhbox',
    'ifvbox', 'ifx', 'ifeof', 'iftrue', 'iffalse', 'ifcase', 'ifdefined', 'ifcsname', 'iffontchar', 'ifincsname',
  ]);
  // Flags that common packages (ifpdf, ifxetex, ifluatex, …) set, as TeXglass would answer them.
  const DEFAULT_FLAGS = {
    ifpdf: true, ifPDFTeX: true, ifpdftex: true, ifxetex: false, ifXeTeX: false, ifluatex: false, ifLuaTeX: false,
    ifvtex: false, iftutex: false, ifdraft: false,
    // texglass.sty: false in LaTeX, true here (\newif\iftexglass and \texglassfalse leave it so)
    iftexglass: true,
  };

  /** Read one token: a control sequence (with the spaces after a word) or a character. */
  function readToken(src, i) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '\\') return { tok: src[i] || '', end: Math.min(src.length, i + 1) };
    let j = i + 1;
    if (isLetter(src[j])) {
      while (isLetter(src[j])) j++;
      return { tok: src.slice(i, j), end: skipInline(src, j) };
    }
    return { tok: src.slice(i, j + 1), end: j + 1 };
  }

  /** A whole number written out, as in \ifnum 3>2 or \ifcase 1: { value, end }, or null. */
  function readNumber(src, i) {
    const m = /^\s*([+-]?\s*\d+)\s?/.exec(src.slice(i, i + 40));
    return m ? { value: parseInt(m[1].replace(/\s/g, ''), 10), end: i + m[0].length } : null;
  }

  /**
   * From inside a conditional, skip to its \fi (or, with `stop`, to an \else or
   * \or at the same level): { end, at } with `at` the word found, or null if
   * there is none, in which case nothing should be skipped.
   */
  function skipConditional(src, i, stop, isCond) {
    const re = /\\([A-Za-z@]+)|\\./g;
    re.lastIndex = i;
    let depth = 0;
    let m;
    while ((m = re.exec(src))) {
      const n = m[1];
      if (!n) continue;
      if (isCond(n)) depth++;
      else if (n === 'fi') {
        if (depth-- === 0) return { end: m.index + m[0].length, at: 'fi' };
      } else if (stop && depth === 0 && (n === 'else' || n === 'or')) return { end: m.index + m[0].length, at: n };
    }
    return null;
  }

  /** The same skip inside KaTeX, on its tokens. Returns the word it stopped at. */
  function katexSkip(ctx, stop) {
    let depth = 0;
    for (;;) {
      const t = ctx.popToken();
      if (t.text === 'EOF') { ctx.pushToken(t); return null; }
      if (t.text[0] !== '\\') continue;
      const n = t.text.slice(1);
      if (katexIsCond(ctx, n)) depth++;
      else if (n === 'fi') {
        if (depth-- === 0) return 'fi';
      } else if (stop && depth === 0 && (n === 'else' || n === 'or')) return n;
    }
  }

  function katexIsCond(ctx, n) {
    if (PRIMITIVE_IFS.has(n) || /^if@/.test(n)) return true;
    const m = /^if/.test(n) && ctx.macros.get('\\' + n);
    return m === '\\iftrue' || m === '\\iffalse';
  }

  const katexPop = (ctx) => {
    let t = ctx.popToken();
    while (t.text === ' ') t = ctx.popToken();
    return t;
  };

  /** What a token means, for \ifx: equal strings mean the same thing. */
  function katexMeaning(ctx, t) {
    if (t.text[0] !== '\\') return 'char:' + t.text;
    if (/^\\(@?undefined)$/.test(t.text)) return 'undefined';
    const m = ctx.macros.get(t.text);
    if (m === undefined) return ctx.isDefined(t.text) ? 'prim:' + t.text : 'undefined';
    if (typeof m === 'string') return 'macro:' + m;
    return m;
  }

  /** A whole number from KaTeX's tokens (digits, spaces), or null. */
  function katexNumber(ctx) {
    let s = '';
    let t = katexPop(ctx);
    if (t.text === '-' || t.text === '+') { s = t.text; t = katexPop(ctx); }
    while (/^\d$/.test(t.text)) { s += t.text; t = ctx.popToken(); }
    if (t.text !== ' ') ctx.pushToken(t);
    return /\d/.test(s) ? parseInt(s, 10) : null;
  }

  const katexBranch = (ctx, value) => {
    if (!value) katexSkip(ctx, true);
    return '';
  };

  const CONDITIONAL_MACROS = {
    '\\iftrue': '',
    '\\iffalse': (ctx) => katexBranch(ctx, false),
    '\\else': (ctx) => { katexSkip(ctx, false); return ''; },
    '\\or': (ctx) => { katexSkip(ctx, false); return ''; },
    '\\fi': '',
    '\\ifmmode': '\\iftrue',
    '\\ifinner': '\\iffalse',
    '\\ifvmode': '\\iffalse',
    '\\ifhmode': '\\iffalse',
    '\\ifx': (ctx) => {
      const a = katexPop(ctx);
      const b = katexPop(ctx);
      return katexBranch(ctx, a.text === b.text || katexMeaning(ctx, a) === katexMeaning(ctx, b));
    },
    '\\if': (ctx) => katexBranch(ctx, katexPop(ctx).text === katexPop(ctx).text),
    '\\ifcat': (ctx) => katexBranch(ctx, katexPop(ctx).text === katexPop(ctx).text),
    '\\ifdefined': (ctx) => {
      const t = katexPop(ctx);
      return katexBranch(ctx, katexMeaning(ctx, t) !== 'undefined');
    },
    '\\ifcsname': (ctx) => {
      let name = '';
      for (let t = ctx.popToken(); t.text !== '\\endcsname' && t.text !== 'EOF'; t = ctx.popToken()) name += t.text;
      return katexBranch(ctx, ctx.isDefined('\\' + name.trim()));
    },
    '\\ifnum': (ctx) => {
      const a = katexNumber(ctx);
      const rel = a === null ? null : katexPop(ctx).text;
      const b = rel && /^[<=>]$/.test(rel) ? katexNumber(ctx) : null;
      return katexBranch(ctx, b !== null && (rel === '<' ? a < b : rel === '>' ? a > b : a === b));
    },
    '\\ifodd': (ctx) => {
      const a = katexNumber(ctx);
      return katexBranch(ctx, a !== null && a % 2 !== 0);
    },
    '\\ifcase': (ctx) => {
      let n = katexNumber(ctx) || 0;
      while (n-- > 0) {
        const at = katexSkip(ctx, true);
        if (at !== 'or') break;
      }
      return '';
    },
  };
  for (const n of ['ifdim', 'ifvoid', 'ifhbox', 'ifvbox', 'ifeof', 'iffontchar', 'ifincsname']) {
    CONDITIONAL_MACROS['\\' + n] = (ctx) => katexBranch(ctx, false);
  }

  // Low-level TeX that KaTeX cannot run. A paper that redefines a command
  // KaTeX already has (tcilatex: \def\alpha{{\Greekmath 010B}}, with
  // \mathchar inside) with these keeps KaTeX's own.
  const LOW_LEVEL = /\\(?:mathchar|mathcode|char|count|countdef|setbox|box|wd|ht|dp|advance|multiply|divide|loop|fam|mathgroup|csname|expandafter|futurelet|afterassignment|edef|xdef|aftergroup|uppercase|lowercase|string|number|romannumeral|the|chardef|mathchardef|vbox|vtop)(?![A-Za-z@])/;

  // Scientific WorkPlace's tcilatex builds these integrals with \futurelet; what they draw:
  const LOW_LEVEL_FALLBACK = {};
  for (const [k, v] of Object.entries({ int: '\\int', iint: '\\iint', iiint: '\\iiint', oint: '\\oint' })) {
    LOW_LEVEL_FALLBACK['d' + k] = '\\displaystyle' + v;
    LOW_LEVEL_FALLBACK['t' + k] = '\\textstyle' + v;
  }

  /**
   * A macro built from TeX internals KaTeX cannot run (see LOW_LEVEL). If it
   * redefines a command KaTeX has, KaTeX's own is used, here and in the rest of
   * the paper's formulas: the paper's definition is taken out of the shared
   * table (as a global \let would). Otherwise it is tried as written, since
   * the internals may sit in a branch a conditional skips.
   */
  function lowLevelMacro(key, own) {
    return (ctx) => {
      const mine = ctx.macros.get(key);
      ctx.macros.set(key, undefined, true);
      if (ctx.isDefined(key)) return key;
      ctx.macros.set(key, mine, true);
      if (LOW_LEVEL_FALLBACK[key.slice(1)]) return LOW_LEVEL_FALLBACK[key.slice(1)];
      return typeof own === 'function' ? own(ctx) : own;
    };
  }

  function attachHead(head, content) {
    // Put a run-in heading ("Theorem 1.2.") inside the first paragraph.
    if (content.startsWith('<p>')) return '<p>' + head + content.slice(3);
    return `<p class="thm-head-only">${head}</p>${content}`;
  }

  function unwrapMathShift(src) {
    const tex = src.trim();
    if (tex[0] === '$' && tex.endsWith('$') && findMathEnd(tex, '$', 1) === tex.length - 1) {
      return tex.slice(1, -1);
    }
    return src;
  }

  /**
   * Where $…$ (or $$…$$) that starts at `from` ends: the first unescaped
   * token outside braces, so $x^{\text{$a$}}$ stays one formula. Unbalanced
   * braces fall back to the first unescaped token.
   */
  function findMathEnd(src, token, from) {
    let depth = 0;
    let environments = 0;
    for (let i = from; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        // a table inside the formula has text cells with $…$ of their own: skip it whole
        const table = /^\\begin\{(tabular\*?|minipage)\}/.exec(src.slice(i, i + 20));
        if (table) { i = findEnvEnd(src, i + table[0].length, table[1]).end - 1; continue; }
        if (src.startsWith('\\begin{', i)) environments++;
        else if (src.startsWith('\\end{', i)) environments--;
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { if (--depth < 0) break; }
      else if (depth === 0 && src.startsWith(token, i)) return i;
      // Comment-only lines in a multiline array can leave blank lines.
      else if (c === '\n' && depth === 0 && environments === 0 && token === '$' && /^\n[ \t]*\n/.test(src.slice(i, i + 40))) break;
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

  /** enumitem options as {key: value}; braces around a value are dropped, bare keys map to ''. */
  function listKeys(opt) {
    const keys = {};
    for (const part of splitTop(opt, (src, i) => (src[i] === ',' ? 1 : 0))) {
      const eq = findDelim(part, 0, '=');
      const key = part.slice(0, eq).trim();
      if (!key) continue;
      let val = eq < part.length ? part.slice(eq + 1).trim() : '';
      if (val[0] === '{') {
        const g = readGroup(val, 0);
        if (g.end >= val.length) val = g.content;
      }
      keys[key] = val;
    }
    return keys;
  }

  /** An enumitem label template with its counter commands (\alph* ...) replaced by the value. */
  function fillEnum(template, v) {
    const map = { alph: alpha(v), Alph: alpha(v, true), roman: roman(v), Roman: roman(v, true), arabic: String(v) };
    return template.replace(/\\(alph|Alph|roman|Roman|arabic)\*?(?![A-Za-z])/g, (_, k) => map[k]);
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
    const bare = stripCommentsMap(String(source).replace(/\r\n?/g, '\n'));
    const stripped = expandEnvShorthands(bare.text, bare.map);
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
      // Math definitions for the notation index (src/insight.js) and renderSnippets.
      defs: {
        macros: second.macros, paired: second.paired, triple: second.triple,
        taylorDiagrams: second.taylorDiagrams, diagramArrows: second.diagramArrows,
      },
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
      r.taylorDiagrams = defs.taylorDiagrams === true;
      if (defs.diagramArrows) r.diagramArrows = Object.assign(Object.create(null), defs.diagramArrows);
    }
    return texs.map((t) => r.renderMath(String(t), false));
  }

  /**
   * Draw one formula or picture again with parameter values from the sliders
   * (src/params.js). source is the whole document (its preamble gives the
   * macros); piece is what a .tg-live mark holds: { tex, defs, display, picture };
   * values maps parameter names to numbers. Returns its HTML.
   */
  function renderLive(source, piece, values, options) {
    const opts = Object.assign({}, options || {}, { params: values || {} });
    const bare = stripCommentsMap(String(source).replace(/\r\n?/g, '\n'));
    const src = expandEnvShorthands(bare.text, bare.map).text;
    const r = new Renderer(opts, { labels: Object.create(null), toc: [], cites: Object.create(null) });
    r.liveOnly = true;
    const begin = documentMark(src, 'begin');
    r.setPreamble(begin ? src.slice(0, begin.at) : '');
    r.startParams(src);
    r.inPreamble = true;
    r.flow(r.preamble, false);
    if (piece.defs) r.flow(String(piece.defs), false);
    r.inPreamble = false;
    r.defineParams();
    const tex = String(piece.tex || '');
    if (piece.picture) return r.tikzpicture(tex);
    return r.renderMath(tex, !!piece.display);
  }

  return { render, renderSnippets, renderLive, stripComments, escapeHtml };
});
