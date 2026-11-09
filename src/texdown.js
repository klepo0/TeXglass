/*
 * TeXdown — render LaTeX documents to HTML, the way a Markdown previewer
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
 * Works in the browser (window.TeXdown) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

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

  const NOOPS = new Set([
    'noindent', 'indent', 'centering', 'raggedright', 'raggedleft', 'vfill', 'null', 'relax', 'protect',
    'clearpage', 'cleardoublepage', 'newpage', 'pagebreak', 'nopagebreak', 'smallskip', 'medskip', 'bigskip',
    'frenchspacing', 'nonfrenchspacing', 'sloppy', 'fussy', 'flushbottom', 'raggedbottom', 'maketitle_',
    'makeatletter', 'makeatother', 'normalsize', 'selectfont', 'onecolumn', 'twocolumn', 'mainmatter',
    'frontmatter', 'backmatter', 'printbibliography', 'listoffigures', 'listoftables', 'qedhere', 'xspace',
    'ignorespaces', 'unskip', 'allowbreak', 'break', 'nolinebreak', 'leavevmode', 'displaybreak',
  ]);

  /** Commands whose arguments are dropped entirely. */
  const DROP_ARGS = new Set([
    'usepackage', 'RequirePackage', 'setlength', 'addtolength', 'vspace', 'hspace', 'pagestyle',
    'thispagestyle', 'bibliographystyle', 'bibliography', 'addbibresource', 'input', 'include', 'includeonly',
    'graphicspath', 'hypersetup', 'geometry', 'index', 'nocite', 'addcontentsline', 'markboth', 'markright',
    'pagenumbering', 'linespread', 'colorlet', 'definecolor', 'crefname', 'Crefname', 'creflabelformat',
    'allowdisplaybreaks', 'captionsetup', 'lstset', 'newtheoremstyle', 'setcounter_', 'phantom', 'hphantom',
    'vphantom', 'newlength', 'settowidth', 'tikzset', 'pgfplotsset', 'setlist', 'renewenvironment_',
    'DeclareGraphicsExtensions', 'urlstyle', 'keywords', 'subjclass', 'address', 'email', 'curraddr',
    'dedicatory', 'translator', 'setcopyright', 'raisebox_', 'enlargethispage', 'looseness', 'spacing',
  ]);

  const TEXT_STYLES = {
    textbf: ['strong'], textit: ['em', 'it'], emph: ['em'], textsl: ['em', 'sl'], texttt: ['code'],
    textsc: ['span', 'sc'], underline: ['u'], uline: ['u'], textrm: ['span'], textsf: ['span', 'sf'],
    textup: ['span'], textnormal: ['span'], textmd: ['span'], mbox: ['span'], hbox: ['span'], text: ['span'],
    textsuperscript: ['sup'], textsubscript: ['sub'], textcolor_: ['span'], fbox: ['span', 'fbox'],
    framebox: ['span', 'fbox'], makebox: ['span'], textup_: ['span'], sout: ['s'], st: ['s'],
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
      this.listDepth = 0;
      this.floatKind = null;
      this.meta = { title: null, author: null, date: null };
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
      const parts = keys.split(',').map((k) => k.trim()).filter(Boolean);
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
      tex = this.mathRefs(tex).replace(/\\(qedhere|nonumber|notag)\b/g, '').replace(/\\label\s*\{[^}]*\}/g, '');
      try {
        return this.renderMathFn(tex, display, this.katexMacros());
      } catch (e) {
        return `<span class="math-error" title="${escapeHtml(e.message || e)}">${escapeHtml(tex)}</span>`;
      }
    }

    katexMacros() {
      if (!this._katexMacros) {
        const m = {};
        for (const name in this.macros) m['\\' + name] = this.macros[name].body;
        this._katexMacros = m;
      }
      return Object.assign({}, this._katexMacros);
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
      if (/\\chapter\b/.test(src)) {
        this.topLevel = 'chapter';
        this.counters.section.parent = 'chapter';
      }
      this.flow(pre, false); // preamble: definitions only, output discarded
      this.trackDepth = this.depth + 1;
      this.trackBase = bodyStart;
      this.trackText = src;
      let html = this.flow(body, false);
      this.trackDepth = -1;
      if (this.footnotes.length) {
        html +=
          '\n<section class="footnotes"><ol>' +
          this.footnotes.map((f, k) => `<li id="fn-${k + 1}">${f} <a class="fn-back" href="#fnref-${k + 1}">↩</a></li>`).join('') +
          '</ol></section>';
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
        paraStart = -1;
      };
      const emit = (r, pos) => {
        if (r.parbreak) {
          if (inline) para += ' ';
          else flush(pos);
        }
        if (!r.html) return;
        if (r.block && !inline) {
          flush(pos);
          out.push(r.html);
          if (track) spans[out.length - 1] = [pos, r.end];
        } else para += r.html;
      };
      const space = () => {
        if (para && !para.endsWith(' ')) para += ' ';
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
            para += this.flow(g.content, true);
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
            const end = findUnescaped(src, display ? '$$' : '$', start);
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
            para += r.html;
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
        return out.map((html, k) => (spans[k] ? this.wrapSpan(html, spans[k]) : html)).join('\n');
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
      return `<span class="math math-inline">${this.renderMath(tex, false)}</span>`;
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
        const [tag, cls] = TEXT_STYLES[name];
        return res(`<${tag}${cls ? ` class="${cls}"` : ''}>${this.flow(a.content, true)}</${tag}>`, a.end);
      }
      if (name in DECLARATIONS) {
        const [tag, cls] = DECLARATIONS[name];
        const tagName = inline || tag !== 'span' ? tag : 'div';
        const body = this.flow(src.slice(i), inline);
        const html = `<${tagName}${cls ? ` class="${cls}"` : ''}>${body}</${tagName}>`;
        return res(html, src.length, { block: !inline });
      }
      if (name === 'textcolor' || name === 'colorbox') {
        const col = readArg(src, readOpt(src, i) ? readOpt(src, i).end : i);
        const a = readArg(src, col.end);
        return res(`<span>${this.flow(a.content, true)}</span>`, a.end);
      }
      if (name === 'color') return res('', readArg(src, i).end);

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
          return res(`<a href="${escapeHtml(safeUrl(a.content))}">${escapeHtml(a.content)}</a>`, a.end);
        }
        case 'href': {
          const u = readArg(src, i);
          const t = readArg(src, u.end);
          return res(`<a href="${escapeHtml(safeUrl(u.content))}">${this.flow(t.content, true)}</a>`, t.end);
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
          this.meta[name] = a.content;
          return res('', a.end);
        }
        case 'maketitle':
          return res(this.titleBlock(), i, { block: true });
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
          const html = resolved
            ? `<img class="graphic" src="${escapeHtml(resolved)}" alt="${escapeHtml(a.content)}">`
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
          const params = /^(?:#\d)*/.exec(src.slice(j))[0];
          j += params.length;
          const body = readArg(src, j);
          this.macros[nm.content.replace(/^\\/, '')] = { nargs: params.length / 2, def: null, body: body.content };
          this._katexMacros = null;
          return res('', body.end);
        }
        case 'let': {
          const m = /^\s*\\([A-Za-z@]+)\s*=?\s*(\\[A-Za-z@]+|.)/.exec(src.slice(i));
          if (!m) return res('', i);
          this.macros[m[1]] = { nargs: 0, def: null, body: m[2] };
          this._katexMacros = null;
          return res('', i + m[0].length);
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
      for (let k = 0; k < m.nargs; k++) {
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
      const body = m.body.replace(/#(\d)/g, (_, d) => (args[d - 1] !== undefined ? args[d - 1] : ''));
      // Math-only macros (\R -> \mathbb{R}) are sometimes used in text; TeX
      // would complain, we just render them as math.
      if (/^\\(math|operatorname|mathbb|mathcal|mathfrak|mathrm|mathsf|mathscr|boldsymbol|bm)\b/.test(body.trim())) {
        return { html: this.inlineMath(body), end: j };
      }
      return { html: this.flow(body, true), end: j };
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
        case 'abstract':
          return `<div class="abstract"><div class="abstract-title">Abstract</div>${this.flow(body, false)}</div>`;
        case 'itemize': case 'enumerate': case 'description': case 'compactitem': case 'compactenum':
        case 'inparaenum': case 'asparaenum':
          return this.list(name, body);
        case 'thebibliography':
          return this.bibliography(body);
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
        case 'tikzpicture': case 'tikzcd': case 'picture': case 'pgfpicture': case 'axis':
          if (name === 'tikzcd') return this.displayMath('displaymath', `\\begin{CD}\\text{[tikzcd diagram]}\\end{CD}`);
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
        const out = rows.map((row, k) => {
          if (!row.trim() && k === rows.length - 1) return null;
          if (base === 'eqnarray') {
            // a & = & b  ->  a &= {} b
            const cells = splitTop(row, cellSep);
            if (cells.length >= 3) row = `${cells[0]} &${cells[1]}{} ${cells.slice(2).join(' ')}`;
          }
          const r = this.numberRow(row, !starred, id);
          return r.tex + r.tag;
        }).filter((r) => r !== null);
        const env = base === 'gather' ? 'gather*' : base === 'alignat' ? 'alignat*' : 'align*';
        tex = `\\begin{${env}}${lead}${out.join(' \\\\ ')}\\end{${env}}`;
      }
      return `<div class="math math-display" id="${id}">${this.renderMath(tex, true)}</div>`;
    }

    /** Number one equation row, registering its labels. */
    numberRow(row, numbered, id) {
      const labels = [];
      row = row.replace(/\\label\s*\{([^}]*)\}/g, (_, l) => { labels.push(l); return ''; });
      if (/\\(nonumber|notag)\b/.test(row)) {
        numbered = false;
        row = row.replace(/\\(nonumber|notag)\b/g, '');
      }
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
   * Returns { html, title, labels, toc, warnings }.
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
      title: second.meta.title ? stripTags(second.flow(second.meta.title, true)).trim() : null,
      labels: second.labels,
      toc: second.toc,
      warnings,
      unknownCommands: Array.from(new Set(first.warnings.filter((w) => /^Unknown command/.test(w)).map((w) => w.slice(16, -1)))),
    };
  }

  return { render, stripComments, escapeHtml };
});
