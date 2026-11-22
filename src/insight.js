/*
 * Reading aids built from the rendered page, in the web viewer and the VS Code
 * preview:
 *
 *   - notation on hover: resting the pointer on a formula shows where its
 *     notation comes from (the paper's own macros, symbols defined with :=, and
 *     symbols the text introduces in words: "let X be", "denote by X", "where X is");
 *   - a dependency map: which results each theorem's statement and proof refer to;
 *   - a notation index: the paper's macros and defined symbols, with first uses,
 *     arranged by section, by kind or A–Z, searchable by symbol or meaning, with
 *     the symbols of the section being read at the top (side panel);
 *   - "What does this use?": a button by each result's heading lights up the
 *     results it rests on (or that rest on it) in the text and fades the rest.
 *     While it is on, a map on show (side panel or larger map) lights up the
 *     same results, and picking a result on the map moves the light to it.
 *
 * None of this runs while a document renders. Everything is read from the
 * page the first time it is needed, kept until the page changes
 * (invalidate()), and read again on the next use.
 *
 *   const insight = TeXglassInsight.attach({
 *     root: preview,                       // the rendered document
 *     jump(el) { ... },                    // show an element of the page
 *     renderTex(texs) { ... },             // optional: Promise of HTML for small formulas
 *     hover: true,                         // notation on hover
 *     onHoverChange(on) { ... },           // the panel's checkbox changed it
 *     notationOrder: 'section',            // how the index is arranged: 'section' | 'kind' | 'az'
 *     onNotationOrder(order) { ... },      // the reader picked another arrangement (to keep it)
 *     statusOf(el) { ... },                // optional: reading progress { s, q } (src/progress.js)
 *     print() { ... },                     // optional: a Print button on the "What does this use?" bar
 *     onFocusStart() { ... },              // optional: "What does this use?" starts lighting up
 *   });
 *   insight.setDefinitions(result.defs);   // after each render: the paper's macros
 *   insight.invalidate();                  // after the page changed
 *   insight.open('notation' | 'deps');     // the panel
 *   insight.setNotationOrder('kind');      // arrange the notation index
 *   insight.toggleMap();                   // open or close the larger map (also the M key)
 *   insight.usedByNote(target);            // "Used in …" for the reference popover, or null
 *   insight.focus(theoremEl, 'uses' | 'usedBy' | 'both', { scroll, collapse }); insight.unfocus();
 *   insight.repaint();                     // reading statuses changed: recolour the maps
 */
(function (root) {
  'use strict';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------------------------------------------------------------------
  // Reading the page
  // ---------------------------------------------------------------------------

  const INSIDE_POPOVER = '.ref-popover, .insight-popover, .insight-dialog, .diff-old';

  /** The formulas of the page, in document order (not the copies inside popovers). */
  function formulas(doc) {
    return Array.from(doc.querySelectorAll('.math[data-tex]')).filter((el) => !el.closest(INSIDE_POPOVER));
  }

  /** Command names (without the backslash) a formula's source uses. */
  function commandsIn(tex) {
    const out = new Set();
    const re = /\\([A-Za-z@]+)/g;
    let m;
    while ((m = re.exec(tex))) out.add(m[1]);
    return out;
  }

  const DEF_OPS = /:=|\\coloneqq|\\coloneq|\\eqqcolon|=:|\\triangleq|\\stackrel\s*\{\s*(?:\\text\s*\{\s*def\s*\}|\\mathrm\s*\{\s*def\s*\}|def)\s*\}\s*\{?=\}?|\\overset\s*\{\s*(?:\\text\s*\{\s*def\s*\}|\\mathrm\s*\{\s*def\s*\}|def)\s*\}\s*\{?=\}?/;

  /** Where a top-level piece of a formula ends before i (separators: , ; & \\ \quad and the like). */
  function pieceStart(tex, i) {
    let depth = 0;
    for (let k = i - 1; k >= 0; k--) {
      const c = tex[k];
      if (c === '}' || c === ')' || c === ']') depth++;
      else if (c === '{' || c === '(' || c === '[') {
        if (depth === 0) return k + 1;
        depth--;
      } else if (depth === 0) {
        if (c === ',' || c === ';' || c === '&') return k + 1;
        if (c === '\\' && tex[k + 1] === '\\') return k + 2;
        const w = /^\\(quad|qquad|text|mbox|forall|for|where|and)\b/.exec(tex.slice(k));
        if (w && c === '\\') return k + w[0].length;
      }
    }
    return 0;
  }

  function pieceEnd(tex, i) {
    let depth = 0;
    for (let k = i; k < tex.length; k++) {
      const c = tex[k];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        if (depth === 0) return k;
        depth--;
      } else if (depth === 0) {
        if (c === ',' || c === ';' || c === '&' || c === '=') return k;
        if (c === '\\' && /^\\(\\|quad|qquad|text|mbox)/.test(tex.slice(k))) return k;
      }
    }
    return tex.length;
  }

  /** Strip a formula piece to the notation it names: no spacing or \left/\right, braces balanced. */
  function cleanSymbol(s) {
    s = s.replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, '').replace(/\\[,;:! ]/g, '').replace(/~/g, ' ').trim();
    let depth = 0;
    for (const c of s) {
      if (c === '{') depth++;
      else if (c === '}' && --depth < 0) return '';
    }
    return depth === 0 ? s : '';
  }



  /**
   * The symbol a formula defines, as in "A := B", "B =: A" or "A \coloneqq B",
   * or null.
   */
  function definedSymbol(tex) {
    const m = DEF_OPS.exec(tex);
    if (!m) return null;
    const reversed = m[0] === '=:' || /eqqcolon/.test(m[0]);
    const s = reversed ? cleanSymbol(tex.slice(m.index + m[0].length, pieceEnd(tex, m.index + m[0].length))) : cleanSymbol(tex.slice(pieceStart(tex, m.index), m.index));
    if (!s || s.length > 60 || /[=<>]|\\(le|ge|leq|geq|in|subset|to)\b/.test(s)) return null;
    return s;
  }

  // ---------------------------------------------------------------------------
  // Symbols the text introduces: "let X be", "denote by X", "where X is"
  // ---------------------------------------------------------------------------

  const SKIP_TOKENS = /^\\(left|right|[bB]ig+[lr]?|middle|displaystyle|textstyle|scriptstyle|limits|nolimits|[,;:! ]|quad|qquad|thinspace|medspace|thickspace|enspace|nonumber|notag)$/;
  // commands whose braced argument is words, not symbols: kept whole as one token
  const WORD_ARGS = /^\\(text[a-z]*|mbox|hbox|operatorname\*?|mathrm|label|tag|begin|end|eqref|ref)$/;
  // commands that make a different symbol out of the one they decorate
  const DECOR = /^\\(math[a-z]+|bm|boldsymbol|pmb|hat|widehat|tilde|widetilde|bar|overline|underline|vec|overrightarrow|dot|ddot|check|breve|acute|grave|mathring|Bbb|frak|cal|scr|bf|it|sf|rm)$/;

  /** A formula's TeX as tokens: spacing dropped, braces around a single token removed. */
  function texTokens(tex) {
    const raw = String(tex).match(/\\[A-Za-z@]+\*?|\\.|\S/g) || [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (SKIP_TOKENS.test(t)) continue;
      if (WORD_ARGS.test(t) && raw[i + 1] === '{') {
        let depth = 0;
        let j = i + 1;
        for (; j < raw.length; j++) {
          if (raw[j] === '{') depth++;
          else if (raw[j] === '}' && --depth === 0) break;
        }
        out.push(raw.slice(i, j + 1).join(''));
        i = j;
        continue;
      }
      out.push(t);
    }
    // {x} -> x, repeatedly ({{x}} too)
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i + 2 < out.length; i++) {
        if (out[i] === '{' && out[i + 2] === '}' && out[i + 1] !== '{' && out[i + 1] !== '}') {
          out.splice(i, 3, out[i + 1]);
          changed = true;
        }
      }
    }
    return out;
  }

  const SLOT = { slot: true }; // stands for any argument
  const ANY = { any: true }; // stands for any index

  /**
   * What to look for when a symbol is used later, as tokens: "\Phi(x)" is looked
   * for as \Phi; "X_t" as X_ with any index, since X_s is the same process; and a
   * small letter inside delimiters is an argument, so \|u\|_{H^1} also matches
   * \|f + g\|_{H^1}.
   */
  function patternOf(sym) {
    let t = texTokens(sym);
    // drop an argument list of letters: f(x), \Phi(x, y)
    const open = t.indexOf('(');
    if (open > 0 && t[t.length - 1] === ')' && t.slice(open + 1, -1).every((x) => /^[a-z,]$|^\\[a-z]+$/.test(x))) t = t.slice(0, open);
    t = t.slice();
    // a single-letter index is a variable: X_t also matches X_s and X_{t+1}
    if (t.length >= 3 && t[t.length - 2] === '_' && /^[a-z]$/.test(t[t.length - 1])) t[t.length - 1] = ANY;
    // one small letter between other tokens, not an index or a power: an argument
    const small = t.map((x, k) => (typeof x === 'string' && /^[a-z]$/.test(x) && k > 0 && k < t.length - 1 && t[k - 1] !== '_' && t[k - 1] !== '^' ? k : -1)).filter((k) => k >= 0);
    if (small.length === 1 && t.filter((x) => typeof x === 'string').length >= 3) t[small[0]] = SLOT;
    return { toks: t };
  }

  /** The end of one argument starting at f[i]: a token, or a braced group. */
  function argEnd(f, i) {
    if (f[i] !== '{') return i + 1;
    let depth = 0;
    for (let k = i; k < f.length; k++) {
      if (f[k] === '{') depth++;
      else if (f[k] === '}' && --depth === 0) return k + 1;
    }
    return -1;
  }

  /** Where pattern toks (from k on) matches f from i: the end, or -1. */
  function matchFrom(f, i, toks, k) {
    for (; k < toks.length; k++) {
      const p = toks[k];
      if (p === ANY) {
        if (i >= f.length || /^[)\]},;=]$/.test(f[i])) return -1;
        i = argEnd(f, i);
        if (i < 0) return -1;
      } else if (p === SLOT) {
        // one argument or more, up to the rest of the pattern, braces balanced
        let j = i;
        for (let n = 0; n < 24 && j >= 0 && j < f.length; n++) {
          j = argEnd(f, j);
          if (j < 0) return -1;
          const e = matchFrom(f, j, toks, k + 1);
          if (e >= 0) return e;
        }
        return -1;
      } else {
        if (f[i] !== p) return -1;
        i++;
      }
    }
    return i;
  }

  /** Where symbol pattern p occurs in token list f: [start, end) pairs. */
  function occurrences(f, p) {
    const out = [];
    if (!p.toks.length || typeof p.toks[0] !== 'string') return out;
    for (let i = 0; i < f.length; i++) {
      if (f[i] !== p.toks[0]) continue;
      const end = matchFrom(f, i, p.toks, 0);
      if (end < 0) continue;
      // not when it is the argument of \mathcal, \hat and the like: \mathcal X is another symbol
      let j = i - 1;
      while (j >= 0 && f[j] === '{') j--;
      if (j >= 0 && DECOR.test(f[j])) continue;
      out.push([i, end]);
      i = end - 1;
    }
    return out;
  }

  const RELATIONS = /^(=|<|>|:|\\in|\\subset|\\subseteq|\\subsetneq|\\colon|\\le|\\leq|\\ge|\\geq|\\leqslant|\\geqslant|\\sim|\\equiv|\\coloneqq|\\coloneq|\\eqqcolon|\\to|\\mapsto|\\ni|\\notin|\\neq|\\ne|\\approx|\\simeq|\\cong|\\supset|\\supseteq|\\triangleq|\\defeq|\\stackrel|\\overset|\\sqsubset|\\prec|\\succ)$/;

  /**
   * The symbols on the left of a formula that a sentence introduces:
   * "X" from "X = …", "x, y" from "x, y \in X", "X_t" from "(X_t)_{t \ge 0}".
   * Returns { syms, rel } where rel is the first relation ('' if none).
   */
  function leftSymbols(tex) {
    // a displayed environment: its first row
    const s = String(tex).trim().replace(/^\\begin\s*\{[A-Za-z*]+\}(\s*\{[^{}]*\})*/, '').replace(/[.,;]\s*$/, '');
    let depth = 0;
    let cut = s.length;
    let rel = '';
    const re = /\\[A-Za-z@]+\*?|\\.|:=|[^\s]/g;
    let m;
    while ((m = re.exec(s))) {
      const t = m[0];
      if (t === '{' || t === '(' || t === '[' || t === '\\{' || t === '\\langle') depth++;
      else if (t === '}' || t === ')' || t === ']' || t === '\\}' || t === '\\rangle') depth--;
      else if (depth === 0 && (t === ':=' || t === '&' || t === '\\\\' || RELATIONS.test(t))) {
        cut = m.index;
        rel = t;
        break;
      }
    }
    const lhs = s.slice(0, cut);
    const pieces = [];
    depth = 0;
    let from = 0;
    for (let i = 0; i < lhs.length; i++) {
      const c = lhs[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) { pieces.push(lhs.slice(from, i)); from = i + 1; }
    }
    pieces.push(lhs.slice(from));
    const syms = [];
    for (let p of pieces) {
      p = cleanSymbol(p);
      // a family (X_t)_{t \ge 0} names X_t
      const fam = /^\((.+)\)\s*_\s*(\{.*\}|\\?[A-Za-z0-9])$/.exec(p);
      if (fam) p = cleanSymbol(fam[1]);
      // a pair (\gamma, \eta) names both
      const pair = /^\((.+)\)$/.exec(p);
      if (pair && pair[1].includes(',')) {
        const inner = leftSymbols(pair[1]).syms;
        syms.push(...inner);
        continue;
      }
      if (!p || p.length > 40) continue;
      const toks = texTokens(p);
      // an expression, not a name: X + Y, 2, \sum ..., a sentence in \text
      if (!toks.length || toks.length > 10) continue;
      if (toks.some((t) => /^[+\-*/=|]$|^\\(cdot|times|sum|int|prod|frac|sqrt|lim|sup|inf|max|min|circ|otimes|oplus|cup|cap|setminus|wedge|vee|ldots|dots|cdots|infty)$/.test(t) || /^\\(text|mbox|operatorname)/.test(t))) continue;
      if (/^[0-9.]+$/.test(toks.join(''))) continue;
      if (!toks.some((t) => /[A-Za-z]/.test(t))) continue;
      if (STANDARD.test(toks.join(''))) continue;
      syms.push(p);
    }
    return { syms, rel };
  }

  // symbols every paper uses the same way: "we write \partial for …" must not tag every derivative
  const STANDARD = /^(\\(partial|nabla|infty|emptyset|varnothing|ell|hbar|imath|jmath|Re|Im|forall|exists|cdot|dots|ldots)|\\mathbb[A-Z]|\\mathbb\{[A-Z]\}|[deio])$/;

  /** One plain letter (x, A, \mu): the kind of symbol papers reuse for anything. */
  const isLetter = (sym) => {
    const t = texTokens(sym);
    return t.length === 1 && /^[A-Za-z]$|^\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|ell)$/.test(t[0]);
  };
  const isLatinLetter = (sym) => /^[A-Za-z]$/.test(texTokens(sym).join(''));
  const isSmallLatin = (sym) => /^[a-z]$/.test(texTokens(sym).join(''));

  /*
   * How strongly a phrase introduces the symbol next to it:
   *   'strong'  "denote by X", "X denotes", "we write X for", "set X = …", "define X …"
   *   'let'     "let X be …", "let X = …"
   *   'weak'    "where X is …", "called X"
   * A plain small letter (x, n, t) counts only when the phrase is strong, and a
   * single Latin letter (x, C) not when it is weak: papers reuse those for anything.
   */
  const ABBREV = /(?:\b(?:e\.g|i\.e|cf|resp|etc|vs|viz|fig|figs|eq|eqs|thm|lem|prop|cor|def|sec|ch|no|ref|refs|al|approx|esp|resp)|\b[A-Z])\.$/i;

  function cueOf(before, after, tex) {
    const b = before.replace(/\s+/g, ' ').toLowerCase().replace(/[\s(]+$/, '');
    const a = after.replace(/\s+/g, ' ').toLowerCase().replace(/^[\s)]+/, '');
    const { syms, rel } = leftSymbols(tex);
    if (!syms.length) return null;
    const hasEq = rel === '=' || rel === ':=' || /^\\(coloneqq|coloneq|triangleq|defeq|stackrel|overset)$/.test(rel);
    const ifNext = /^(if|iff|when|whenever|provided|in case)\b/.test(a);
    let tier = null;
    if (/\b(denote|denoted|denotes|denoting)\s+by$|\b(is|are|be|will be|shall be)\s+(denoted|written|abbreviated)(\s+by)?$|\bdenote it by$|\bnotation$/.test(b)) tier = 'strong';
    else if (/\b(we|i|let us|one can|and|then|to|now|also|shall|will|first|here|finally|simply)\s+(write|use|define|introduce)$|^(write|define|introduce)$|[.,;:]\s*(write|define)$/.test(b) && !ifNext) tier = 'strong';
    else if (/(^|\b(we|and|now|then|also|first|here|finally|let us|us|to)\s+|[.,;:]\s*)(set|put)$/.test(b) && hasEq) tier = 'strong';
    else if (/^(denotes|denote|will denote|shall denote|stands for|stand for|will stand for|is defined|are defined|is given by|is shorthand|is short for|is an abbreviation)\b/.test(a) && !/\b(if|whether|that|since|because)$/.test(b)) tier = 'strong';
    else if (/(^|[^a-z])let$/.test(b)) tier = hasEq ? 'strong' : 'let';
    else if (/(^|[^a-z])(where|here|with)$/.test(b) && (/^(denotes|denote|stands for|stand for)\b/.test(a))) tier = 'strong';
    else if (/(^|[^a-z])(where|here)$/.test(b) && !/\b(case|cases|situation|setting|regime|one|those|ones|points?|times?)\s+where$/.test(b) && (/^(is|are)\s+(the|a|an|some|our|given|defined|fixed)\b/.test(a) || hasEq)) tier = 'weak';
    else if (/\b(which|that) we (call|denote)$|\b(we|and) call$|\b(called|named|denoted)$/.test(b) && !/^-/.test(a)) tier = 'weak';
    if (!tier) return null;
    const keep = syms.filter((s) => (tier === 'strong' ? true : tier === 'let' ? !isSmallLatin(s) : !isLatinLetter(s)));
    return keep.length ? { tier, syms: keep } : null;
  }

  /**
   * The symbols a run of text introduces. parts: text strings and { tex } for
   * the formulas in it, in reading order. Returns [{ at, tier, syms }] with at
   * the index of the formula in parts.
   */
  function proseDefinitions(parts) {
    const out = [];
    let lastTier = null; // "let X, Y and Z be": the cue carries over a list
    const fits = (tier, s) => (tier === 'strong' ? true : tier === 'let' ? !isSmallLatin(s) : !isLatinLetter(s));
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || typeof p !== 'object' || p.tex == null) continue;
      const before = typeof parts[i - 1] === 'string' ? parts[i - 1] : '';
      const after = typeof parts[i + 1] === 'string' ? parts[i + 1] : '';
      const tier0 = lastTier;
      lastTier = null;
      if (definedSymbol(p.tex)) continue; // := says it already
      let cue = cueOf(before.slice(-80), after.slice(0, 80), p.tex);
      if (!cue && tier0 && /^\s*(,|,?\s*and|,?\s*or)?\s*$/i.test(before)) {
        const keep = leftSymbols(p.tex).syms.filter((s) => fits(tier0, s));
        if (keep.length) cue = { tier: tier0, syms: keep };
      }
      if (cue) out.push({ at: i, tier: cue.tier, syms: cue.syms });
      lastTier = cue ? cue.tier : /(^|[^a-z])let\s*$/i.test(before) ? 'let' : (tier0 && /^\s*(,|,?\s*and|,?\s*or)?\s*$/i.test(before) ? tier0 : null);
    }
    return out;
  }

  // Parts of a paragraph that are not its running text.
  const NOT_TEXT = '.thm-head, .proof-head, .item-label, sup.fn, .footnote, .footnotes, .tg-margin, .marginnote, .uses-btn, script, style, .katex-mathml';
  const HARD = '\u0001'; // a paragraph break: no sentence runs across it
  const MATH = ''; // a formula, in the flat text of a run

  /**
   * The runs of running text on the page: paragraphs and the displayed formulas
   * between them, in order, each as { items, text } where items are
   * { node, at } (text nodes), { math, at } (formulas) or { gap, at }, and text is
   * the run flattened (a formula as one character).
   */
  function textRuns(doc) {
    const containers = new Set();
    doc.querySelectorAll('p, .math-display[data-tex]').forEach((el) => {
      if (el.parentElement && !el.closest(INSIDE_POPOVER) && !el.parentElement.closest('.math, .katex')) containers.add(el.parentElement);
    });
    const runs = [];
    for (const box of containers) {
      let run = null;
      const flush = () => { if (run && run.items.some((x) => x.math)) runs.push(run); run = null; };
      for (const child of box.children) {
        const isP = child.tagName === 'P';
        const isMath = child.matches('.math-display[data-tex]');
        if (!isP && !isMath) { flush(); continue; }
        if (!run) run = { items: [], text: '' };
        const add = (item, s) => { item.at = run.text.length; run.items.push(item); run.text += s; };
        if (isMath) { add({ math: child }, MATH); continue; }
        if (run.text) add({ gap: true }, run.items.length && run.items[run.items.length - 1].math ? ' ' : HARD);
        const walk = (n) => {
          for (const c of n.childNodes) {
            if (c.nodeType === 3) add({ node: c }, c.nodeValue);
            else if (c.nodeType === 1) {
              if (c.matches('.math[data-tex]')) add({ math: c }, MATH);
              else if (!c.matches(NOT_TEXT)) walk(c);
            }
          }
        };
        walk(child);
      }
      flush();
    }
    return runs;
  }

  /** [start, end) of the sentence around position i of a run's flat text. */
  function sentenceAround(text, i) {
    const ends = (k) => {
      const c = text[k];
      if (c === HARD) return true;
      if (c !== '.' && c !== '?' && c !== '!') return false;
      if (k + 1 < text.length && !/\s/.test(text[k + 1])) return false;
      return !ABBREV.test(text.slice(Math.max(0, k - 6), k + 1));
    };
    let s = i;
    while (s > 0 && !ends(s - 1)) s--;
    while (s < i && /\s/.test(text[s])) s++;
    let e = i + 1;
    while (e < text.length && !ends(e)) e++;
    if (e < text.length && text[e] !== HARD) e++;
    return [s, e];
  }

  /** A copy of part of a run, [s, e) of its flat text, with the formula `mark` marked. */
  function copyRange(run, s, e, marks) {
    const owner = marks[0].ownerDocument;
    const boundary = (pos) => {
      for (const it of run.items) {
        if (it.node && it.at <= pos && pos <= it.at + it.node.nodeValue.length) return [it.node, pos - it.at];
        if (it.math && it.at === pos) return ['before', it.math];
        if (it.math && it.at + 1 === pos) return ['after', it.math];
      }
      return null;
    };
    const a = boundary(s);
    const b = boundary(e);
    if (!a || !b) return null;
    const range = owner.createRange();
    try {
      if (a[0] === 'before') range.setStartBefore(a[1]); else if (a[0] === 'after') range.setStartAfter(a[1]); else range.setStart(a[0], a[1]);
      if (b[0] === 'before') range.setEndBefore(b[1]); else if (b[0] === 'after') range.setEndAfter(b[1]); else range.setEnd(b[0], b[1]);
    } catch (err) { return null; }
    marks.forEach((m) => m.setAttribute('data-insight-def', ''));
    const frag = range.cloneContents();
    marks.forEach((m) => m.removeAttribute('data-insight-def'));
    const box = owner.createElement('div');
    box.className = 'insight-sentence';
    box.appendChild(frag);
    box.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
    box.querySelectorAll(NOT_TEXT.replace(', .katex-mathml', '')).forEach((x) => x.remove());
    box.querySelectorAll('[data-insight-def]').forEach((x) => { x.removeAttribute('data-insight-def'); x.classList.add('insight-defined'); });
    return box;
  }

  /** The words of the sentence that introduces a symbol, for filtering. */
  function sentenceText(d) {
    const [a, b] = sentenceAround(d.run.text, d.at);
    return d.run.text.slice(a, b).replace(/[\uE000\u0001]/g, ' ');
  }

  /** The sentence that introduces a symbol, as a copy to show (clipped when long), marking `marks` (default: its formula). */
  function sentenceOf(d, marks) {
    const text = d.run.text;
    let [s, e] = sentenceAround(text, d.at);
    let pre = false;
    let post = false;
    if (e - s > 360) {
      if (d.at - s > 160) { s = text.indexOf(' ', d.at - 160) + 1 || s; pre = true; }
      if (e - d.at > 200) { const k = text.lastIndexOf(' ', d.at + 200); if (k > d.at) { e = k; post = true; } }
    }
    const box = copyRange(d.run, s, e, marks || [d.el]);
    if (!box) return null;
    if (pre) box.insertBefore(box.ownerDocument.createTextNode('… '), box.firstChild);
    if (post) box.appendChild(box.ownerDocument.createTextNode(' …'));
    return box;
  }

  /** Where a definition holds: { within, until } (an element it stays inside, the heading it stops at). */
  function scopeOf(el, sym, heads) {
    const single = isLetter(sym);
    const proof = el.closest('.proof');
    if (proof) return { within: proof, until: null };
    const thm = el.closest('.theorem');
    // inside a theorem's statement a plain letter is the theorem's own; a definition's is the paper's
    if (thm && single && !/^(definition|notation|convention|assumption|assumptions|setting|setup|hypothesis|standing)/i.test(thmName(thm))) return { within: thm, until: null };
    if (!isSmallLatin(sym)) return { within: null, until: null }; // until the paper says otherwise
    // a small letter (x, n, t) holds until the next heading of its section's level or above
    let level = 9;
    let until = null;
    for (const h of heads) {
      const before = !!(h.compareDocumentPosition(el) & 4);
      if (before) level = Number(h.tagName[1]) || level;
      else if ((Number(h.tagName[1]) || 9) <= level) { until = h; break; }
    }
    return { within: null, until };
  }

  /** The symbols the text introduces, as index entries, in document order. */
  function textDefinitions(doc) {
    const heads = Array.from(doc.querySelectorAll('h1, h2, h3, h4')).filter((h) => !h.closest(INSIDE_POPOVER));
    const out = [];
    for (const run of textRuns(doc)) {
      // the parts proseDefinitions reads: text between formulas, and the formulas
      const parts = [];
      const maths = [];
      let text = '';
      for (const it of run.items) {
        if (it.math) {
          parts.push(text, { tex: it.math.dataset.tex || '', display: it.math.classList.contains('math-display') });
          maths.push(it);
          text = '';
        } else text += it.node ? it.node.nodeValue : ' ';
      }
      parts.push(text);
      for (const d of proseDefinitions(parts)) {
        const it = maths[(d.at - 1) / 2];
        for (const tex of d.syms) {
          out.push({ tex, key: texTokens(tex).join(' '), el: it.math, run, at: it.at, tier: d.tier, text: true, scope: scopeOf(it.math, tex, heads), pat: patternOf(tex) });
        }
      }
    }
    return out;
  }

  /** The name a theorem-like block goes by on the page: "Lemma 2.3". */
  function thmName(el) {
    const n = el.querySelector(':scope > .thm-head .thm-name, :scope > p > .thm-head .thm-name, :scope > .thm-head-only .thm-name, .thm-name');
    return n ? n.textContent.trim() : 'Result';
  }

  function thmNote(el) {
    const n = el.querySelector('.thm-note');
    return n && n.closest('.theorem') === el ? n.textContent.trim().replace(/^\(|\)$/g, '') : '';
  }

  const kindOf = (el) => {
    const m = /\bthm-env-([\w-]+)/.exec(el.className);
    return m ? m[1] : 'theorem';
  };

  function styleOf(el) {
    if (el.classList.contains('thm-definition')) return 'definition';
    if (el.classList.contains('thm-remark')) return 'remark';
    return 'plain';
  }

  /** The page element a reference link points to. */
  function targetOf(a, doc) {
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('#')) return null;
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* keep it */ }
    return (doc.ownerDocument || doc).getElementById(id);
  }

  // --- mentions without a link: "Lemma 2.3" typed by hand, "the previous lemma" ---

  // Short forms of the words that name results.
  const ABBR = {
    thm: 'theorem', thms: 'theorem', th: 'theorem', lem: 'lemma', lemm: 'lemma', lemmata: 'lemma', prop: 'proposition', props: 'proposition',
    cor: 'corollary', coro: 'corollary', cors: 'corollary', def: 'definition', defn: 'definition', defs: 'definition', rem: 'remark', rmk: 'remark',
    conj: 'conjecture', ass: 'assumption', assump: 'assumption', hyp: 'hypothesis', hypotheses: 'hypothesis', ex: 'example', exa: 'example',
    obs: 'observation', cl: 'claim', eq: null, eqn: null, eqs: null, sec: null, fig: null, ch: null, chap: null, app: null,
  };

  /** The word a result's name starts with, in lower case: "lemma" for "Lemma 2.3". */
  const wordOf = (name) => (/^[A-Za-zÀ-ÿ]+/.exec(name) || [''])[0].toLowerCase();

  /** Does a word typed in the text ("Lemmas", "Prop.", "thm") name results called word ("proposition")? */
  function kindMatches(typed, word) {
    if (!word) return false;
    const t = typed.toLowerCase().replace(/\.$/, '');
    if (Object.prototype.hasOwnProperty.call(ABBR, t)) return ABBR[t] === word;
    if (t === word || t === word + 's' || t === word + 'es') return true;
    if (word.endsWith('y') && t === word.slice(0, -1) + 'ies') return true; // corollaries
    // a shortened word with its dot: "Coroll.", "Propos."
    return typed.endsWith('.') && t.length >= 3 && word.startsWith(t);
  }

  const NUM = '[A-Z]?\\d+(?:\\.\\d+)*[a-z]?';
  // "Theorem 2.3", "Lemmas 4.1, 4.2 and 4.5", "Prop. 3.1"
  const NUMBERED = new RegExp(`\\b([A-Za-z]{2,}\\.?)[\\s\\u00a0~]*(${NUM}(?:\\s*(?:,|and|&|or|–|-)\\s*${NUM})*)(?![\\w.]*\\d)`, 'g');
  // "the previous lemma", "the lemma above", "the next proposition"
  const RELATIVE = /\b(?:the|this|that)?\s*(previous|preceding|above|last|foregoing|aforementioned|following|next|below)\s+([A-Za-z]{2,}\.?)|\bthe\s+([A-Za-z]{2,}\.?)\s+(above|below)\b/gi;
  const BACK = /^(previous|preceding|above|last|foregoing|aforementioned)$/i;
  // what makes "Theorem 2.1" someone else's: "of [5]", "in Smith's paper", "from the book"
  const ELSEWHERE = /^\s*(?:\([^)]{0,30}\)\s*)?(?:of|in|from)\s+(?:†|\[|ref\b|reference|the\s+(?:paper|work|article|book|monograph|survey|preprint|notes|thesis)|[A-Z][a-z]+(?:'s|\s+et\s+al|\s+and\s+[A-Z]))/;
  const CITE_MARK = '†'; // a citation, in the text read below
  const LINK_MARK = '‡'; // a link already followed

  /**
   * The words of a block, as one string: formulas, links and citations stand
   * as placeholders, so that nothing inside them reads as a mention.
   */
  function wordsOf(scope, skip) {
    let s = '';
    const walk = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { s += c.data; continue; }
        if (c.nodeType !== 1) continue;
        if (skip && skip(c)) { s += ' '; continue; }
        const cl = c.classList;
        if (cl.contains('cite')) s += ` ${CITE_MARK} `;
        else if (c.tagName === 'A') s += ` ${LINK_MARK} `;
        else if (cl.contains('math') || cl.contains('katex') || cl.contains('thm-name') || cl.contains('proof-head') || c.tagName === 'SUP') s += ' • ';
        else {
          walk(c);
          if (/^(P|DIV|LI|TD|TR|BR|TABLE|UL|OL|DT|DD)$/.test(c.tagName)) s += ' • ';
        }
      }
    };
    walk(scope);
    return s.replace(/\s+/g, ' ');
  }

  /**
   * The results a block mentions without a link: [{ node, why }].
   * at(rel, word) finds the result before ('back') or after ('on') the block
   * that a relative mention means.
   */
  function mentionsIn(text, byNumber, at) {
    const out = [];
    let m;
    NUMBERED.lastIndex = 0;
    while ((m = NUMBERED.exec(text))) {
      const word = m[1];
      if (/^(and|or|of|in|see|by|to|the|from|with|on|at|for|as|are|is|be|we|it)$/i.test(word.replace(/\.$/, ''))) continue;
      const before = text.slice(Math.max(0, m.index - 4), m.index);
      if (new RegExp(`${CITE_MARK}\\s*,?\\s*$`).test(before)) continue; // "[5], Theorem 2" is the cited paper's
      if (ELSEWHERE.test(text.slice(m.index + m[0].length, m.index + m[0].length + 60))) continue;
      for (const num of m[2].split(/\s*(?:,|and|&|or)\s*/)) {
        const range = /^(.+?)\s*[–-]\s*(.+)$/.exec(num);
        for (const n of range ? [range[1], range[2]] : [num]) {
          const node = byNumber.get(n.trim());
          if (node && kindMatches(word, wordOf(node.name))) out.push({ node, why: `${word} ${n.trim()}` });
        }
      }
    }
    RELATIVE.lastIndex = 0;
    while ((m = RELATIVE.exec(text))) {
      const where = m[1] || m[4];
      const word = m[2] || m[3];
      const node = at(BACK.test(where) ? 'back' : 'on', word);
      if (node) out.push({ node, why: m[0].trim() });
    }
    return out;
  }

  /** The text of an element as read on the page (KaTeX's hidden MathML left out). */
  function plainText(el) {
    let s = '';
    const walk = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.data;
        else if (c.nodeType === 1 && !c.classList.contains('katex-mathml') && !c.classList.contains('uses-btn')) walk(c);
      }
    };
    walk(el);
    return s.trim().replace(/\s+/g, ' ');
  }

  /** A result's section: the chapter (or section) heading it sits under. */
  function sectionsOf(doc, nodes) {
    const top = doc.querySelector('h1.chapter, h2.chapter') ? 'chapter' : 'section';
    const heads = Array.from(doc.querySelectorAll(`.${top}[id], h1.appendix[id], h2.appendix[id]`))
      .filter((h) => /^H[1-6]$/.test(h.tagName) && !h.closest(INSIDE_POPOVER));
    const sections = [];
    let k = 0;
    let cur = null;
    for (const n of nodes) {
      while (k < heads.length && heads[k].compareDocumentPosition(n.el) & 4) {
        const h = heads[k++];
        const num = h.querySelector('.secnum');
        const title = plainText(h);
        const numText = num ? num.textContent.trim() : '';
        cur = { id: h.id, num: numText, title: numText ? title.slice(numText.length).trim() : title, order: sections.length };
        sections.push(cur);
      }
      n.section = cur;
    }
    return sections;
  }

  /** "[3] Hairer": a short name for an entry of the bibliography. */
  function citeName(li) {
    const lab = li.querySelector('.bib-label');
    const label = lab ? lab.textContent.trim() : '[?]';
    const body = li.querySelector('.bib-body') || li;
    const text = body.textContent.trim().replace(/\s+/g, ' ');
    const first = text.split(/,|\band\b|:/)[0].trim();
    // "M. Hairer" → "Hairer"; "Hairer" → "Hairer"
    const words = first.split(' ').filter((w) => !/\.$/.test(w) || w.length > 3);
    let who = words.length ? words[words.length - 1] : '';
    if (who.length > 16) who = who.slice(0, 15) + '…';
    return { label, who: who.replace(/[.;]$/, '') };
  }

  /**
   * Which results refer to which: { nodes, byEl, cites, sections }, each node being
   * { el, id, name, note, kind, style, uses: Set(node), usedBy: Set(node), order,
   *   edges: Map(node → { statement, proof, guessed, why }), cites: Map(cite → { statement, proof }),
   *   section, proofs, refs }.
   * A result uses whatever its statement and its proof refer to: links to other
   * results, links to equations inside them or inside their proofs, and, as
   * guessed links, results named by hand ("Lemma 2.3", "the previous lemma").
   * A proof belongs to the result its heading names ("Proof of Theorem 2"), else
   * to the result just before it. Cited works are { el, id, label, who, usedBy, order }.
   */
  function dependencyGraph(doc) {
    const byEl = new Map();
    const nodes = [];
    const nodeOf = (el) => {
      let n = byEl.get(el);
      if (!n) {
        n = {
          el, id: el.id, name: thmName(el), note: thmNote(el), kind: kindOf(el), style: styleOf(el), uses: new Set(), usedBy: new Set(), order: nodes.length,
          proofs: [], refs: { statement: new Set(), proof: new Set() }, // its proofs, and the equations, figures… it refers to
          eqs: new Set(), // every displayed equation it refers to, wherever it sits (search by use)
          edges: new Map(), cites: new Map(), section: null,
        };
        byEl.set(el, n);
        nodes.push(n);
      }
      return n;
    };
    const blocks = Array.from(doc.querySelectorAll('.theorem[id], .proof')).filter((el) => !el.closest(INSIDE_POPOVER));
    for (const el of blocks) if (el.classList.contains('theorem')) nodeOf(el);
    nodes.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
    nodes.forEach((n, k) => { n.order = k; });
    const byNumber = new Map(); // "2.3" → the result numbered so, when only one is
    for (const n of nodes) {
      const num = n.el.dataset.number || (/\s([A-Z]?\d[\w.]*)$/.exec(n.name) || [])[1];
      if (!num) continue;
      byNumber.set(num, byNumber.has(num) ? null : n);
    }

    // Whose is each proof
    const ownerOf = new Map(); // proof → node
    let last = null;
    for (const el of blocks) {
      if (el.classList.contains('theorem')) { last = byEl.get(el); continue; }
      const head = el.querySelector('.proof-head');
      let owner = null;
      if (head && head.closest('.proof') === el) {
        for (const a of head.querySelectorAll('a.ref[href^="#"]')) {
          const t = targetOf(a, doc);
          const r = t && t.closest('.theorem[id]');
          if (r && byEl.has(r)) { owner = byEl.get(r); break; }
        }
        if (!owner && !head.querySelector('a.ref')) {
          // "Proof of Theorem 1.3", typed by hand
          const found = mentionsIn(head.textContent.replace(/\s+/g, ' '), byNumber, () => null);
          if (found.length) owner = found[0].node;
        }
      }
      if (!owner) owner = last;
      if (!owner) continue;
      ownerOf.set(el, owner);
      owner.proofs.push(el);
    }

    /** The result a link's target belongs to: the result itself, or the one whose proof holds it. */
    const resultOf = (target) => {
      if (!target || target.closest(INSIDE_POPOVER)) return null;
      const t = target.closest('.theorem[id], .proof');
      if (!t) return null;
      return t.classList.contains('theorem') ? byEl.get(t) || null : ownerOf.get(t) || null;
    };
    const link = (owner, dep, part, guessed, why) => {
      if (!dep || dep === owner) return;
      let e = owner.edges.get(dep);
      if (!e) {
        e = { statement: false, proof: false, guessed: true, why: '' };
        owner.edges.set(dep, e);
        owner.uses.add(dep);
        dep.usedBy.add(owner);
      }
      e[part] = true;
      if (!guessed) e.guessed = false;
      else if (!e.why) e.why = why;
    };
    const citeByEl = new Map(); // bibliography entry, or "key:Smith14" for a key with no entry on the page
    const cites = [];
    const citeOf = (li, key) => {
      let c = citeByEl.get(li || 'key:' + key);
      if (!c) {
        c = li
          ? Object.assign({ el: li, id: li.id, usedBy: new Set(), order: cites.length, cite: true }, citeName(li))
          : { el: null, id: null, usedBy: new Set(), order: cites.length, cite: true, label: key.length > 18 ? key.slice(0, 17) + '…' : key, who: '' };
        citeByEl.set(li || 'key:' + key, c);
        cites.push(c);
      }
      return c;
    };
    const cite = (owner, c, part) => {
      const e = owner.cites.get(c) || { statement: false, proof: false };
      e[part] = true;
      owner.cites.set(c, e);
      c.usedBy.add(owner);
    };
    const read = (owner, scope, skip, part) => {
      for (const a of scope.querySelectorAll('a[href^="#"]')) {
        if (skip(a)) continue;
        const target = targetOf(a, doc);
        if (!target || target.closest(INSIDE_POPOVER)) continue;
        if (a.closest('.cite')) {
          const li = target.closest('li');
          if (li && li.id) cite(owner, citeOf(li), part);
          continue;
        }
        if (!a.classList.contains('ref')) continue;
        const dep = resultOf(target);
        const md = target.closest('.math-display');
        if (md) owner.eqs.add(md);
        if (!target.closest('.theorem[id]') && !/^H[1-6]$/.test(target.tagName) && !target.closest('section > h1, section > h2')) {
          owner.refs[part].add(target); // an equation, a figure, a numbered item
        }
        link(owner, dep, part, false);
      }
      // citations of works the page has no entry for (no .bib or .bbl): by their keys
      for (const k of scope.querySelectorAll('.cite .cite-key')) {
        if (skip(k)) continue;
        const key = k.textContent.trim();
        if (key) cite(owner, citeOf(null, key), part);
      }
      // results named without a link
      const text = wordsOf(scope, skip);
      if (!/[A-Za-z]{2,}\.?[\s\u00a0~]*[A-Z]?\d|previous|preceding|above|last|foregoing|aforementioned|following|next|below/i.test(text)) return;
      // the result a relative mention means, before or after this block
      let here = null; // where the block sits among the results
      const at = (dir, word) => {
        if (here == null) {
          here = 0;
          while (here < nodes.length && (nodes[here].el.compareDocumentPosition(scope) & 4 || nodes[here].el === scope)) here++;
        }
        const fits = (n) => n !== owner && !n.el.contains(scope) && (/^results?$/i.test(word) ? n.style === 'plain' : kindMatches(word, wordOf(n.name)));
        if (dir === 'back') {
          for (let k = here - 1; k >= 0; k--) if (fits(nodes[k])) return nodes[k];
        } else {
          for (let k = here; k < nodes.length; k++) if (fits(nodes[k])) return nodes[k];
        }
        return null;
      };
      for (const { node, why } of mentionsIn(text, byNumber, at)) link(owner, node, part, true, why);
    };
    for (const el of blocks) {
      if (el.classList.contains('theorem')) {
        const owner = byEl.get(el);
        read(owner, el, (x) => {
          const p = x.closest('.proof, .theorem');
          return p !== el && el.contains(p); // a nested proof or result counts for itself
        }, 'statement');
        continue;
      }
      const owner = ownerOf.get(el);
      if (!owner) continue;
      const head = el.querySelector('.proof-head');
      read(owner, el, (x) => !!head && head.contains(x), 'proof');
    }
    // in the bibliography's order, keys without an entry after them
    cites.sort((a, b) => (a.el && b.el ? (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1) : a.el ? -1 : b.el ? 1 : a.order - b.order));
    cites.forEach((c, k) => { c.order = k; });
    const sections = sectionsOf(doc, nodes);
    // Keys that name each result (and cited work) on every device, as reading
    // progress does (src/progress.js): its \label, else its name.
    const seen = new Map();
    const unique = (k) => {
      const c = (seen.get(k) || 0) + 1;
      seen.set(k, c);
      return c > 1 ? k + '#' + c : k;
    };
    for (const n of nodes) {
      const label = n.el.dataset.label;
      n.key = unique(label ? 'label:' + label : 'name:' + n.name + (!/\d/.test(n.name) && n.note ? ' (' + n.note + ')' : ''));
    }
    for (const c of cites) c.key = unique('cite:' + (c.id || c.label));
    return { nodes, byEl, cites, sections, byKey: new Map([...nodes, ...cites].map((x) => [x.key, x])) };
  }

  /**
   * The reader's own links over the paper's: rebuild each result's edges, uses
   * and usedBy from what the paper says (kept in paperEdges) and `link`, the
   * reader's changes ({ "a > b": { s } }: 'add' an arrow from a to b, that is b
   * uses a; 'del' take the paper's away). n.removed lists the links taken away.
   */
  function applyLinks(g, link) {
    link = link || {};
    for (const n of g.nodes) {
      if (!n.paperEdges) n.paperEdges = new Map(n.edges);
      n.edges = new Map();
      n.uses.clear();
      n.usedBy.clear();
      n.removed = [];
    }
    const add = (n, dep, e) => {
      n.edges.set(dep, e);
      n.uses.add(dep);
      dep.usedBy.add(n);
    };
    for (const n of g.nodes) {
      for (const [dep, e] of n.paperEdges) {
        const l = link[dep.key + ' > ' + n.key];
        if (l && l.s === 'del') n.removed.push(dep);
        else add(n, dep, e);
      }
    }
    for (const [k, l] of Object.entries(link)) {
      if (!l || l.s !== 'add') continue;
      const [a, b] = k.split(' > ');
      const dep = g.byKey.get(a);
      const n = g.byKey.get(b);
      if (!dep || !n || dep === n || dep.cite || n.cite || n.edges.has(dep)) continue;
      add(n, dep, { statement: false, proof: false, guessed: false, mine: true, why: '' });
    }
    return g;
  }

  /** "eq:(3.4)": the key of a numbered equation, by its first number (or tag), or null. */
  function eqKeyOf(el) {
    if (!el || !el.classList || !el.classList.contains('math-display')) return null;
    for (const t of el.querySelectorAll('.katex .tag, .diagram-tag')) {
      const s = t.textContent.replace(/\s+/g, ' ').trim();
      if (s) return 'eq:' + s;
    }
    return null;
  }

  /** What a numbered equation is called: "(3.4)", or "(3.4), (3.5)" for several rows. */
  function eqNameOf(el) {
    const tags = Array.from(el.querySelectorAll('.katex .tag, .diagram-tag')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return tags.length ? (tags.length > 2 ? `${tags[0]}–${tags[tags.length - 1]}` : tags.join(', ')) : 'Equation';
  }

  /**
   * The paper's notation: { macros, symbols, defs, byName }.
   * macros: [{ name, mac, first, count }] for the macros its formulas use;
   * defs: every symbol the paper defines, in document order, with :=  and the
   * like or in words ("let X be", "denote by X"): [{ tex, key, el, pat, scope, text }];
   * symbols: the ones the index lists (each once, leaving out those a proof or a
   * statement keeps to itself).
   */
  function notationIndex(doc, definitions, o) {
    const macros = (definitions && definitions.macros) || {};
    const byName = new Map();
    const heads = Array.from(doc.querySelectorAll('h1, h2, h3, h4')).filter((h) => !h.closest(INSIDE_POPOVER));
    const defs = [];
    for (const el of formulas(doc)) {
      const tex = el.dataset.tex;
      for (const name of commandsIn(tex)) {
        if (!Object.prototype.hasOwnProperty.call(macros, name) || /@|^the/.test(name)) continue;
        let e = byName.get(name);
        if (!e) {
          e = { name, mac: macros[name], first: el, count: 0 };
          byName.set(name, e);
        }
        e.count++;
      }
      if (tex.length < 400) {
        const s = definedSymbol(tex);
        if (s) defs.push({ tex: s, key: texTokens(s).join(' '), el, pat: patternOf(s), scope: scopeOf(el, s, heads), text: false });
      }
    }
    // what the author says a symbol means, with texglass.sty's \tgdefine
    for (const el of doc.querySelectorAll('.tg-define[data-tg-sym]')) {
      if (el.closest(INSIDE_POPOVER)) continue;
      const d = authorDefinition(el);
      if (d) defs.push(d);
    }
    let inText = [];
    if (!(o && o.words === false)) {
      try { inText = textDefinitions(doc); } catch (e) { /* never let a reading aid break the page */ }
    }
    if (inText.length || defs.some((d) => d.author)) {
      defs.push(...inText);
      defs.sort((a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
    }
    const symbols = [];
    const seen = new Set();
    // the author's word on a symbol comes before what the text seems to say
    const said = new Map();
    for (const d of defs) if (d.author && !d.scope.within && !said.has(d.key)) said.set(d.key, d);
    for (const d of defs) {
      if (d.scope.within || seen.has(d.key)) continue;
      seen.add(d.key);
      symbols.push(said.get(d.key) || d);
    }
    // in the order a reader meets them
    return { macros: Array.from(byName.values()), symbols, defs, byName };
  }

  /** Whether definition d holds at formula el (which comes after it). */
  function holdsAt(d, el) {
    if (d.everywhere) return true; // \tgdefine in the preamble
    if (d.el === el || !(d.el.compareDocumentPosition(el) & 4)) return false;
    if (d.scope.within && !d.scope.within.contains(el)) return false;
    if (d.scope.until && !(el.compareDocumentPosition(d.scope.until) & 4)) return false;
    return true;
  }

  /**
   * The definitions a formula uses: for each symbol, the latest definition that
   * holds there; a symbol inside a longer one found too (X in X_t) is left out, unless it
   * sits in the longer one's argument.
   */
  function definitionsUsed(defs, el) {
    const f = texTokens(el.dataset.tex || '');
    const own = definedSymbol(el.dataset.tex || '');
    const ownKey = own ? texTokens(own).join(' ') : null;
    const best = new Map(); // key -> { d, spans }
    for (const d of defs) {
      if (d.key === ownKey || !holdsAt(d, el)) continue;
      const spans = occurrences(f, d.pat);
      const had = best.get(d.key);
      if (spans.length && !(had && had.d.author && !d.author)) best.set(d.key, { d, spans });
    }
    const found = Array.from(best.values());
    return found
      .filter((x) => !found.some((y) => y !== x && !y.d.pat.toks.includes(SLOT) && x.spans.every(([a, b]) => y.spans.some(([c, e]) => c <= a && b <= e && e - c > b - a))))
      .map((x) => x.d);
  }

  /** "\name{·}{·}": a macro the way the index shows it, arguments as dots. */
  function sampleOf(e) {
    const n = e.mac.delims ? 0 : Math.max(0, (e.mac.nargs || 0) - (e.mac.def != null ? 1 : 0));
    if (e.mac.delims) return null; // \def\pair(#1,#2): no sample worth guessing
    return '\\' + e.name + '{\\cdot}'.repeat(n);
  }

  /** "\newcommand{\R}{\mathbb{R}}", shortened. */
  function definitionOf(e) {
    const n = e.mac.nargs ? `[${e.mac.nargs}]` : '';
    const d = e.mac.def != null ? `[${e.mac.def}]` : '';
    let body = String(e.mac.body || '');
    if (body.length > 120) body = body.slice(0, 117) + '…';
    return `\\${e.name}${n}${d} → ${body}`;
  }

  // ---------------------------------------------------------------------------
  // Arranging the notation index: by section, by kind, A–Z, and search
  // ---------------------------------------------------------------------------

  const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];
  const GREEK_UNI = 'αβγδεζηθικλμνξοπρστυφχψω';
  const GREEK_CAP = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ';
  /** The place of a Greek letter's name (\alpha, \Gamma, \varphi) in the alphabet, or -1. */
  function greekIndex(name) {
    const n = String(name).toLowerCase().replace(/^var/, '');
    return GREEK.indexOf(n === 'digamma' ? 'gamma' : n);
  }
  /** A search typed with Greek letters (α, Γ) looks for their names. */
  function greekQuery(q) {
    return String(q).replace(/[α-ωΑ-Ως]/g, (c) => {
      const k = GREEK_UNI.indexOf(c === 'ς' ? 'σ' : c);
      if (k >= 0) return GREEK[k];
      const K = GREEK_CAP.indexOf(c);
      return K >= 0 ? GREEK[K] : c;
    });
  }

  /**
   * Where a symbol goes in A–Z order: { group, key }, group being a capital
   * letter, "Greek" or "Other". tex is the symbol (or "\name" for a macro);
   * decorations such as \mathbb, \hat or \mathcal are looked through.
   */
  function alphaOf(tex) {
    const toks = String(tex).match(/\\[A-Za-z]+|[A-Za-z]|\S/g) || [];
    for (const t of toks) {
      if (/^[A-Za-z]$/.test(t)) return { group: t.toUpperCase(), key: t.toLowerCase() + (t === t.toLowerCase() ? '0' : '1') + tex };
      if (t[0] !== '\\' || t.length < 2) continue; // a lone backslash (from \, or \;) names nothing
      const name = t.slice(1);
      const g = greekIndex(name);
      if (g >= 0) return { group: 'Greek', key: String(g).padStart(2, '0') + (name[0] === name[0].toLowerCase() ? '0' : '1') + tex };
      if (DECOR.test(t) || /^(operatorname|mathrm|text[a-z]*|left|right|[bB]ig+[lr]?|[lr]Vert|[lr]vert|lVert|rVert)$/.test(name)) continue;
      // another command: by its name (\norm under N, \cH under C)
      return { group: name[0].toUpperCase(), key: name.toLowerCase() + '0' + tex };
    }
    return { group: 'Other', key: tex };
  }

  // The kinds the index can group symbols into, in the order shown.
  const KINDS = [
    ['spaces', 'Spaces and sets'],
    ['maps', 'Maps and operators'],
    ['names', 'Named functions'],
    ['constants', 'Constants and parameters'],
    ['other', 'Other symbols'],
  ];
  const KIND_WORDS = [
    ['spaces', /\b(spaces?|sets?|subsets?|algebras?|sigma-algebra|σ-algebra|groups?|subgroups?|rings?|fields?|modules?|manifolds?|tor[iu]s?|lattices?|domains?|categor(y|ies)|class(es)?|collections?|famil(y|ies)|filtrations?|ideals?|intervals?|balls?|spheres?|cones?|graphs?|alphabets?|vector bundles?|bundles?|varieties|variety|cubes?|boxes|simplex|polytopes?|regions?)\b/],
    ['maps', /\b(maps?|mappings?|operators?|semigroups?|norms?|seminorms?|inner products?|measures?|transforms?|derivatives?|projections?|kernels?|functionals?|expectations?|variances?|laws?|distributions?|processes|process|flows?|actions?|morphisms?|isomorphisms?|homomorphisms?|embeddings?|generators?|differentials?|gradients?|laplacians?|convolutions?|products?)\b/],
    ['constants', /\b(constants?|parameters?|numbers?|exponents?|dimensions?|thresholds?|integers?|ranks?|degrees?|rates?|fixed|positive real|real numbers?|radius|radii)\b/],
    ['names', /\bfunctions?\b/],
  ];

  /**
   * The kind of a symbol, guessed from what the paper says about it (words: the
   * text right after the symbol first, then before) and its shape (tex, the
   * macro's body, how many arguments it takes, the formula that defines it).
   * One of the KINDS ids.
   */
  function kindOfSymbol(tex, words, body, nargs, formula) {
    const shape = String(tex) + ' ' + String(body || '');
    if (/\\operatorname|\\DeclareMathOperator|\\mathrm\s*\{\s*[A-Za-z]{2,}\s*\}|\\text(rm|up)?\s*\{\s*[A-Za-z]{2,}\s*\}|\\(log|exp|sin|cos|tan|sinh|cosh|tanh|det|tr|dim|ker|deg|arg|sup|inf|lim|max|min|Pr|gcd)\b/.test(shape) && !/\\mathbb\s*\{?\s*[EP]\b/.test(shape)) return 'names';
    for (const w of words || []) {
      if (!w) continue;
      let best = null;
      for (const [k, re] of KIND_WORDS) {
        const m = re.exec(w.toLowerCase());
        if (m && (!best || m.index < best.at)) best = { k, at: m.index };
      }
      if (best) return best.k;
    }
    if (/\\mathbb\s*\{?\s*[EP]\b|\\(nabla|partial|Delta|mathcal\s*\{?\s*[LF]\})/.test(shape) && (nargs || /\\mathbb\s*\{?\s*[EP]\b/.test(shape))) return 'maps';
    if (/\\(mathbb|mathcal|mathscr|mathfrak|mathsf|cal|scr|frak|Bbb)\s*\{?\s*[A-Z]/.test(shape)) return 'spaces';
    if (nargs || /\\(lVert|lvert|langle|\|)|#1/.test(shape)) return 'maps';
    if (/(:=|\\coloneqq)\s*-?\s*(\d|\\(pi|frac\s*\{?\s*\d|sqrt\s*\{?\s*\d|log\s*\d)\b)/.test(String(formula || ''))) return 'constants';
    return 'other';
  }

  // ---------------------------------------------------------------------------
  // Where things are
  // ---------------------------------------------------------------------------

  function makeLocator(doc) {
    const heads = Array.from(doc.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], strong.run-in[id]')).filter((h) => !h.closest(INSIDE_POPOVER));
    const before = (a, b) => !!(a.compareDocumentPosition(b) & 4);
    return function where(el, graph) {
      const thm = el.closest('.theorem[id]');
      if (thm) return thmName(thm);
      const proof = el.closest('.proof');
      if (proof && graph) {
        // the result this proof belongs to: the graph's owner is not kept, so name the result before it
        let owner = null;
        for (const n of graph.nodes) {
          if (before(n.el, proof)) owner = n;
          else break;
        }
        if (owner) return `Proof of ${owner.name}`;
      }
      let lo = 0;
      let hi = heads.length - 1;
      let found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (before(heads[mid], el)) { found = heads[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      if (!found) return el.closest('.abstract') ? 'the abstract' : 'the opening pages';
      const t = found.textContent.trim().replace(/\s+/g, ' ');
      const num = found.querySelector('.secnum');
      const label = num ? `§${num.textContent.trim()} ${t.slice(num.textContent.trim().length).trim()}` : t;
      return label.length > 48 ? label.slice(0, 46) + '…' : label;
    };
  }

  /** A copy of a rendered formula without ids, to show elsewhere. */
  function copyOf(el) {
    const c = el.cloneNode(true);
    c.removeAttribute('id');
    c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
    return c;
  }

  /**
   * A definition the author gave with texglass.sty's \tgdefine{symbol}{meaning}:
   * the converter leaves <span class="tg-define" data-tg-sym data-tg-meaning>
   * (meaning as HTML), with data-tg-scope="document" when it came from the preamble.
   */
  function authorDefinition(el) {
    const tex = cleanSymbol(el.dataset.tgSym || '') || String(el.dataset.tgSym || '').trim();
    if (!tex) return null;
    const meaning = el.dataset.tgMeaning || '';
    const everywhere = el.dataset.tgScope === 'document';
    const proof = el.closest('.proof');
    return {
      tex, key: texTokens(tex).join(' '), el, pat: patternOf(tex), text: false, author: true, everywhere, meaning,
      words: meaningText(el.ownerDocument, meaning),
      scope: { within: !everywhere && proof ? proof : null, until: null },
    };
  }

  /** The plain words of a meaning given as HTML. */
  function meaningText(doc, html) {
    const box = doc.createElement('div');
    box.innerHTML = html;
    box.querySelectorAll('.katex-mathml').forEach((x) => x.remove());
    box.querySelectorAll('.math[data-tex]').forEach((x) => { x.textContent = x.dataset.tex; });
    return box.textContent.replace(/\s+/g, ' ').trim();
  }

  /** What shows a definition: the sentence that introduces the symbol, or the formula with :=. */
  function shownOf(d, marks) {
    if (d.author) {
      const box = d.el.ownerDocument.createElement('span');
      box.className = 'insight-author-def';
      box.innerHTML = d.meaning;
      return box;
    }
    if (d.text) {
      const box = sentenceOf(d, marks);
      if (box) return box;
    }
    return copyOf(d.el);
  }

  // ---------------------------------------------------------------------------
  // The dependency map, as an SVG
  // ---------------------------------------------------------------------------

  /** Small results that serve a bigger one: lemmas, claims, steps. */
  const SMALL = /^(lemma|lem|lemm|claim|sublemma|step|fact|observation|obs|technical)$/i;
  const isSmall = (n) => SMALL.test(n.kind) || SMALL.test(wordOf(n.name));

  /**
   * Chains of small lemmas that only serve one result: Map(root → [lemmas]),
   * the lemmas in document order. A lemma folds into a result when everything
   * that uses it folds into that result too; a group needs two lemmas or more.
   */
  function foldGroups(graph) {
    const memo = new Map();
    const into = (n) => {
      if (memo.has(n)) return memo.get(n);
      memo.set(n, n); // a cycle stops here
      let r = n;
      if (isSmall(n) && n.usedBy.size) {
        let t;
        for (const u of n.usedBy) {
          const x = into(u);
          if (t === undefined) t = x;
          else if (t !== x) { t = null; break; }
        }
        if (t && t !== n) r = t;
      }
      memo.set(n, r);
      return r;
    };
    const groups = new Map();
    for (const n of graph.nodes) {
      const r = into(n);
      if (r === n) continue;
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(n);
    }
    for (const [r, list] of groups) if (list.length < 2) groups.delete(r);
    return groups;
  }

  /**
   * Lay the map out: results in columns, left to right, a result one column right
   * of everything it uses; cited works in the first column. With sections on,
   * each section of the paper is a band across the map. Folded lemmas are drawn
   * as their result.
   *
   *   o.cites      draw cited works as leaves
   *   o.sections   group by section
   *   o.fold       fold chains of small lemmas into the result they serve
   *   o.expanded   Set of ids of results whose folded lemmas are shown anyway
   *   o.eqs        numbered equations to draw (pinned ones), as leaves:
   *                [{ eq: true, key, el, name, order, usedBy: Set(node) }]
   *   o.hidden     Set of keys the reader hid; o.showHidden draws them anyway, faded
   *   o.pos        { key: { x, y } } where the reader dragged things
   *   o.all        draw every result, linked or not (while the reader draws a link)
   *   o.pinned     Map(key → 'self' | 'uses' | 'usedBy' | 'both'), o.pinSub Set of keys a pin brings along
   */
  function layout(graph, o) {
    o = o || {};
    const groups = o.fold ? foldGroups(graph) : new Map();
    const foldedInto = new Map(); // lemma → the result drawn for it
    for (const [r, list] of groups) {
      if (o.expanded && o.expanded.has(r.id)) continue;
      for (const m of list) foldedInto.set(m, r);
    }
    const drawnOf = (n) => foldedInto.get(n) || n;
    const showCites = !!o.cites && graph.cites && graph.cites.length > 0;
    const hidden = o.hidden || new Set();
    const gone = (x) => !o.showHidden && hidden.has(x.key);
    const eqList = (o.eqs || []).filter((e) => !gone(e));

    // the edges between what is drawn, merged: [{ a, b, statement, proof, guessed, cite }]
    const edgeMap = new Map();
    const key = (x) => (x.cite ? 'c' + x.order : x.eq ? 'e' + x.order : String(x.order));
    const addEdge = (a, b, e, cite) => {
      if (a === b || gone(a) || gone(b)) return;
      const k = key(a) + '>' + key(b);
      let d = edgeMap.get(k);
      if (!d) {
        d = { a, b, statement: false, proof: false, guessed: true, cite: cite === true, eq: cite === 'eq', mine: !!e.mine };
        edgeMap.set(k, d);
      }
      d.statement = d.statement || !!e.statement;
      d.proof = d.proof || !!e.proof;
      if (!e.guessed) d.guessed = false;
      if (!e.mine) d.mine = false;
    };
    for (const n of graph.nodes) {
      const b = drawnOf(n);
      for (const [dep, e] of n.edges) addEdge(drawnOf(dep), b, e);
      if (showCites) for (const [c, e] of n.cites) addEdge(c, b, { statement: e.statement, proof: e.proof, guessed: false }, true);
    }
    for (const q of eqList) for (const n of q.usedBy) addEdge(q, drawnOf(n), { proof: true, guessed: false }, 'eq');
    const edges = Array.from(edgeMap.values());
    const into = new Map(); // drawn thing → [edges into it]
    const has = new Set();
    for (const e of edges) {
      has.add(e.a);
      has.add(e.b);
      if (!into.has(e.b)) into.set(e.b, []);
      into.get(e.b).push(e);
    }
    // drawing an arrow of the reader's own: every result can be its other end
    const nodes = graph.nodes.filter((n) => has.has(n) || (o.all && drawnOf(n) === n && !gone(n)));
    const cites = showCites ? graph.cites.filter((c) => has.has(c)) : [];
    const eqs = eqList; // drawn even when no result refers to them

    // columns
    const col = new Map();
    const visiting = new Set();
    const colOf = (n) => {
      if (col.has(n)) return col.get(n);
      if (n.cite || n.eq) { col.set(n, 0); return 0; }
      if (visiting.has(n)) return 0; // a cycle: break it here
      visiting.add(n);
      let c = 0;
      for (const e of into.get(n) || []) c = Math.max(c, colOf(e.a) + 1);
      visiting.delete(n);
      col.set(n, c);
      return c;
    };
    nodes.forEach(colOf);
    cites.forEach(colOf);
    eqs.forEach(colOf);

    // bands: one per section, in the paper's order, or one for everything
    const sectionOf = new Map();
    for (const n of nodes) sectionOf.set(n, n.section || null);
    for (const c of [...cites, ...eqs]) {
      // a cited work (or an equation) sits with the first result that cites it
      let first = null;
      for (const e of edges) if (e.a === c && (!first || e.b.order < first.order)) first = e.b;
      sectionOf.set(c, first ? first.section || null : c.section || null);
    }
    const used = new Set(sectionOf.values());
    const grouped = !!o.sections && used.size > 1;
    const bands = [];
    if (grouped) {
      if (used.has(null)) bands.push({ section: null, items: [] });
      for (const s of graph.sections || []) if (used.has(s)) bands.push({ section: s, items: [] });
    } else bands.push({ section: null, items: [] });
    const bandOf = new Map(bands.map((b) => [b.section, b]));
    for (const x of [...cites, ...eqs, ...nodes]) (grouped ? bandOf.get(sectionOf.get(x)) : bands[0]).items.push(x);

    const ROW = 34;
    const H = 24;
    const LABEL = grouped ? 20 : 0;
    const shownFold = new Map(); // result → the lemmas folded into it, on this map
    for (const [r, list] of groups) if (has.has(r) && !(o.expanded && o.expanded.has(r.id))) shownFold.set(r, list);
    const width = (n) => (n.eq ? Math.min(130, 18 + n.name.length * 6.6) : n.cite ? Math.min(150, 16 + (n.label.length + n.who.length + 1) * 6.6) : Math.min(190, 18 + n.name.length * 7.2) + (shownFold.has(n) ? 26 : 0));
    const ncols = Math.max(0, ...Array.from(col.values())) + 1;
    const colW = new Array(ncols).fill(0);
    for (const [n, c] of col) colW[c] = Math.max(colW[c], width(n));
    const xs = new Map();
    const colX = [];
    let x = 12;
    for (let c = 0; c < ncols; c++) {
      colX[c] = x;
      if (colW[c]) x += colW[c] + 70;
    }
    const y = new Map();
    let top = 8;
    for (const band of bands) {
      band.y0 = top;
      const start = top + LABEL + 4;
      let bottom = start;
      const cols = [];
      for (const n of band.items) (cols[col.get(n)] || (cols[col.get(n)] = [])).push(n);
      cols.forEach((list) => {
        if (!list) return;
        // order by where the things they use sit (in this band), then by document order
        const bary = (n) => {
          let s = 0;
          let k = 0;
          for (const e of into.get(n) || []) if (y.has(e.a) && y.get(e.a) >= start) { s += y.get(e.a); k++; }
          return k ? s / k : null;
        };
        const keyed = list.map((n) => ({ n, b: bary(n) }));
        keyed.sort((a, b) => (a.b == null || b.b == null ? a.n.order - b.n.order : a.b - b.b || a.n.order - b.n.order));
        let next = start;
        for (const { n, b } of keyed) {
          const t = Math.max(next, b == null ? next : Math.round(b));
          y.set(n, t);
          xs.set(n, colX[col.get(n)]);
          next = t + ROW;
        }
        bottom = Math.max(bottom, next);
      });
      band.y1 = bottom;
      top = bottom + (grouped ? 6 : 0);
      band.label = band.section
        ? (band.section.num ? `§${band.section.num} ` : '') + band.section.title
        : grouped ? 'Before the first section' : '';
      if (band.label.length > 60) band.label = band.label.slice(0, 58) + '…';
    }
    // where the reader dragged things: there instead, and the bands and the
    // map grow to hold them
    let w = Math.max(x - 58, 200);
    let h = Math.max(top + 4, 40);
    const pos = o.pos || {};
    let moved = false;
    for (const it of xs.keys()) {
      const p = it.key && pos[it.key];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      xs.set(it, Math.max(2, p.x));
      y.set(it, Math.max(2, p.y));
      moved = true;
    }
    if (moved) {
      for (const band of bands) {
        if (!band.items.length) continue;
        const ys = band.items.map((it) => y.get(it));
        band.y0 = Math.min(band.y0, Math.min(...ys) - LABEL - 4);
        band.y1 = Math.max(band.y1, Math.max(...ys) + ROW);
      }
      for (const [it, px] of xs) {
        w = Math.max(w, px + width(it) + 30);
        h = Math.max(h, y.get(it) + H + 10);
      }
      for (const band of bands) h = Math.max(h, band.y1 + 4);
    }
    for (const band of bands) delete band.items;
    return {
      nodes, cites, eqs, edges, x: xs, y, width, H, bands: grouped ? bands : [], grouped,
      drawnOf, foldedInto, groups, shownFold, hidden, moved,
      pinned: o.pinned || new Map(), pinSub: o.pinSub || new Set(),
      size: { w, h },
    };
  }

  /** The path of an arrow from a to b on a laid-out map. */
  function edgePath(lay, a, b) {
    const H = lay.H;
    const x1 = lay.x.get(a) + lay.width(a);
    const y1 = lay.y.get(a) + H / 2;
    const x2 = lay.x.get(b);
    const y2 = lay.y.get(b) + H / 2;
    const back = x2 <= x1;
    const dx = back ? 40 : Math.max(24, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2 - 4},${y2}`;
  }

  const PIN_PATH = 'M-2.6,-5.5 h5.2 l-0.9,3.6 l2.6,2.4 h-3.1 l-0.8,4.6 l-0.8,-4.6 h-3.1 l2.6,-2.4 z';

  function mapSvg(lay) {
    const parts = [];
    const { H } = lay;
    const k = (x) => (x.cite ? 'c' + x.order : x.eq ? 'e' + x.order : String(x.order));
    // what the reader did to a node: pinned (a pin by its corner), brought along by a pin, hidden
    const marks = (x) => {
      const d = lay.pinned.get(x.key);
      return (d ? ' dep-pinned' + (d !== 'self' ? ' dep-pinned-' + d : '') : lay.pinSub.has(x.key) ? ' dep-pinned-sub' : '') +
        (lay.hidden.has(x.key) ? ' dep-hidden' : '');
    };
    const pinMark = (x, px, py) => (lay.pinned.get(x.key) ? `<g class="dep-pin-mark" transform="translate(${px + 3},${py + 2})" aria-hidden="true"><circle r="6.5"/><path d="${PIN_PATH}" transform="scale(0.8)"/></g>` : '');
    const said = (x) => (lay.pinned.get(x.key) ? ', pinned' : '') + (lay.hidden.has(x.key) ? ', hidden' : '');
    const w = lay.size.w + 12;
    lay.bands.forEach((b, i) => {
      parts.push(
        `<g class="dep-band${i % 2 ? ' dep-band-odd' : ''}"${b.section ? ` data-sec="${esc(b.section.id)}"` : ''}><rect x="2" y="${b.y0}" width="${w - 4}" height="${b.y1 - b.y0}" rx="6"/>` +
          `<text x="10" y="${b.y0 + 14}">${esc(b.label)}</text></g>`
      );
    });
    for (const e of lay.edges) {
      const d = e.a;
      const n = e.b;
      if (!lay.x.has(d) || !lay.x.has(n)) continue;
      const cls = 'dep-edge' + (e.cite ? ' dep-cite-edge' : e.eq ? ' dep-eq-edge' : e.mine ? ' dep-mine' : e.proof ? ' dep-proof' : ' dep-stmt') +
        (e.guessed && !e.cite && !e.eq ? ' dep-guess' : '') + (lay.hidden.has(d.key) || lay.hidden.has(n.key) ? ' dep-hidden' : '');
      parts.push(`<path class="${cls}" data-from="${k(d)}" data-to="${k(n)}" d="${edgePath(lay, d, n)}" marker-end="url(#dep-arrow)"/>`);
    }
    for (const q of lay.eqs) {
      const qw = lay.width(q);
      const qx = lay.x.get(q);
      const qy = lay.y.get(q);
      parts.push(
        `<g class="dep-node dep-eqnode${marks(q)}" data-e="${q.order}" tabindex="0" role="button" aria-label="${esc('Equation ' + q.name + said(q))}">` +
          `<rect x="${qx}" y="${qy}" width="${qw}" height="${H}" rx="${H / 2}"/>` +
          `<text x="${qx + qw / 2}" y="${qy + H / 2 + 4.5}" text-anchor="middle">${esc(q.name)}</text>${pinMark(q, qx, qy)}</g>`
      );
    }
    for (const c of lay.cites) {
      const cw = lay.width(c);
      const label = `${c.label} ${c.who}`.trim();
      parts.push(
        `<g class="dep-node dep-citenode${marks(c)}" data-c="${c.order}" tabindex="0" role="button" aria-label="${esc('Cited work ' + label + said(c))}">` +
          `<rect x="${lay.x.get(c)}" y="${lay.y.get(c)}" width="${cw}" height="${H}" rx="${H / 2}"/>` +
          `<text x="${lay.x.get(c) + cw / 2}" y="${lay.y.get(c) + H / 2 + 4.5}" text-anchor="middle">${esc(label.length > 22 ? label.slice(0, 21) + '…' : label)}</text>${pinMark(c, lay.x.get(c), lay.y.get(c))}</g>`
      );
    }
    for (const n of lay.nodes) {
      const nw = lay.width(n);
      const label = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
      const main = /^(theorem|thm|maintheorem|mainthm|corollary|cor)$/i.test(n.kind) ? ' dep-main' : '';
      const x = lay.x.get(n);
      const y = lay.y.get(n);
      const folded = lay.shownFold.get(n);
      const tw = folded ? nw - 26 : nw;
      parts.push(
        `<g class="dep-node dep-${n.style}${main}${folded ? ' dep-has-fold' : ''}${marks(n)}" data-n="${n.order}" tabindex="0" role="button" aria-label="${esc(n.name + (n.note ? ' (' + n.note + ')' : '') + (folded ? `, with ${folded.length} lemmas folded in` : '') + said(n))}">` +
          `<rect x="${x}" y="${y}" width="${nw}" height="${H}" rx="5"/>` +
          `<text x="${x + tw / 2}" y="${y + H / 2 + 4.5}" text-anchor="middle">${esc(label)}</text>${pinMark(n, x, y)}</g>`
      );
      if (folded) {
        parts.push(
          `<g class="dep-fold" data-fold="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(`Show the ${folded.length} lemmas folded into ${n.name}`)}">` +
            `<rect x="${x + nw - 25}" y="${y + 4}" width="21" height="${H - 8}" rx="${(H - 8) / 2}"/>` +
            `<text x="${x + nw - 14.5}" y="${y + H / 2 + 4}" text-anchor="middle">+${folded.length}</text></g>`
        );
      } else if (lay.groups.has(n) && lay.x.has(n)) {
        // folding is on and this result's lemmas are out: a small button folds them back
        parts.push(
          `<g class="dep-fold dep-unfold" data-fold="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(`Fold the lemmas that only serve ${n.name} back into it`)}">` +
            `<rect x="${x + nw + 3}" y="${y + 5}" width="15" height="${H - 10}" rx="${(H - 10) / 2}"/>` +
            `<text x="${x + nw + 10.5}" y="${y + H / 2 + 4}" text-anchor="middle">−</text></g>`
        );
      }
    }
    return (
      `<svg class="dep-map" width="${w}" height="${lay.size.h}" viewBox="0 0 ${w} ${lay.size.h}" xmlns="http://www.w3.org/2000/svg">` +
      '<defs><marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="dep-arrowhead"/></marker></defs>' +
      parts.join('') +
      '</svg>'
    );
  }

  /** The key for the legend under a map: how each kind of line looks. */
  function legendHtml(lay) {
    const line = (cls) => `<svg width="34" height="10" aria-hidden="true"><path class="dep-edge ${cls}" d="M2,5 L32,5"/></svg>`;
    const items = [];
    const any = (f) => lay.edges.some(f);
    if (any((e) => !e.cite && !e.eq && !e.mine && e.proof && !e.guessed)) items.push(`${line('dep-proof')} used in a proof`);
    if (any((e) => !e.cite && !e.eq && !e.mine && !e.proof && !e.guessed)) items.push(`${line('dep-stmt')} named in a statement`);
    if (any((e) => !e.cite && !e.eq && e.guessed)) items.push(`${line('dep-proof dep-guess')} guessed from the wording (no link)`);
    if (any((e) => e.mine)) items.push(`${line('dep-mine')} your own link`);
    if (lay.pinned.size) items.push(`<svg width="14" height="14" aria-hidden="true"><g class="dep-pin-mark" transform="translate(7,7)"><circle r="6.5"/><path d="${PIN_PATH}" transform="scale(0.8)"/></g></svg> pinned`);
    if (lay.cites.length) items.push('<span class="dep-key-cite" aria-hidden="true"></span> cited work');
    if (lay.shownFold.size) items.push('<span class="dep-key-fold" aria-hidden="true">+2</span> lemmas folded in (pick to show)');
    return items.length ? `<div class="dep-legend">${items.map((i) => `<span>${i}</span>`).join('')}</div>` : '';
  }

  /**
   * Everything n uses, directly or not (dir 'uses'), everything that uses it
   * ('usedBy'), or both ('both').
   */
  function closure(n, dir) {
    if (dir === 'both') return new Set([...closure(n, 'uses'), ...closure(n, 'usedBy')]);
    const out = new Set();
    const stack = [n];
    while (stack.length) {
      for (const m of stack.pop()[dir]) if (!out.has(m) && m !== n) { out.add(m); stack.push(m); }
    }
    return out;
  }

  /** As closure(), but only along links written in the text, not guessed ones. */
  function explicitClosure(n, dir) {
    if (dir === 'both') return new Set([...explicitClosure(n, 'uses'), ...explicitClosure(n, 'usedBy')]);
    const out = new Set();
    const stack = [n];
    const sure = (a, b) => { const e = a.edges && a.edges.get(b); return e && !e.guessed; }; // a uses b
    while (stack.length) {
      const x = stack.pop();
      for (const m of x[dir]) {
        if (out.has(m) || m === n) continue;
        if (!(dir === 'uses' ? sure(x, m) : sure(m, x))) continue;
        out.add(m);
        stack.push(m);
      }
    }
    return out;
  }

  /**
   * The results that use `t`, directly (direct) or not: t is a result of the
   * graph, or { eq: true, el } for a displayed equation, used by the results
   * that refer to it and, unless direct, by whatever rests on those.
   */
  function usersOf(g, t, direct) {
    const first = t.eq
      ? g.nodes.filter((n) => n.eqs && Array.from(n.eqs).some((m) => m === t.el || t.el.contains(m) || m.contains(t.el)))
      : Array.from(t.usedBy || []);
    const out = new Set(first);
    if (!direct) for (const n of first) for (const m of closure(n, 'usedBy')) out.add(m);
    if (!t.eq) out.delete(t);
    return out;
  }

  /**
   * Search by structure: the results that use every one of q.inc (any one, with
   * q.any) and none of q.exc, in document order. With no q.inc, every result
   * that uses none of q.exc. q.direct counts only links written in the result
   * itself, not what it uses through other results. Terms as for usersOf().
   */
  function searchByUse(g, q) {
    const inc = (q && q.inc) || [];
    const exc = (q && q.exc) || [];
    const direct = !!(q && q.direct);
    let pool;
    if (!inc.length) pool = new Set(g.nodes);
    else {
      const sets = inc.map((t) => usersOf(g, t, direct));
      pool = q.any
        ? new Set(sets.flatMap((s) => Array.from(s)))
        : new Set(Array.from(sets[0]).filter((n) => sets.every((s) => s.has(n))));
    }
    for (const t of exc) {
      for (const m of usersOf(g, t, direct)) pool.delete(m);
      if (!t.eq) pool.delete(t);
    }
    return Array.from(pool).sort((a, b) => a.order - b.order);
  }

  // ---------------------------------------------------------------------------
  // The UI
  // ---------------------------------------------------------------------------

  function attach(opts) {
    const doc = opts.root;
    const document_ = doc.ownerDocument || document;
    let defs = null;
    let graph = null;
    let index = null;
    let locate = null;
    let hoverOn = opts.hover !== false;
    // Parts the reader can switch off in Settings (src/features.js): the map
    // (Map tab, larger map, "Uses / Used in" under previews), the notation
    // index, the "What does this use?" buttons and symbols introduced in words.
    const feats = { map: true, notation: true, uses: true, words: true };
    const symbolCache = new Map(); // tex -> html

    const getGraph = () => graph || (graph = applyLinks(dependencyGraph(doc), edits.link));
    const getIndex = () => index || (index = notationIndex(doc, defs, { words: feats.words }));
    const getLocate = () => locate || (locate = makeLocator(doc));
    const where = (el) => getLocate()(el, getGraph());

    let refreshViews = () => {};
    function invalidate() {
      graph = null;
      index = null;
      locate = null;
      eqCache = null;
      clearTimeout(marking);
      if (Object.keys(edits.pin).length) marking = setTimeout(markPins, 400); // once the page has settled
      hidePop();
      refreshViews();
      refocus();
    }

    function setDefinitions(d) {
      if (d !== defs) symbolCache.clear();
      defs = d || null;
      index = null;
    }

    /** Fill elements carrying data-sym with the rendered symbol, once rendered. */
    function renderSymbols(container) {
      const els = Array.from(container.querySelectorAll('[data-sym]'));
      const missing = Array.from(new Set(els.map((e) => e.dataset.sym).filter((t) => !symbolCache.has(t))));
      const put = () => {
        for (const e of els) {
          const h = symbolCache.get(e.dataset.sym);
          if (h) { e.innerHTML = h; e.removeAttribute('data-sym'); }
        }
      };
      if (!missing.length || !opts.renderTex) { put(); return; }
      Promise.resolve(opts.renderTex(missing, defs))
        .then((htmls) => {
          if (!htmls) return;
          missing.forEach((t, k) => { if (htmls[k] && !/math-error|katex-error/.test(htmls[k])) symbolCache.set(t, htmls[k]); });
          put();
        })
        .catch(() => {});
    }

    // --- notation on hover ------------------------------------------------------

    const pop = document_.createElement('div');
    pop.className = 'insight-popover ref-popover';
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    document_.body.appendChild(pop);
    let showTimer = null;
    let hideTimer = null;
    let popFor = null;
    let popView = null; // the map view whose node the popover previews
    let under = null; // the formula the pointer is on

    /** Put the popover by `el`, all of it inside the window (src/popover.js when loaded). */
    function placePop(el) {
      const P = (document_.defaultView || {}).TeXglassPopover;
      if (P) return P.place(pop, el);
      const r = el.getBoundingClientRect();
      const width = pop.offsetWidth;
      pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
      const h = pop.offsetHeight;
      pop.style.top = (r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h : r.bottom) + 'px';
    }

    /** Hide the popover. A timer that hides it late leaves a pending show alone. */
    function hidePop(late) {
      if (late !== true) clearTimeout(showTimer);
      clearTimeout(hideTimer);
      pop.hidden = true;
      popFor = null;
      popView = null;
    }

    /** What to say about the notation in a formula: [{ kind, … }], rarest first. */
    function notesFor(el) {
      const tex = el.dataset.tex || '';
      const idx = getIndex();
      const out = [];
      // symbols one sentence introduces together share one note
      const bySentence = new Map();
      for (const d of definitionsUsed(idx.defs, el)) {
        const at = d.text ? sentenceAround(d.run.text, d.at)[0] : -1;
        const same = d.text && out.find((n) => n.s.run === d.run && bySentence.get(n) === at);
        if (same) { same.group.push(d); continue; }
        const n = { kind: 'symbol', s: d, group: [d] };
        bySentence.set(n, at);
        out.push(n);
      }
      const macros = [];
      for (const name of commandsIn(tex)) {
        const e = idx.byName.get(name);
        if (e) macros.push(e);
      }
      macros.sort((a, b) => a.count - b.count);
      for (const e of macros) out.push({ kind: 'macro', e });
      return out.slice(0, 5);
    }

    function noteHtml(n, el) {
      if (n.kind === 'symbol' && n.s.author) {
        const sym = `<span class="insight-sym" data-sym="${esc(n.s.tex)}"><code>${esc(n.s.tex)}</code></span>`;
        return `<div class="insight-note"><div class="insight-note-what">${sym}: </div>` +
          `<div class="insight-note-where">The author's description${n.s.everywhere ? '' : `, in <a href="#" data-go="s">${esc(where(n.s.el))}</a>`}</div>${popPinBtn('s:' + n.s.key, n.s.tex)}</div>`;
      }
      if (n.kind === 'symbol') {
        return `<div class="insight-note"><div class="insight-note-what"></div>` +
          `<div class="insight-note-where">${n.s.text ? `${n.group.map((d) => `<span class="insight-sym" data-sym="${esc(d.tex)}"><code>${esc(d.tex)}</code></span>`).join(', ')} introduced in` : 'Defined in'} <a href="#" data-go="s">${esc(where(n.s.el))}</a></div>${popPinBtn('s:' + n.s.key, n.s.tex)}</div>`;
      }
      const e = n.e;
      const sample = sampleOf(e);
      const first = e.first === el ? 'first used here' : `first used in <a href="#" data-go="m">${esc(where(e.first))}</a>`;
      return `<div class="insight-note"><div class="insight-note-what">${sample ? `<span class="insight-sym" data-sym="${esc(sample)}"></span> ` : ''}<code>${esc(definitionOf(e))}</code></div>` +
        `<div class="insight-note-where">Macro, ${first}${e.count > 1 ? ` · ${e.count} formulas` : ''}</div>${popPinBtn('m:' + e.name, '\\' + e.name)}</div>`;
    }

    function showNotes(el) {
      const notes = notesFor(el);
      if (!notes.length) return;
      const body = document_.createElement('div');
      body.className = 'ref-popover-body insight-pop-body';
      body.innerHTML = '<div class="insight-pop-title">Notation</div>' + notes.map((n) => noteHtml(n, el)).join('');
      const boxes = body.querySelectorAll('.insight-note');
      notes.forEach((n, k) => {
        const box = boxes[k];
        if (n.kind === 'symbol') box.querySelector('.insight-note-what').appendChild(shownOf(n.s, n.group.map((d) => d.el)));
        const go = box.querySelector('a[data-go]');
        if (go) go._target = n.kind === 'symbol' ? n.s.el : n.e.first;
      });
      renderSymbols(body);
      if (pop.parentNode !== document_.body) document_.body.appendChild(pop);
      pop.replaceChildren(body);
      pop.hidden = false;
      popFor = el;
      const width = Math.min(520, window.innerWidth - 32);
      pop.style.width = width + 'px';
      // below or above, whichever fits; capped to the window and scrolled when it fits on neither side
      placePop(el);
    }

    doc.addEventListener('mouseover', (e) => {
      if (!hoverOn) return;
      const el = e.target.closest && e.target.closest('.math[data-tex]');
      if (!el || el.closest(INSIDE_POPOVER)) return;
      if (el === popFor) { clearTimeout(hideTimer); return; }
      clearTimeout(showTimer);
      under = el;
      showTimer = setTimeout(() => {
        if (under === el) {
          hidePop();
          showNotes(el);
        }
      }, opts.delay != null ? opts.delay : 500);
    });
    doc.addEventListener('mouseout', (e) => {
      const el = e.target.closest && e.target.closest('.math[data-tex]');
      if (!el || el.contains(e.relatedTarget)) return;
      if (under === el) under = null;
      clearTimeout(showTimer);
      if (el === popFor && !pop.contains(e.relatedTarget)) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => hidePop(true), 250);
      }
    });
    // a bottom sheet on a touch screen (src/popover.js) was closed by a tap outside or a swipe
    pop.addEventListener('tg-sheet-close', () => hidePop());
    pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pop.addEventListener('mouseleave', (e) => {
      if (popFor && popFor.contains(e.relatedTarget)) return;
      hideTimer = setTimeout(() => hidePop(true), 250);
    });
    pop.addEventListener('click', (e) => {
      const pin = e.target.closest('[data-pop-pin]');
      if (pin) {
        // pin a symbol or macro from its preview: it joins the Notation tab's pinned rows
        e.preventDefault();
        togglePin(pin.dataset.popPin);
        setPinPressed(pin, pinned.has(pin.dataset.popPin), pin.dataset.what);
        return;
      }
      const a = e.target.closest('a[data-go]');
      if (!a || !a._target) return;
      e.preventDefault();
      const t = a._target;
      hidePop();
      opts.jump(t);
    });
    document_.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) hidePop();
    });
    doc.addEventListener('mousedown', () => { clearTimeout(showTimer); });
    (doc.closest('.pane') || window).addEventListener('scroll', () => { if (!pop.hidden) hidePop(); }, { passive: true });

    // --- previews of the results in the map ------------------------------------------
    //
    // Resting on a node of the map, in the side panel or in the larger map, shows the
    // result itself, as a reference link in the text does. The preview is a copy of
    // the rendered statement, made only when the pointer rests on a node.

    function showResult(g, view) {
      const n = g.dataset.c != null ? view.body._cites && view.body._cites[Number(g.dataset.c)]
        : g.dataset.e != null ? view.body._eqs && view.body._eqs[Number(g.dataset.e)]
          : view.body._nodes && view.body._nodes[Number(g.dataset.n)];
      if (!n || !n.el || !n.el.isConnected) return;
      const body = document_.createElement('div');
      body.className = 'ref-popover-body dep-preview';
      const text = document_.createElement('div');
      text.className = 'document dep-preview-text';
      if (n.cite) {
        // an entry of the bibliography, kept in a list of its own
        const list = document_.createElement('ol');
        list.className = 'dep-preview-bib';
        list.appendChild(copyOf(n.el));
        const sec = document_.createElement('section');
        sec.className = 'bibliography';
        sec.appendChild(list);
        text.appendChild(sec);
      } else text.appendChild(copyOf(n.el));
      body.appendChild(text);
      // a modal dialog sits above the page, so the preview goes inside it there
      const host = g.closest('dialog') || document_.body;
      if (pop.parentNode !== host) host.appendChild(pop);
      pop.replaceChildren(body);
      pop.hidden = false;
      popFor = g;
      popView = view;
      let width = Math.min(560, window.innerWidth - 32);
      pop.style.width = width + 'px';
      let extra = 0;
      body.querySelectorAll('.math-display, .tg-diagram').forEach((el) => {
        extra = Math.max(extra, el.scrollWidth - el.clientWidth);
      });
      if (extra > 0) {
        width = Math.min(width + extra + 2, window.innerWidth - 32);
        pop.style.width = width + 'px';
      }
      // below or above, whichever fits; capped to the window and scrolled when it fits on neither side
      placePop(g);
    }

    function wirePreviews(view) {
      let over = null;
      view.body.addEventListener('mouseover', (e) => {
        const g = e.target.closest && e.target.closest('.dep-node');
        if (!g) return;
        if (g === popFor) { clearTimeout(hideTimer); return; }
        clearTimeout(showTimer);
        over = g;
        showTimer = setTimeout(() => {
          if (over === g && g.isConnected) {
            hidePop();
            showResult(g, view);
          }
        }, opts.nodeDelay != null ? opts.nodeDelay : 300);
      });
      view.body.addEventListener('mouseout', (e) => {
        const g = e.target.closest && e.target.closest('.dep-node');
        if (!g || g.contains(e.relatedTarget)) return;
        if (over === g) over = null;
        clearTimeout(showTimer);
        if (g === popFor && !pop.contains(e.relatedTarget)) {
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => hidePop(true), 250);
        }
      });
      view.body.addEventListener('mousedown', () => clearTimeout(showTimer));
      view.body.addEventListener('scroll', () => { if (popView === view) hidePop(); }, { passive: true, capture: true });
    }

    // a link inside a previewed result goes where it points, as in the text
    pop.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a || a.matches('[data-go]')) return;
      const t = document_.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
      if (!t) return;
      e.preventDefault();
      const v = popView;
      hidePop();
      if (v) v.leave();
      opts.jump(t);
    });

    // --- "Used in" under a reference preview ---------------------------------------

    function usedByNote(target) {
      if (!feats.map) return null;
      if (!target || !target.classList || !target.classList.contains('theorem')) return null;
      const n = getGraph().byEl.get(target);
      if (!n || (!n.usedBy.size && !n.uses.size)) return null;
      const div = document_.createElement('div');
      div.className = 'insight-usedby';
      const list = (set) => Array.from(set).sort((a, b) => a.order - b.order).slice(0, 8).map((m) => `<a href="#${esc(m.id)}">${esc(m.name)}</a>`).join(', ') + (set.size > 8 ? `, and ${set.size - 8} more` : '');
      const rows = [];
      if (n.uses.size) rows.push(`<span class="insight-usedby-k">Uses</span> ${list(n.uses)}`);
      if (n.usedBy.size) rows.push(`<span class="insight-usedby-k">Used in</span> ${list(n.usedBy)}`);
      div.innerHTML = rows.join('<br>');
      return div;
    }

    // --- views: the side panel's Map and Notation tabs, and the large dialog --------

    // A view is a place the notation index or the map is drawn in:
    // { body, tab, selected, side, leave() } where leave() runs before a jump.
    const views = new Set();

    function wire(view) {
      const body = view.body;
      body.addEventListener('click', (e) => {
        const go = e.target.closest('[data-go]');
        if (go && go._target) {
          e.preventDefault();
          view.leave();
          opts.jump(go._target);
          return;
        }
        const pinB = e.target.closest('[data-pin]');
        if (pinB) {
          e.preventDefault();
          togglePin(pinB.dataset.pin);
          return;
        }
        if (e.target.closest('[data-pin-used]')) {
          e.preventDefault();
          setUsedPinned(!usedPinned, true);
          return;
        }
        const chip = e.target.closest('[data-chip]');
        if (chip) {
          e.preventDefault();
          showRow(view, chip.dataset.chip);
          return;
        }
        const ord = e.target.closest('[data-order]');
        if (ord) {
          e.preventDefault();
          setNotationOrder(ord.dataset.order, true);
          return;
        }
        if (e.target.closest('.dep-larger')) {
          e.preventDefault();
          open('deps', view.selected);
          return;
        }
        if (e.target.closest('.dep-unfocus')) {
          e.preventDefault();
          unfocus();
          return;
        }
        if (!e.target.closest('.dep-node')) view.lastNodeClick = null; // a double click is two on the node, nothing between
        if (mapClick(view, e)) return;
        const fold = e.target.closest('[data-fold]');
        if (fold) {
          e.preventDefault();
          hidePop();
          toggleFold(view, fold.dataset.fold);
          return;
        }
        const node = e.target.closest('.dep-node, [data-pick]');
        if (node) {
          e.preventDefault();
          if (view.dragged) return; // the end of a drag
          if (view.linking && node.dataset.c == null && node.dataset.e == null) {
            view.lastNodeClick = null;
            // drawing the reader's own arrow: this is the other end
            const other = view.body._nodes[Number(node.dataset.n != null ? node.dataset.n : node.dataset.pick)];
            const from = getGraph().byKey.get(view.linking.key);
            const dir = view.linking.dir;
            view.linking = null;
            if (other && from && other !== from) {
              if (dir === 'uses') addLink(other.key, from.key);
              else addLink(from.key, other.key);
            } else fillDeps(view);
            return;
          }
          if (node.matches('.dep-node') && twice(view, node, e)) return;
          if (node.dataset.c != null) selectCite(view, Number(node.dataset.c));
          else if (node.dataset.e != null) selectEq(view, Number(node.dataset.e));
          else pick(view, Number(node.dataset.n != null ? node.dataset.n : node.dataset.pick));
        }
      });
      body.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const fold = e.target.closest && e.target.closest('.dep-fold');
        if (fold) { e.preventDefault(); toggleFold(view, fold.dataset.fold); return; }
        const node = e.target.closest && e.target.closest('.dep-node');
        if (!node) return;
        e.preventDefault();
        if (node.dataset.c != null) selectCite(view, Number(node.dataset.c));
        else if (node.dataset.e != null) selectEq(view, Number(node.dataset.e));
        else pick(view, Number(node.dataset.n));
      });
      body.addEventListener('input', (e) => {
        if (e.target.matches('.insight-filter')) filterNotation(view, e.target.value);
      });
      body.addEventListener('change', (e) => {
        if (e.target.matches('.insight-hover input')) setHover(e.target.checked, true);
        if (e.target.matches('.dep-opts input[data-lock]')) { setLocked(e.target.checked, true); return; }
        if (e.target.matches('.dep-opts input[data-opt]')) {
          mapOpts[e.target.dataset.opt] = e.target.checked;
          if (e.target.dataset.opt === 'fold') for (const v of views) v.expanded = new Set();
          for (const v of views) if (v.tab === 'deps' && v.isShown()) fillDeps(v);
        }
      });
      // pinned rows: drag a handle (mouse, pen or finger) or press ↑ ↓ on it to reorder
      body.addEventListener('pointerdown', (e) => {
        const h = e.target.closest && e.target.closest('.insight-drag');
        if (!h || e.button > 0) return;
        const item = h.closest('.insight-pin-item');
        const list = item.parentElement;
        const box = list.closest('.insight-stuck');
        e.preventDefault();
        item.classList.add('insight-dragging');
        const before = Array.from(list.children).map((x) => x.dataset.pinItem).join('\n');
        let lastY = e.clientY;
        let scroller = null;
        const place = () => {
          for (const other of list.children) {
            if (other === item) continue;
            const r = other.getBoundingClientRect();
            if (lastY < r.top + r.height / 2) {
              if (item.nextElementSibling !== other) list.insertBefore(item, other);
              return;
            }
          }
          if (list.lastElementChild !== item) list.appendChild(item);
        };
        // near the edge of the pinned block (when it scrolls), scroll it
        const edge = () => {
          if (!box || box.scrollHeight <= box.clientHeight) return;
          const r = box.getBoundingClientRect();
          const d = lastY < r.top + 24 ? -8 : lastY > r.bottom - 24 ? 8 : 0;
          if (d) { box.scrollTop += d; place(); }
        };
        const move = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          ev.preventDefault();
          lastY = ev.clientY;
          place();
          if (!scroller) scroller = setInterval(edge, 30);
        };
        const up = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          win.removeEventListener('pointermove', move);
          win.removeEventListener('pointerup', up);
          win.removeEventListener('pointercancel', up);
          clearInterval(scroller);
          item.classList.remove('insight-dragging');
          const order = Array.from(list.children).map((x) => x.dataset.pinItem);
          if (order.join('\n') !== before) orderPins(order);
        };
        // on the window: moving the row in the list can drop the pointer capture
        const win = document_.defaultView || window;
        win.addEventListener('pointermove', move, { passive: false });
        win.addEventListener('pointerup', up);
        win.addEventListener('pointercancel', up);
      });
      body.addEventListener('keydown', (e) => {
        const h = e.target.closest && e.target.closest('.insight-drag');
        if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const item = h.closest('.insight-pin-item');
        const keys = Array.from(item.parentElement.children).map((x) => x.dataset.pinItem);
        const k = keys.indexOf(item.dataset.pinItem);
        const j = e.key === 'ArrowUp' ? k - 1 : k + 1;
        if (j < 0 || j >= keys.length) return;
        [keys[k], keys[j]] = [keys[j], keys[k]];
        orderPins(keys, item.dataset.pinItem);
      });
      // a group folded by hand stays folded when the list is drawn again
      body.addEventListener('toggle', (e) => {
        const g = e.target;
        if (!g.matches || !g.matches('.insight-group') || g.dataset.searchOpened) return;
        if (!view.closedGroups) view.closedGroups = new Set();
        if (g.open) view.closedGroups.delete(g.dataset.group);
        else view.closedGroups.add(g.dataset.group);
      }, true);
      // "Used in …" follows the reader from section to section
      if (view.side) {
        let queued = false;
        (doc.closest('.pane') || window).addEventListener('scroll', () => {
          if (queued || !view.isShown() || view.tab !== 'notation') return;
          queued = true;
          setTimeout(() => { queued = false; if (view.isShown() && view.tab === 'notation') fillUsed(view); }, 150);
        }, { passive: true });
      }
      body.addEventListener('keydown', (e) => {
        if (e.target.matches && e.target.matches('.dep-view-name')) {
          if (e.key === 'Enter') { e.preventDefault(); if (saveView(e.target.value)) view.naming = false; else e.target.focus(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); view.naming = false; fillDeps(view); }
          return;
        }
        if (e.key === 'Escape' && view.linking) { e.preventDefault(); e.stopPropagation(); view.linking = null; fillDeps(view); }
        if (e.key === 'Escape' && view.confirmReset) { e.preventDefault(); e.stopPropagation(); view.confirmReset = false; fillDeps(view); }
        if (mapUndoKey(e)) e.stopPropagation();
      });
      wirePreviews(view);
      wireMapMoves(view);
      wireNodeDrag(view);
      views.add(view);
    }

    function fill(view) {
      const t0 = Date.now();
      try {
        if (view.tab === 'deps') fillDeps(view);
        else fillNotation(view);
      } catch (e) {
        // One odd symbol or result must never leave the side panel stuck: say
        // so in the tab and keep the rest of the page (and the other tabs) working.
        if (typeof console !== 'undefined') console.error('TeXglass: could not draw the ' + (view.tab === 'deps' ? 'map' : 'notation list'), e);
        view.body.innerHTML = '<p class="insight-empty insight-failed">Could not draw this tab for this paper.</p>';
      }
      view.body.dataset.ms = String(Date.now() - t0);
    }

    const hoverBox = () =>
      `<label class="insight-hover"><input type="checkbox"${hoverOn ? ' checked' : ''}> Show notation when resting on a formula</label>`;

    // How the notation index is arranged: by the section where each symbol is
    // first defined, by kind, or A–Z (the reader's choice is kept by the host).
    const ORDERS = [['section', 'Section', 'Under the section where each symbol is first defined or used'], ['kind', 'Kind', 'Spaces and sets, maps and operators, named functions, constants'], ['az', 'A–Z', 'Alphabetically, Greek letters together']];
    let notationOrder = ORDERS.some(([k]) => k === opts.notationOrder) ? opts.notationOrder : 'section';

    /** The top-level sections, to group by: [{ el, label }], and where an element sits. */
    function topSections() {
      const top = doc.querySelector('h1.chapter, h2.chapter') ? 'chapter' : 'section';
      return Array.from(doc.querySelectorAll(`.${top}[id], h1.appendix[id], h2.appendix[id]`))
        .filter((h) => /^H[1-6]$/.test(h.tagName) && !h.closest(INSIDE_POPOVER))
        .map((h, k) => {
          const t = plainText(h);
          const num = h.querySelector('.secnum');
          const n = num ? num.textContent.trim() : '';
          const label = n ? `§${n} ${t.slice(n.length).trim()}` : t;
          return { el: h, label: label.length > 60 ? label.slice(0, 58) + '…' : label, order: k + 1 };
        });
    }
    const OPENING = { el: null, label: 'Opening pages', order: 0 };
    function sectionOf(secs, el) {
      let lo = 0;
      let hi = secs.length - 1;
      let found = OPENING;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (secs[mid].el.compareDocumentPosition(el) & 4) { found = secs[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return found;
    }

    /** The words just after a symbol introduced in the text (then just before), within its sentence. */
    function wordsNear(s) {
      if (!s || !s.text || !s.run) return [];
      const t = s.run.text;
      const [a, b] = sentenceAround(t, s.at);
      const clean = (x) => x.replace(/[\u0001]/g, ' ');
      return [clean(t.slice(s.at + 1, Math.min(b, s.at + 90))), clean(t.slice(Math.max(a, s.at - 60), s.at))];
    }

    /** The index's rows, each { id, type, it, first, text, section, kind, alpha }, kept with the index. */
    function entriesOf(idx) {
      if (idx.entries) return idx.entries;
      const secs = topSections();
      const byKey = new Map();
      for (const s of idx.symbols) if ((s.text || s.author) && !byKey.has(s.key)) byKey.set(s.key, s);
      const out = [];
      idx.macros.forEach((e, k) => {
        const said = byKey.get(texTokens('\\' + e.name).join(' '));
        const body = String(e.mac.body);
        out.push({
          id: 'm' + k, type: 'm', it: e, first: e.first, pin: 'm:' + e.name,
          text: (e.name + ' ' + body + (said ? ' ' + (said.author ? said.words : sentenceText(said)) : '')).toLowerCase(),
          section: sectionOf(secs, e.first),
          kind: kindOfSymbol('\\' + e.name, said && said.author ? [said.words, ''] : wordsNear(said), body, e.mac.nargs || 0, ''),
          alpha: ((a) => (a.group === 'Other' ? alphaOf('\\' + e.name) : a))(alphaOf(body)),
        });
      });
      idx.symbols.forEach((s, k) => {
        out.push({
          id: 's' + k, type: 's', it: s, first: s.el, pin: 's:' + s.key,
          text: (s.author ? s.tex + ' ' + s.words : s.text ? s.tex + ' ' + sentenceText(s) : s.el.dataset.tex).toLowerCase(),
          section: sectionOf(secs, s.el),
          kind: kindOfSymbol(s.tex, s.author ? [s.words, ''] : wordsNear(s), '', 0, s.text || s.author ? '' : s.el.dataset.tex),
          alpha: alphaOf(s.tex.replace(/^\\([A-Za-z]+)(?![A-Za-z])/, (m, n) => (idx.byName.has(n) && !idx.byName.get(n).mac.nargs ? String(idx.byName.get(n).mac.body) : m))),
        });
      });
      idx.entries = out;
      idx.secs = secs;
      return out;
    }

    /** The rows sorted into groups for an order: [{ id, title, rows }]. */
    function groupsOf(entries, order) {
      const groups = new Map();
      const add = (id, title, sort, e) => {
        if (!groups.has(id)) groups.set(id, { id, title, sort, rows: [] });
        groups.get(id).rows.push(e);
      };
      const docOrder = (a, b) => (a.first === b.first ? 0 : a.first.compareDocumentPosition(b.first) & 4 ? -1 : 1);
      const sorted = entries.slice().sort(docOrder);
      for (const e of sorted) {
        if (order === 'kind') {
          const k = KINDS.findIndex(([id]) => id === e.kind);
          add('kind-' + e.kind, KINDS[k][1], k, e);
        } else if (order === 'az') {
          const g = e.alpha.group;
          add('az-' + g, g, g === 'Greek' ? 1000 : g === 'Other' ? 1001 : g.charCodeAt(0), e);
        } else add('sec-' + e.section.order, e.section.label, e.section.order, e);
      }
      const out = Array.from(groups.values()).sort((a, b) => a.sort - b.sort);
      if (order === 'az') for (const g of out) g.rows.sort((a, b) => (a.alpha.key < b.alpha.key ? -1 : a.alpha.key > b.alpha.key ? 1 : 0));
      return out;
    }

    /** The pin on a notation preview: pins the symbol (or macro) to the Notation tab. */
    function popPinBtn(key, what) {
      const on = pinned.has(key);
      return `<button type="button" class="insight-pin insight-pop-pin" data-pop-pin="${esc(key)}" data-what="${esc(what)}" aria-pressed="${on}" title="${on ? 'Pinned: click to unpin' : 'Pin it: it stays at the top of the Notation tab and joins the Pinned list'}" aria-label="${on ? 'Unpin' : 'Pin'} ${esc(what)}">${PIN_ICON}</button>`;
    }
    function setPinPressed(b, on, what) {
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Pinned: click to unpin' : 'Pin it';
      b.setAttribute('aria-label', (on ? 'Unpin ' : 'Pin ') + (what || ''));
    }
    /**
     * A pin for a reference's preview: pins the result or numbered equation
     * `target` (as the map's pin does), or null if it is neither.
     */
    function pinButtonFor(target) {
      if (!target || !target.closest) return null;
      const el = target.closest('.theorem') || target.closest('.math-display');
      const key = el && keyOfEl(el);
      if (!key) return null;
      const n = key.startsWith('eq:') ? null : getGraph().byKey.get(key);
      const what = n ? n.name : eqNameOf(el);
      const b = document_.createElement('button');
      b.type = 'button';
      b.className = 'insight-pin insight-pop-pin tg-ref-pin';
      b.innerHTML = PIN_ICON;
      const sync = () => {
        const on = pinMap().has(key);
        setPinPressed(b, on, what);
        b.title = on ? `${what} is pinned: click to unpin` : `Pin ${what}: it joins the Pinned list and the map`;
      };
      sync();
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setPin(key, pinMap().has(key) ? '' : 'self');
        sync();
      });
      return b;
    }

    // Rows the reader pinned stay at the top of the tab (kept per paper by the host).
    const PIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5h4l-.6 4.2 2.6 2.6v1.2H4V8.3l2.6-2.6z M8 9.5V14.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    const readPins = () => {
      try {
        const v = opts.pins && opts.pins.get();
        return new Set(Array.isArray(v) ? v : []);
      } catch (e) { return new Set(); }
    };
    let pinned = readPins();
    const pinBtn = (key, what) => {
      const on = pinned.has(key);
      return `<button type="button" class="insight-pin" data-pin="${esc(key)}" aria-pressed="${on}" title="${on ? 'Unpin' : 'Pin to the top of the list'}" aria-label="${on ? 'Unpin' : 'Pin'} ${esc(what)}">${PIN_ICON}</button>`;
    };
    function togglePin(key) {
      if (pinned.has(key)) pinned.delete(key);
      else pinned.add(key);
      try { if (opts.pins) opts.pins.set(Array.from(pinned)); } catch (e) { /* keep it for this visit */ }
      for (const v of views) if (v.tab === 'notation' && v.isShown()) fillNotation(v);
      pinsChanged();
    }
    /** Keep the pinned rows in this order (keys; pins left out keep their place after them). */
    function orderPins(keys, focusKey) {
      const next = new Set(keys.filter((k) => pinned.has(k)));
      for (const k of pinned) next.add(k);
      if (Array.from(next).join('\n') === Array.from(pinned).join('\n')) return;
      pinned = next;
      try { if (opts.pins) opts.pins.set(Array.from(pinned)); } catch (e) { /* keep it for this visit */ }
      pinsChanged();
      for (const v of views) {
        if (v.tab !== 'notation' || !v.isShown()) continue;
        fillNotation(v);
        if (focusKey) {
          for (const h of v.body.querySelectorAll('.insight-pin-item .insight-drag')) if (h.closest('.insight-pin-item').dataset.pinItem === focusKey) h.focus();
        }
      }
    }
    const GRIP_ICON = '<svg viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></g></svg>';
    /** The Pinned group: each row with a handle to drag it up or down. */
    function pinnedHtmlOf(view, pins) {
      const open = !(view.closedGroups && view.closedGroups.has('pinned'));
      const item = (e) => {
        const what = e.type === 'm' ? '\\' + e.it.name : e.it.tex;
        const row = e.type === 'm' ? `<table class="insight-table"><tbody>${macroRow(e.it, e.id)}</tbody></table>` : `<ol class="insight-symbols">${symbolRow(e.it, e.id)}</ol>`;
        return `<div class="insight-pin-item" data-pin-item="${esc(e.pin)}">` +
          (pins.length > 1 ? `<button type="button" class="insight-drag" title="Drag to reorder (or press ↑ ↓)" aria-label="Move ${esc(what)} up or down">${GRIP_ICON}</button>` : '') +
          `<div class="insight-pin-body">${row}</div></div>`;
      };
      return `<details class="insight-group insight-group-pinned" data-group="pinned"${open ? ' open' : ''}><summary>Pinned <span class="insight-count">${pins.length}</span></summary>` +
        `<div class="insight-pin-list">${pins.map(item).join('')}</div></details>`;
    }

    // "Used in …" can be pinned too (kept for every paper)
    let usedPinned = !!opts.usedPinned;
    function setUsedPinned(on, fromUi) {
      on = !!on;
      if (on === usedPinned) return;
      usedPinned = on;
      for (const v of views) if (v.tab === 'notation' && v.isShown()) fillNotation(v);
      if (fromUi && opts.onUsedPinned) opts.onUsedPinned(on);
    }

    function macroRow(e, id) {
      const sample = sampleOf(e);
      const body = String(e.mac.body);
      return `<tr data-k="${id}"><td class="insight-sym-cell">${sample ? `<span class="insight-sym" data-sym="${esc(sample)}"></span>` : ''}</td>` +
        `<td class="insight-cmd"><code>\\${esc(e.name)}</code></td><td class="insight-def"><code>${esc(body.length > 90 ? body.slice(0, 87) + '…' : body)}</code></td>` +
        `<td class="insight-first"><a href="#" data-go="" data-e="${id}">${esc(where(e.first))}</a><span class="insight-uses">${e.count} formula${e.count > 1 ? 's' : ''}</span>${pinBtn('m:' + e.name, '\\' + e.name)}</td></tr>`;
    }
    function symbolRow(s, id) {
      return `<li data-k="${id}"><span class="insight-sym" data-sym="${esc(s.tex)}"><code>${esc(s.tex)}</code></span><span class="insight-sym-src"></span><span class="insight-row-end"><a href="#" data-go="" data-e="${id}">${esc(where(s.el))}</a>${pinBtn('s:' + s.key, s.tex)}</span></li>`;
    }
    function groupHtml(view, g, extra) {
      const ms = g.rows.filter((e) => e.type === 'm');
      const ss = g.rows.filter((e) => e.type === 's');
      const open = !(view.closedGroups && view.closedGroups.has(g.id));
      return `<details class="insight-group${extra || ''}" data-group="${esc(g.id)}"${open ? ' open' : ''}><summary>${esc(g.title)} <span class="insight-count">${g.rows.length}</span></summary>` +
        (ms.length ? `<table class="insight-table"><tbody>${ms.map((e) => macroRow(e.it, e.id)).join('')}</tbody></table>` : '') +
        (ss.length ? `<ol class="insight-symbols">${ss.map((e) => symbolRow(e.it, e.id)).join('')}</ol>` : '') +
        '</details>';
    }

    // --- "Used here": the notation of the section being read --------------------------

    /** The section the reader is in: the last top-level heading above the upper third of the window. */
    function readingSection(idx) {
      const secs = idx.secs || [];
      if (!secs.length) return null;
      const pane = doc.closest('.pane');
      const win = document_.defaultView || window;
      const top = pane ? pane.getBoundingClientRect().top : 0;
      const h = pane ? pane.clientHeight : win.innerHeight;
      const line = top + Math.min(160, h * 0.3);
      let cur = OPENING;
      for (const s of secs) {
        if (s.el.getBoundingClientRect().top <= line) cur = s;
        else break;
      }
      return cur;
    }

    /** The rows whose symbols appear in a section's formulas (or are defined there), in index order. */
    function usedIn(idx, sec) {
      if (!idx.usedCache) idx.usedCache = new Map();
      if (idx.usedCache.has(sec.order)) return idx.usedCache.get(sec.order);
      const entries = entriesOf(idx);
      const secs = idx.secs;
      const k = secs.indexOf(sec);
      const start = sec.el;
      const end = k >= 0 && k + 1 < secs.length ? secs[k + 1].el : null;
      const inside = (el) => (!start || start.compareDocumentPosition(el) & 4) && (!end || el.compareDocumentPosition(end) & 4);
      const names = new Set();
      const keys = new Set();
      for (const el of formulas(doc)) {
        if (!inside(el)) continue;
        for (const n of commandsIn(el.dataset.tex)) names.add(n);
        if (el.dataset.tex.length < 2000) for (const d of definitionsUsed(idx.defs, el)) keys.add(d.key);
      }
      let used = entries.filter((e) => (e.type === 'm' ? names.has(e.it.name) : keys.has(e.it.key) || inside(e.it.el)));
      // a symbol that is only one of the macros with its argument (\norm{x} beside \norm) once
      const macs = new Set(used.filter((e) => e.type === 'm').map((e) => '\\' + e.it.name));
      used = used.filter((e) => {
        if (e.type === 'm') return true;
        const t = texTokens(e.it.tex);
        return !(macs.has(t[0]) && (t.length <= 2 || (t[1] === '{' && t[t.length - 1] === '}' && t.slice(2, -1).every((x) => x !== '{' && x !== '}'))));
      });
      idx.usedCache.set(sec.order, used);
      return used;
    }

    /** Redraw the "Used here" group when the reader moves to another section. */
    function fillUsed(view) {
      const box = view.body.querySelector('.insight-used');
      if (!box) return;
      const idx = getIndex();
      const sec = readingSection(idx);
      const key = sec ? String(sec.order) : '';
      if (box.dataset.sec === key && box.childNodes.length) return;
      box.dataset.sec = key;
      const rows = sec ? usedIn(idx, sec) : [];
      if (!rows.length) { box.innerHTML = ''; return; }
      const open = !(view.closedGroups && view.closedGroups.has('used'));
      const chip = (e) => {
        const tex = e.type === 'm' ? sampleOf(e.it) : e.it.tex;
        const hint = e.type === 'm' ? `\\${e.it.name} → ${e.it.mac.body}` : e.it.author ? e.it.words : e.it.text ? sentenceText(e.it) : e.it.el.dataset.tex;
        const label = e.type === 'm' ? '\\' + e.it.name : e.it.tex;
        return `<button type="button" class="insight-chip" data-chip="${e.id}" title="${esc(hint.length > 160 ? hint.slice(0, 158) + '…' : hint)}" aria-label="${esc(label)}">` +
          (tex ? `<span class="insight-sym" data-sym="${esc(tex)}"><code>${esc(label)}</code></span>` : `<code>${esc(label)}</code>`) + '</button>';
      };
      box.innerHTML = `<details class="insight-group insight-group-used" data-group="used"${open ? ' open' : ''}>` +
        `<summary>Used in ${esc(sec.label)} <span class="insight-count">${rows.length}</span>` +
        `<button type="button" class="insight-pin" data-pin-used="" aria-pressed="${usedPinned}" title="${usedPinned ? 'Unpin: let it scroll with the list' : 'Pin: keep it in view while the list scrolls'}" aria-label="${usedPinned ? 'Unpin' : 'Pin'} Used in">${PIN_ICON}</button></summary>` +
        `<div class="insight-chips">${rows.map(chip).join('')}</div></details>`;
      renderSymbols(box);
      if (view.query) filterNotation(view, view.query);
    }

    /** Show a symbol's row in the list: open its group, scroll to it and flash it. */
    function showRow(view, id) {
      let row = null;
      view.body.querySelectorAll(`[data-k="${id}"]`).forEach((r) => { if (!r.closest('.insight-used, .insight-pinned')) row = r; });
      if (!row) return;
      if (row.hidden || row.closest('.insight-group[hidden]')) {
        const f = view.body.querySelector('.insight-filter');
        if (f) f.value = '';
        filterNotation(view, '');
      }
      const g = row.closest('.insight-group');
      if (g && !g.open) g.open = true;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('insight-flash');
      void row.offsetWidth;
      row.classList.add('insight-flash');
      setTimeout(() => row.classList.remove('insight-flash'), 1600);
    }

    /** Make the rows' links jump, draw their symbols and sentences. */
    function finishRows(view, root) {
      const idx = getIndex();
      const byId = new Map(entriesOf(idx).map((e) => [e.id, e]));
      root.querySelectorAll('a[data-e]').forEach((a) => {
        const e = byId.get(a.dataset.e);
        if (!e) return;
        a._target = e.first;
        if (e.type === 's') a.closest('li').querySelector('.insight-sym-src').appendChild(shownOf(e.it));
        const row = a.closest('[data-k]');
        row.dataset.text = e.text;
      });
      renderSymbols(root);
    }

    function fillNotation(view) {
      const body = view.body;
      const idx = getIndex();
      if (!idx.macros.length && !idx.symbols.length) {
        body.innerHTML = '<p class="insight-empty">This document defines no notation of its own: no macros used in its formulas, and no symbols defined with := or in words such as "let X denote".</p>' + (view.side ? hoverBox() : '');
        return;
      }
      const entries = entriesOf(idx);
      const q = view.query || '';
      let html = '<div class="insight-tools">' +
        `<input class="insight-filter" type="search" placeholder="Search by symbol or meaning" aria-label="Search the notation by symbol or meaning" value="${esc(q)}">` +
        '<div class="insight-order" role="radiogroup" aria-label="Arrange the notation">' +
        ORDERS.map(([k, label, title]) => `<button type="button" role="radio" data-order="${k}" aria-checked="${k === notationOrder}" title="${esc(title)}">${label}</button>`).join('') +
        '</div></div>';
      pinned = readPins();
      // in the reader's order (they drag the rows to change it)
      const byPin = new Map(entries.map((e) => [e.pin, e]));
      const pins = Array.from(pinned).map((k) => byPin.get(k)).filter(Boolean);
      const pinnedHtml = pins.length ? `<div class="insight-pinned">${pinnedHtmlOf(view, pins)}</div>` : '';
      const usedHtml = view.side ? '<div class="insight-used"></div>' : '';
      // pinned rows (and "Used in …" when pinned) stay in view while the list scrolls
      if (view.side) html += `<div class="insight-stuck">${pinnedHtml}${usedPinned ? usedHtml : ''}</div>${usedPinned ? '' : usedHtml}`;
      else html += pinnedHtml;
      html += groupsOf(entries, notationOrder).map((g) => groupHtml(view, g)).join('');
      html += '<p class="insight-nomatch" hidden>Nothing matches. Try a command name (norm), a letter (alpha or α) or a word from the sentence that introduces the symbol.</p>';
      if (view.side) html += hoverBox();
      const keep = body.scrollTop;
      body.innerHTML = html;
      finishRows(view, body);
      if (view.side) fillUsed(view);
      if (q) filterNotation(view, q);
      body.scrollTop = keep;
    }

    function setNotationOrder(order, fromUi) {
      if (!ORDERS.some(([k]) => k === order) || order === notationOrder) return;
      notationOrder = order;
      for (const v of views) if (v.tab === 'notation' && v.isShown()) fillNotation(v);
      if (fromUi && opts.onNotationOrder) opts.onNotationOrder(order);
    }

    function filterNotation(view, raw) {
      view.query = raw;
      const q = greekQuery(raw.trim().toLowerCase()).replace(/^\\/, '');
      const body = view.body;
      body.classList.toggle('insight-searching', !!q);
      let any = false;
      body.querySelectorAll('.insight-group:not(.insight-group-pinned)').forEach((g) => {
        let n = 0;
        g.querySelectorAll('[data-text]').forEach((row) => {
          row.hidden = !!q && !row.dataset.text.includes(q);
          if (!row.hidden) n++;
        });
        const used = g.classList.contains('insight-group-used');
        const count = g.querySelector(':scope > summary .insight-count');
        if (count && !used) {
          if (!count.dataset.all) count.dataset.all = count.textContent;
          count.textContent = q ? String(n) : count.dataset.all;
        }
        g.hidden = !!q && (!n || used);
        if (q && n && !used) {
          // open groups with matches while searching, and close them again after
          if (!g.open) { g.open = true; g.dataset.searchOpened = '1'; }
          any = true;
        } else if (!q && g.dataset.searchOpened) {
          delete g.dataset.searchOpened;
          g.open = false;
        }
      });
      const none = body.querySelector('.insight-nomatch');
      if (none) none.hidden = !q || any;
    }

    // --- the reader's changes to the map ---------------------------------------------
    // Kept per paper by the host with the paper's notes (record.map, see
    // src/notes-sync.js), so they are exported and synced with them:
    // { pos, pin, hide, link, view }, each entry stamped with when it was set.

    const EDIT_PARTS = ['pos', 'pin', 'hide', 'link', 'view'];
    function readEdits() {
      let m = null;
      try { m = opts.edits ? opts.edits.get() : null; } catch (e) { m = null; }
      const out = {};
      for (const p of EDIT_PARTS) out[p] = m && m[p] && typeof m[p] === 'object' ? Object.assign({}, m[p]) : {};
      return out;
    }
    let edits = readEdits();
    let locked = !!opts.locked; // the reader locked the map: no dragging, hiding or link changes
    let eqCache = null;

    /** The numbered equations of the page: Map(key → element). */
    function eqEls() {
      if (eqCache) return eqCache;
      eqCache = new Map();
      for (const el of doc.querySelectorAll('.math-display')) {
        if (el.closest(INSIDE_POPOVER)) continue;
        const k = eqKeyOf(el);
        if (k && !eqCache.has(k)) eqCache.set(k, el);
      }
      return eqCache;
    }
    const pinMap = () => new Map(Object.entries(edits.pin).filter(([, e]) => e && e.d).map(([k, e]) => [k, e.d]));
    const hiddenSet = () => new Set(Object.entries(edits.hide).filter(([, e]) => e && e.h).map(([k]) => k));
    const posOf = () => {
      const out = {};
      for (const [k, e] of Object.entries(edits.pos)) if (e && Number.isFinite(e.x) && Number.isFinite(e.y)) out[k] = e;
      return out;
    };
    const savedViews = () => Object.entries(edits.view).filter(([, e]) => e && e.p && Object.keys(e.p).length).sort((a, b) => a[0].localeCompare(b[0]));

    /** The pinned equations, to draw on the map: [{ eq, key, el, name, order, usedBy }]. */
    function pinnedEqs(g) {
      const out = [];
      for (const k of pinMap().keys()) {
        if (!k.startsWith('eq:')) continue;
        const el = eqEls().get(k);
        if (!el) continue;
        const usedBy = new Set();
        for (const n of g.nodes) for (const r of [...n.refs.statement, ...n.refs.proof]) if (el === r || el.contains(r)) usedBy.add(n);
        // the section it sits in: that of the result before it (or else after it)
        let near = null;
        for (const n of g.nodes) { if (n.el.compareDocumentPosition(el) & 4) near = n; else { if (!near) near = n; break; } }
        out.push({ eq: true, key: k, el, name: eqNameOf(el), order: out.length, usedBy, section: near ? near.section : null });
      }
      return out;
    }

    /** The element a key names: a result, a cited work's entry, an equation. */
    function elOfKey(k) {
      if (k.startsWith('eq:')) return eqEls().get(k) || null;
      const x = getGraph().byKey.get(k);
      return x ? x.el : null;
    }
    /** The key of a result or a numbered equation element, or null. */
    function keyOfEl(el) {
      if (!el) return null;
      const n = getGraph().byEl.get(el);
      if (n) return n.key;
      const k = eqKeyOf(el);
      return k && eqEls().get(k) === el ? k : null;
    }

    /** The keys a pin brings along: what a result pinned with its uses (or used in) rests on. */
    function pinSubSet() {
      const out = new Set();
      const g = getGraph();
      for (const [k, d] of pinMap()) {
        if (d === 'self') continue;
        const n = g.byKey.get(k);
        if (!n || n.cite) continue;
        for (const m of closure(n, d)) out.add(m.key);
      }
      return out;
    }

    /**
     * What "Show pinned" shows: the pinned results and equations, and for a result
     * pinned with what it uses (or is used in), those results too, with the
     * equations, figures… it and their statements refer to, as "What does this use?" does.
     */
    function pinnedEls() {
      const g = getGraph();
      const out = new Set();
      for (const [k, d] of pinMap()) {
        const x = k.startsWith('eq:') ? { el: eqEls().get(k) } : g.byKey.get(k);
        if (!x || !x.el || !doc.contains(x.el) || x.cite) continue;
        out.add(x.el);
        if (d === 'self' || !x.refs) continue;
        const others = closure(x, d);
        for (const m of others) out.add(m.el);
        if (d !== 'usedBy') {
          const refs = new Set([...x.refs.statement, ...x.refs.proof]);
          for (const m of others) for (const r of m.refs.statement) refs.add(r);
          for (const r of refs) {
            const b = blockOf(r);
            if (doc.contains(b) && !b.closest('.proof')) out.add(b);
          }
        }
      }
      return Array.from(out);
    }

    /** Keep a change: part 'pos' | 'pin' | 'hide' | 'link' | 'view', key, its new value. */
    function setEdit(part, key, value, quiet) {
      edits = Object.assign({}, edits, { [part]: Object.assign({}, edits[part], { [key]: Object.assign({}, value, { t: new Date().toISOString() }) }) });
      if (!quiet) editsChanged(part);
    }
    function saveEdits() {
      try { if (opts.edits) opts.edits.set(edits); } catch (e) { /* keep them for this visit */ }
    }
    // Undo and redo: each change the reader makes is one step (a drag, a pin, a
    // reset…), kept for this visit. Undoing writes the old values again, with new
    // stamps, so that the undo wins when copies merge on another device.
    let committed = edits; // the changes as of the last step
    const undoStack = []; // [{ edits, label }]
    const redoStack = [];
    let note = null; // { text, kind: 'undo' | 'redo' }: what just happened, shown for a moment
    let noteTimer = null;
    /** One entry's meaning, without its stamp: null when it changes nothing. */
    const meaning = (part, e) => {
      if (!e) return null;
      if (part === 'pos') return Number.isFinite(e.x) && Number.isFinite(e.y) ? e.x + ',' + e.y : null;
      if (part === 'pin') return e.d || null;
      if (part === 'hide') return e.h ? '1' : null;
      if (part === 'link') return e.s || null;
      return e.p && Object.keys(e.p).length ? JSON.stringify(Object.entries(e.p).sort()) : null;
    };
    /** The entries two copies of the changes differ in: [[part, key]]. */
    function diff(a, b) {
      const out = [];
      for (const p of EDIT_PARTS) {
        for (const k of new Set([...Object.keys(a[p] || {}), ...Object.keys(b[p] || {})])) {
          if (meaning(p, (a[p] || {})[k]) !== meaning(p, (b[p] || {})[k])) out.push([p, k]);
        }
      }
      return out;
    }
    /** What a key is called: "Lemma 2", "equation (3.1)". */
    function nameOfKey(k) {
      if (k.startsWith('eq:')) return 'equation ' + k.slice(3);
      const x = getGraph().byKey.get(k);
      if (x) return x.cite ? `${x.label} ${x.who}`.trim() : x.name;
      return k.replace(/^(label|name|cite):/, '');
    }
    const WITH = { uses: ' with what it uses', usedBy: ' with what uses it', both: ' with what it uses and what uses it' };
    /** "Hid Lemma 2": a step in words, from the copies before and after it. */
    function describe(a, b) {
      const ch = diff(a, b);
      if (!ch.length) return '';
      const parts = new Set(ch.map(([p]) => p));
      if (parts.size > 1) return 'Changed the map';
      const [p, k] = ch[0];
      const n = ch.length;
      const v = (b[p] || {})[k] || {};
      if (p === 'pos') return n > 1 ? (Number.isFinite(v.x) ? `Moved ${n} results` : 'Put the results back') : (Number.isFinite(v.x) ? `Moved ${nameOfKey(k)}` : `Put ${nameOfKey(k)} back`);
      if (p === 'pin') {
        if (n > 1) return ch.every(([, kk]) => !meaning('pin', b.pin[kk])) ? `Unpinned ${n}` : `Changed ${n} pins`;
        return v.d ? `Pinned ${nameOfKey(k)}${WITH[v.d] || ''}` : `Unpinned ${nameOfKey(k)}`;
      }
      if (p === 'hide') return n > 1 ? `Changed ${n} hidden results` : v.h ? `Hid ${nameOfKey(k)}` : `Showed ${nameOfKey(k)} again`;
      if (p === 'link') {
        if (n > 1) return `Changed ${n} links`;
        const [x, y] = k.split(' > ');
        const what = `${nameOfKey(y)} uses ${nameOfKey(x)}`;
        return v.s === 'add' ? `Linked: ${what}` : v.s === 'del' ? `Took away: ${what}` : `Back as the paper has it: ${what}`;
      }
      return v.p ? `Saved the map “${k}”` : `Deleted the map “${k}”`;
    }
    function showNote(text, kind) {
      note = text ? { text, kind } : null;
      clearTimeout(noteTimer);
      if (note) noteTimer = setTimeout(() => { note = null; document_.querySelectorAll('.dep-note').forEach((x) => x.remove()); }, 8000);
    }

    function editsChanged(part, o) {
      o = o || {};
      if (!o.history) {
        const label = o.label || describe(committed, edits);
        if (label) {
          undoStack.push({ edits: committed, label });
          if (undoStack.length > 50) undoStack.shift();
          redoStack.length = 0;
          showNote(label, 'undo');
        }
      }
      committed = edits;
      saveEdits();
      const all = part === 'all';
      if ((all || part === 'link') && graph) applyLinks(graph, edits.link);
      for (const v of views) if (v.tab === 'deps' && v.isShown()) fillDeps(v);
      markPins();
      if ((all || part === 'link') && focusState) refocus();
      if ((all || part === 'pin' || part === 'link' || part === 'view') && opts.onPinsChange) opts.onPinsChange();
      if (all || part === 'pin' || part === 'view') pinsChanged();
    }

    // Whoever shows the pins (src/pins.js: the toolbar's pin and its list) hears of every change.
    const pinListeners = new Set();
    function pinsChanged() {
      for (const fn of pinListeners) { try { fn(); } catch (e) { /* one listener does not stop the others */ } }
    }

    /**
     * Everything pinned, in one list: the map's results and equations, then the
     * Notation tab's rows, each { key, kind: 'result' | 'equation' | 'notation',
     * name, note, el (where to jump), d (for a result: 'self', 'uses', 'usedBy', 'both'),
     * tex (notation: what to draw), code (notation: a macro's name) }.
     */
    function pinnedList() {
      const out = [];
      const g = getGraph();
      for (const [k, d] of pinMap()) {
        if (k.startsWith('eq:')) {
          const el = eqEls().get(k);
          out.push({ key: k, kind: 'equation', name: el ? eqNameOf(el) : k.slice(3), el: el && doc.contains(el) ? el : null, d });
        } else {
          const n = g.byKey.get(k);
          if (n && n.cite) continue;
          const name = n ? n.name : k.replace(/^(label|name):/, '');
          out.push({ key: k, kind: 'result', name, note: n && n.note && !String(name).includes(n.note) ? n.note : '', el: n && n.el && doc.contains(n.el) ? n.el : null, d });
        }
      }
      if (pinned.size) {
        const entries = new Map();
        try { for (const e of entriesOf(getIndex())) entries.set(e.pin, e); } catch (err) { /* no index: names only */ }
        for (const k of pinned) {
          const e = entries.get(k);
          const isMacro = k.startsWith('m:');
          const tex = e ? (isMacro ? sampleOf(e.it) || '' : e.it.tex) : (isMacro ? '' : k.slice(2));
          out.push({ key: k, kind: 'notation', name: isMacro ? '\\' + k.slice(2) : tex, tex, code: isMacro ? '\\' + k.slice(2) : '', el: e && e.first && doc.contains(e.first) ? e.first : null });
        }
      }
      return out;
    }

    /** Unpin one thing by its key (from pinnedList). */
    function unpinKey(key) {
      if (pinned.has(key)) togglePin(key);
      else setPin(key, '');
    }

    /** Write the values of `target` wherever the changes differ from it. */
    function moveTo(target) {
      const EMPTY = { pos: {}, pin: { d: '' }, hide: { h: false }, link: { s: '' }, view: { p: null } };
      for (const [p, k] of diff(edits, target)) {
        const v = (target[p] || {})[k];
        const clean = v && meaning(p, v) != null ? Object.assign({}, v) : Object.assign({}, EMPTY[p]);
        delete clean.t;
        setEdit(p, k, clean, true);
      }
    }
    function undo() {
      const step = undoStack.pop();
      if (!step) return false;
      redoStack.push({ edits: committed, label: step.label });
      moveTo(step.edits);
      showNote('Undone: ' + step.label, 'redo');
      editsChanged('all', { history: true });
      return true;
    }
    function redo() {
      const step = redoStack.pop();
      if (!step) return false;
      undoStack.push({ edits: committed, label: step.label });
      moveTo(step.edits);
      showNote(step.label, 'undo');
      editsChanged('all', { history: true });
      return true;
    }

    /** Whether the map differs from the paper's: moved, pinned, hidden or relinked anything. */
    const changedFromPaper = () => ['pos', 'pin', 'hide', 'link'].some((p) => Object.values(edits[p]).some((e) => meaning(p, e) != null));
    /**
     * The map as the paper has it: TeXglass's layout, nothing hidden, no links of
     * the reader's own or taken away, no pins. Saved maps stay as they are.
     */
    function resetMap() {
      if (locked) return;
      for (const p of ['pos', 'pin', 'hide', 'link']) {
        for (const [k, e] of Object.entries(edits[p])) {
          if (meaning(p, e) == null) continue;
          setEdit(p, k, p === 'pos' ? {} : p === 'pin' ? { d: '' } : p === 'hide' ? { h: false } : { s: '' }, true);
        }
      }
      editsChanged('all', { label: 'Reset the map to the paper’s' });
    }

    /** Pin a result, cited work or equation (by key): d 'self' | 'uses' | 'usedBy' | 'both', or '' to unpin. */
    function setPin(key, d) {
      if (!key) return;
      const had = (edits.pin[key] && edits.pin[key].d) || '';
      if (had === (d || '')) return;
      setEdit('pin', key, { d: d || '' });
    }
    function unpinAll() {
      for (const k of pinMap().keys()) setEdit('pin', k, { d: '' }, true);
      editsChanged('pin');
    }

    /** Save the pins under a name, to bring back later (synced with the notes). */
    function saveView(name) {
      name = String(name || '').trim().slice(0, 80);
      const pins = pinMap();
      if (!name || !pins.size) return false;
      activeView = name;
      setEdit('view', name, { p: Object.fromEntries(pins) });
      return true;
    }
    /** Pin what a saved view pinned, instead of the pins now. */
    function loadView(name) {
      const v = edits.view[name];
      if (!v || !v.p) return false;
      const want = new Map(Object.entries(v.p));
      for (const k of pinMap().keys()) if (!want.has(k)) setEdit('pin', k, { d: '' }, true);
      for (const [k, d] of want) if (((edits.pin[k] && edits.pin[k].d) || '') !== d) setEdit('pin', k, { d }, true);
      activeView = name;
      editsChanged('pin', { label: `Opened the map “${name}”` });
      return true;
    }
    function deleteView(name) {
      if (activeView === name) activeView = null;
      if (edits.view[name]) setEdit('view', name, { p: null });
    }
    // the saved map last opened or saved, to offer "Update" once its pins change
    let activeView = null;
    /** Whether the pins now are exactly a saved map's. */
    const pinsAre = (p) => {
      const pins = pinMap();
      const want = Object.entries(p || {});
      return want.length === pins.size && want.every(([k, d]) => pins.get(k) === d);
    };
    /** A name to suggest for the pins now: "Theorem 2 with what it uses", or "Map 3". */
    function suggestName() {
      const pins = Array.from(pinMap());
      if (activeView && edits.view[activeView] && edits.view[activeView].p) return activeView;
      if (pins.length === 1) return (nameOfKey(pins[0][0]) + (WITH[pins[0][1]] || '')).replace(/^equation /, 'Equation ');
      const used = new Set(Object.keys(edits.view));
      let i = savedViews().length + 1;
      while (used.has('Map ' + i)) i++;
      return 'Map ' + i;
    }

    function setHidden(key, on) {
      if (locked || !key) return;
      setEdit('hide', key, { h: !!on });
    }

    /** The reader's own arrow: `user` uses `dep` (keys of results). */
    function addLink(depKey, userKey) {
      if (locked || !depKey || !userKey || depKey === userKey) return;
      setEdit('link', depKey + ' > ' + userKey, { s: 'add' });
    }
    /** Take away the link "user uses dep": the reader's own goes, the paper's is set aside. */
    function removeLink(depKey, userKey) {
      if (locked) return;
      const g = getGraph();
      const n = g.byKey.get(userKey);
      const dep = g.byKey.get(depKey);
      const e = n && dep && n.edges.get(dep);
      if (!e) return;
      setEdit('link', depKey + ' > ' + userKey, { s: e.mine ? '' : 'del' });
    }
    function restoreLink(depKey, userKey) {
      if (locked) return;
      setEdit('link', depKey + ' > ' + userKey, { s: '' });
    }

    function resetLayout() {
      if (locked) return;
      for (const k of Object.keys(posOf())) setEdit('pos', k, {}, true);
      editsChanged('pos');
    }

    function setLocked(on, fromUi) {
      locked = !!on;
      for (const v of views) { v.linking = null; v.linkEdit = false; if (v.tab === 'deps' && v.isShown()) fillDeps(v); }
      if (fromUi && opts.onLock) opts.onLock(locked);
    }

    // --- pins in the text: a pin by each result's heading and each equation's number ---

    function addPinButton(el) {
      if (el._pinBtn || !el.id || el.closest(INSIDE_POPOVER)) return;
      const isEq = el.classList.contains('math-display');
      let at = null;
      if (isEq) {
        if (!eqKeyOf(el)) return;
      } else {
        at = headOf(el);
        if (!at) return;
      }
      const b = document_.createElement('button');
      b.type = 'button';
      b.className = 'tg-pin-btn' + (isEq ? ' tg-pin-eq' : '');
      b.innerHTML = PIN_ICON;
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const k = keyOfEl(el);
        if (!k) return;
        setPin(k, pinMap().has(k) ? '' : 'self');
      });
      if (isEq) el.appendChild(b);
      else (el._usesBtn || at).after(b);
      el._pinBtn = b;
      paintPinButton(el);
    }
    function paintPinButton(el) {
      const b = el._pinBtn;
      if (!b) return;
      const on = el.classList.contains('tg-pinned');
      const what = el.classList.contains('math-display') ? 'equation' : 'result';
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? `Unpin this ${what}` : `Pin this ${what}`);
      b.title = on ? `Pinned: click to unpin (Show pinned shows only what is pinned)` : `Pin this ${what}: Show pinned then shows only what you pinned, and it is marked on the map`;
    }
    doc.addEventListener('mouseover', (e) => {
      if (!e.target.closest) return;
      const t = e.target.closest('.theorem[id], .math-display[id]');
      if (t && doc.contains(t)) addPinButton(t);
    });
    doc.addEventListener('focusin', (e) => {
      const t = e.target.closest && e.target.closest('.theorem[id]');
      if (t) addPinButton(t);
    });

    /** Mark the pinned results and equations in the text (tg-pinned), each with its pin showing. */
    let marking = null;
    function markPins() {
      clearTimeout(marking);
      const was = Array.from(doc.querySelectorAll('.tg-pinned'));
      const pins = pinMap();
      if (!pins.size && !was.length) return;
      const now = new Set();
      for (const k of pins.keys()) {
        const el = elOfKey(k);
        if (el && doc.contains(el) && !el.matches('li')) now.add(el);
      }
      for (const el of was) if (!now.has(el)) { el.classList.remove('tg-pinned'); paintPinButton(el); }
      for (const el of now) {
        el.classList.add('tg-pinned');
        addPinButton(el);
        paintPinButton(el);
      }
    }

    // --- dragging a node of a map to where the reader wants it ---------------------

    function wireNodeDrag(view) {
      const body = view.body;
      let drag = null;
      const thingAt = (g) => thingOf(body, g.dataset.c != null ? 'c' + g.dataset.c : g.dataset.e != null ? 'e' + g.dataset.e : g.dataset.n);
      const moveTo = (d, px, py) => {
        const lay = view.lay;
        lay.x.set(d.thing, Math.max(2, px));
        lay.y.set(d.thing, Math.max(2, py));
        const tx = lay.x.get(d.thing) - d.x0;
        const ty = lay.y.get(d.thing) - d.y0;
        for (const g of d.parts) g.setAttribute('transform', `translate(${tx},${ty})`);
        for (const p of d.edges) {
          const a = thingOf(body, p.dataset.from);
          const b = thingOf(body, p.dataset.to);
          if (a && b && lay.x.has(a) && lay.x.has(b)) p.setAttribute('d', edgePath(lay, a, b));
        }
      };
      const begin = (d) => {
        d.on = true;
        hidePop();
        clearTimeout(showTimer);
        d.g.classList.add('dep-moving');
        body.querySelector('.dep-wrap').classList.add('dep-node-dragging');
      };
      body.addEventListener('pointerdown', (e) => {
        if (locked || e.button > 0 || !e.target.closest) return;
        const g = e.target.closest('.dep-node');
        const svg = g && g.closest('.dep-map');
        if (!g || !svg || !view.lay) return;
        const thing = thingAt(g);
        if (!thing || !thing.key || !view.lay.x.has(thing)) return;
        const k = g.dataset.c != null ? 'c' + g.dataset.c : g.dataset.e != null ? 'e' + g.dataset.e : g.dataset.n;
        const parts = [g];
        if (!thing.cite && !thing.eq) svg.querySelectorAll('.dep-fold').forEach((f) => { if (f.dataset.fold === thing.id) parts.push(f); });
        const edges = Array.from(svg.querySelectorAll('.dep-edge')).filter((p) => p.dataset.from === k || p.dataset.to === k);
        const scale = svg.getBoundingClientRect().width / Number(svg.getAttribute('width')) || 1;
        drag = {
          g, thing, parts, edges, scale, id: e.pointerId, sx: e.clientX, sy: e.clientY,
          x0: view.lay.x.get(thing), y0: view.lay.y.get(thing), on: false, touch: e.pointerType === 'touch', timer: null,
        };
        // a finger holds still for a moment first, so that a swipe still scrolls the map
        if (drag.touch) {
          const d = drag;
          d.timer = setTimeout(() => { if (drag === d) begin(d); }, 350);
        }
      });
      const win = document_.defaultView || window;
      win.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!drag.on) {
          if (Math.abs(dx) + Math.abs(dy) < 5) return;
          if (drag.touch) { clearTimeout(drag.timer); drag = null; return; } // a swipe: let it scroll
          begin(drag);
        }
        e.preventDefault();
        moveTo(drag, drag.x0 + dx / drag.scale, drag.y0 + dy / drag.scale);
      }, { passive: false });
      // while a finger drags a node, the page must not scroll
      body.addEventListener('touchmove', (e) => { if (drag && drag.on) e.preventDefault(); }, { passive: false });
      const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        clearTimeout(d.timer);
        if (!d.on) return;
        d.g.classList.remove('dep-moving');
        const wrap = body.querySelector('.dep-wrap');
        if (wrap) wrap.classList.remove('dep-node-dragging');
        view.dragged = true; // the click that ends a drag picks nothing
        setTimeout(() => { view.dragged = false; }, 0);
        if (e.type === 'pointercancel') { fillDeps(view); return; }
        const x = view.lay.x.get(d.thing);
        const y = view.lay.y.get(d.thing);
        if (Math.abs(x - d.x0) + Math.abs(y - d.y0) < 1) return;
        setEdit('pos', d.thing.key, { x, y });
      };
      win.addEventListener('pointerup', end);
      win.addEventListener('pointercancel', end);
      // keyboard: Alt + arrows move the focused node
      body.addEventListener('keydown', (e) => {
        if (locked || !e.altKey || !/^Arrow/.test(e.key)) return;
        const g = e.target.closest && e.target.closest('.dep-node');
        if (!g || !view.lay) return;
        const thing = thingAt(g);
        if (!thing || !thing.key || !view.lay.x.has(thing)) return;
        e.preventDefault();
        const step = e.shiftKey ? 2 : 12;
        const x = view.lay.x.get(thing) + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0);
        const y = view.lay.y.get(thing) + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
        const sel = g.getAttribute('data-n') != null ? `[data-n="${g.dataset.n}"]` : g.dataset.c != null ? `[data-c="${g.dataset.c}"]` : `[data-e="${g.dataset.e}"]`;
        setEdit('pos', thing.key, { x: Math.max(2, x), y: Math.max(2, y) });
        const again = body.querySelector('.dep-node' + sel);
        if (again) again.focus();
      });
    }

    /** The row of pins, saved maps and editing under a map's options. */
    function pinsRowHtml(view) {
      const pins = pinMap();
      const saved = savedViews();
      const parts = [];
      if (pins.size) {
        parts.push(`<span class="dep-pins-count"><svg width="14" height="14" aria-hidden="true"><g class="dep-pin-mark" transform="translate(7,7)"><circle r="6.5"/><path d="${PIN_PATH}" transform="scale(0.8)"/></g></svg> ${pins.size} pinned</span>`);
        if (opts.showPinned) parts.push('<button type="button" data-show-pinned title="Show only the pinned results and equations in the text, the rest hidden">Show pinned</button>');
        parts.push(view.naming
          ? `<span class="dep-view-new"><input type="text" class="dep-view-name" placeholder="Name this map" aria-label="Name for the saved map" maxlength="80" value="${esc(suggestName())}"><button type="button" data-save-ok>Save</button><button type="button" data-save-cancel>Cancel</button></span>`
          : '<button type="button" data-save-view title="Keep these pins under a name, to bring them back later (saved with your notes)">Save as…</button>');
        // the saved map in use, changed since: one click keeps the new pins under its name
        const act = activeView && edits.view[activeView] && edits.view[activeView].p ? activeView : null;
        if (act && !view.naming && !pinsAre(edits.view[act].p)) parts.push(`<button type="button" class="dep-view-update" data-view-update="${esc(act)}" title="${esc(`Keep the pins now under “${act}”, instead of what it held`)}">Update “${esc(act)}”</button>`);
        parts.push('<button type="button" data-unpin-all title="Take every pin away">Unpin all</button>');
      } else {
        parts.push('<span class="insight-muted">Pick a result and pin it (below the map), or click the pin by a result’s heading or beside an equation in the text, to show only those later.</span>');
      }
      if (saved.length) {
        parts.push('<span class="dep-views"><span class="insight-usedby-k">Saved</span> ' + saved.map(([name, e]) =>
          `<span class="dep-view${pinsAre(e.p) ? ' dep-view-on' : ''}"><button type="button" data-view="${esc(name)}" aria-pressed="${pinsAre(e.p)}" title="${esc(pinsAre(e.p) ? `Pinned now: the ${Object.keys(e.p).length} of “${name}”` : `Pin these ${Object.keys(e.p).length} again, instead of the pins now`)}">${esc(name)}</button>` +
          `<button type="button" class="dep-view-del" data-view-del="${esc(name)}" aria-label="${esc('Delete the saved map ' + name)}" title="Delete">×</button></span>`).join('') + '</span>');
      }
      return `<div class="dep-pins">${parts.join('')}</div>`;
    }

    /** The detail's row for pinning, hiding and links of a result (or cited work, or equation). */
    function editRowHtml(view, x) {
      const d = pinMap().get(x.key) || '';
      const pinB = (dir, label, title) => `<button type="button" data-mpin="${dir}" aria-pressed="${d === dir}" title="${esc(title)}">${label}</button>`;
      let html = '<div class="dep-edit"><span class="insight-usedby-k">Pin</span> <span class="dep-pin-btns" role="group" aria-label="Pin">' +
        pinB('self', 'It', 'Pin just this') +
        (x.eq || x.cite ? '' : pinB('uses', '+ uses', 'Pin it with everything it uses, directly or not') +
          pinB('usedBy', '+ used in', 'Pin it with everything that uses it, directly or not') +
          pinB('both', '+ both', 'Pin it with what it uses and what uses it')) +
        (d ? '<button type="button" data-mpin="" title="Take the pin away">Unpin</button>' : '') + '</span>';
      if (!locked) {
        const hid = hiddenSet().has(x.key);
        html += ` <button type="button" data-mhide="${hid ? '0' : '1'}" title="${hid ? 'Draw it on the map again' : 'Leave it off the map (Hidden brings it back)'}">${hid ? 'Show on map' : 'Hide from map'}</button>`;
        if (!x.eq && !x.cite) {
          html += view.linking && view.linking.key === x.key
            ? `<br><span class="dep-linking-hint">${view.linking.dir === 'uses' ? `Pick the result ${esc(x.name)} uses` : `Pick the result that uses ${esc(x.name)}`} on the map.</span> <button type="button" data-link-cancel>Cancel</button>`
            : '<br><span class="insight-usedby-k">Links</span> <button type="button" data-link="uses" title="Draw your own arrow: pick a result on the map that this one uses">+ It uses…</button>' +
              '<button type="button" data-link="usedBy" title="Draw your own arrow: pick a result on the map that uses this one">+ Used in…</button>' +
              ((x.uses.size || x.usedBy.size || (x.removed && x.removed.length))
                ? `<button type="button" data-link-edit aria-pressed="${!!view.linkEdit}" title="Take away links that are wrong (× by each), or bring back ones taken away">Remove…</button>` : '');
        }
      }
      return html + '</div>';
    }

    // How maps are drawn, shared by every map on show: cited works as leaves,
    // bands for sections, and small lemmas folded into the result they serve
    // (null: when the map is big).
    const mapOpts = { cites: true, sections: true, fold: null };
    const FOLD_FROM = 14; // results on a map before lemmas fold by themselves

    function fillDeps(view) {
      const body = view.body;
      const g = getGraph();
      if (!view.expanded) view.expanded = new Set();
      const linked = g.nodes.filter((n) => n.uses.size || n.usedBy.size || n.cites.size);
      const fold = mapOpts.fold != null ? mapOpts.fold : linked.filter((n) => n.uses.size || n.usedBy.size).length > FOLD_FROM;
      const eqs = pinnedEqs(g);
      const hidden = hiddenSet();
      const lay = layout(g, {
        cites: mapOpts.cites, sections: mapOpts.sections, fold, expanded: view.expanded,
        eqs, hidden, showHidden: mapOpts.showHidden, pos: posOf(), pinned: pinMap(), pinSub: pinSubSet(), all: !!view.linking,
      });
      view.lay = lay;
      body._nodes = g.nodes;
      body._cites = g.cites;
      body._eqs = eqs;
      if (!lay.nodes.length && !lay.cites.length && !lay.eqs.length && !hidden.size) {
        body.innerHTML = '<p class="insight-empty">No result in this document refers to another one, so there is nothing to map. (The map is drawn from the \\ref and \\cref links in statements and proofs, from results named by hand such as “Lemma 2.3” or “the previous lemma”, and from citations.)</p>';
        return;
      }
      let links = 0;
      let guessed = 0;
      let mine = 0;
      for (const n of g.nodes) for (const e of n.edges.values()) { links++; if (e.guessed) guessed++; if (e.mine) mine++; }
      const counts = `${linked.length} result${linked.length === 1 ? '' : 's'}, ${links} link${links === 1 ? '' : 's'} between them` +
        (guessed || mine ? ` (${[guessed ? `${guessed} guessed from the wording` : '', mine ? `${mine} of your own` : ''].filter(Boolean).join(', ')})` : '') +
        (g.cites.length ? `, ${g.cites.length} cited work${g.cites.length === 1 ? '' : 's'}` : '');
      const box = (k, label, on, title) => `<label title="${esc(title)}"><input type="checkbox" data-opt="${k}"${on ? ' checked' : ''}> ${label}</label>`;
      const opts_ = [];
      if (g.sections.length > 1) opts_.push(box('sections', 'Sections', mapOpts.sections, 'Group the results by the section they sit in'));
      if (g.cites.length) opts_.push(box('cites', 'Citations', mapOpts.cites, 'Show the works cited in statements and proofs'));
      if (foldGroups(g).size) opts_.push(box('fold', 'Fold lemmas', fold, 'Fold chains of lemmas that serve only one result into that result'));
      if (hidden.size) opts_.push(box('showHidden', `Hidden (${hidden.size})`, !!mapOpts.showHidden, 'Draw the results you hid, faded, so you can bring them back'));
      opts_.push(`<label title="Lock the map: no dragging, hiding or changing links (pins still work)"><input type="checkbox" data-lock${locked ? ' checked' : ''}> Lock</label>`);
      const lastU = undoStack[undoStack.length - 1];
      const lastR = redoStack[redoStack.length - 1];
      opts_.push('<span class="dep-history" role="group" aria-label="Undo and redo">' +
        `<button type="button" data-undo${lastU ? '' : ' disabled'} title="${esc(lastU ? `Undo: ${lastU.label} (Ctrl+Z)` : 'Nothing to undo')}" aria-label="Undo">↶</button>` +
        `<button type="button" data-redo${lastR ? '' : ' disabled'} title="${esc(lastR ? `Redo: ${lastR.label} (Ctrl+Shift+Z)` : 'Nothing to redo')}" aria-label="Redo">↷</button></span>`);
      if (lay.moved && !locked) opts_.push('<button type="button" class="dep-reset" data-reset-layout title="Put every result back where TeXglass placed it (pins, hidden results and links stay)">Reset layout</button>');
      if (changedFromPaper() && !locked) opts_.push('<button type="button" class="dep-reset" data-reset-map title="Back to the map as the paper has it: TeXglass’s layout, nothing hidden or pinned, only the paper’s links. Saved maps stay.">Reset map…</button>');
      // the larger map zooms: buttons, Ctrl + wheel or a pinch, and + − 0 F keys
      const zoomBar = view.zoomable
        ? '<span class="dep-zoom" role="group" aria-label="Zoom the map">' +
          '<button type="button" data-zoom="-1" title="Zoom out (−)" aria-label="Zoom out">−</button>' +
          '<button type="button" data-zoom="0" class="dep-zoom-level" title="Actual size (0)" aria-label="Actual size">100%</button>' +
          '<button type="button" data-zoom="1" title="Zoom in (+)" aria-label="Zoom in">+</button>' +
          '<button type="button" data-zoom="fit" title="Fit the whole map in view (F)">Fit</button></span>'
        : '';
      const noteHtml = note ? `<span class="dep-note" role="status">${esc(note.text)} <button type="button" data-${note.kind}>${note.kind === 'undo' ? 'Undo' : 'Redo'}</button></span>` : '';
      const confirmHtml = view.confirmReset && !locked
        ? '<div class="dep-confirm" role="alertdialog" aria-label="Reset the map"><span>Put the map back as the paper has it? Your layout, hidden results, own links and pins go; <strong>saved maps stay</strong>, and Undo brings it all back.</span>' +
          '<button type="button" class="dep-confirm-yes" data-reset-yes>Reset map</button><button type="button" data-reset-no>Cancel</button></div>'
        : '';
      const controls = `<div class="dep-opts">${opts_.join('')}${zoomBar}</div>` + confirmHtml + pinsRowHtml(view) + noteHtml;
      const oldWrap = body.querySelector('.dep-wrap');
      const kept = oldWrap ? { l: oldWrap.scrollLeft, t: oldWrap.scrollTop } : null;
      body.innerHTML = view.side
        ? `<p class="insight-lead">${counts}. Each arrow goes to a result that uses the one it starts from; pick one to light up what it rests on${locked ? '' : ', drag one to move it'}. <a href="#" class="dep-larger" title="Open the larger map (M)">Larger map</a></p>` +
          controls + `<div class="dep-wrap">${mapSvg(lay)}</div>${legendHtml(lay)}<div class="dep-detail" aria-live="polite"></div>`
        : `<p class="insight-lead">${counts}, read from the links in statements and proofs, from results named by hand, and from citations. ` +
          'Each arrow goes from a result to one that uses it. Pick a result to light up what it rests on and what rests on it. ' +
          (locked ? 'Drag the background to move around' : 'Drag a result to move it (a finger holds still first), the background to move around') + '; Ctrl + scroll or pinch to zoom.</p>' +
          controls + `<div class="dep-wrap">${mapSvg(lay)}</div>${legendHtml(lay)}<div class="dep-detail" aria-live="polite"></div>`;
      view.synced = false;
      paintStatus(view);
      if (view.zoomable) zoomTo(view, view.scale || 1);
      const wrap = body.querySelector('.dep-wrap');
      if (kept && wrap) { wrap.scrollLeft = kept.l; wrap.scrollTop = kept.t; } // redrawn: stay where it was
      body.querySelector('.dep-map').classList.toggle('dep-linking', !!view.linking);
      body.querySelector('.dep-map').classList.toggle('dep-locked', locked);
      if (view.naming) { const inp = body.querySelector('.dep-view-name'); if (inp) { inp.focus(); inp.select(); } }
      if (focusState && !view.linking && syncMap(view)) return;
      if (view.selected != null && g.nodes[view.selected]) select(view, view.selected);
      else if (view.selectedCite != null && g.cites[view.selectedCite]) selectCite(view, view.selectedCite);
      else if (view.selectedEq != null && eqs.some((q) => q.key === view.selectedEq)) selectEq(view, eqs.find((q) => q.key === view.selectedEq).order);
      else body.querySelector('.dep-detail').innerHTML = '<p class="insight-muted">No result picked.</p>';
    }

    // --- reading progress on the map (src/progress.js) ---------------------------

    const STATUS_NAMES = { unread: 'unread', skimmed: 'skimmed', read: 'read', understood: 'understood' };
    const statusOf = (n) => (opts.statusOf && n && n.el ? opts.statusOf(n.el) : null);

    /** Colour a map's results by the reader's status, and flag the "?" ones. */
    function paintStatus(view) {
      const body = view.body;
      const svg = body.querySelector('.dep-map');
      if (!svg) return;
      let any = false;
      svg.querySelectorAll('.dep-node[data-n]').forEach((g) => {
        const n = body._nodes && body._nodes[Number(g.dataset.n)];
        const st = statusOf(n);
        if (st) any = true;
        for (const k of Object.keys(STATUS_NAMES)) g.classList.toggle('rp-st-' + k, !!st && st.s === k);
        g.classList.toggle('rp-st-q', !!(st && st.q));
        const old = g.querySelector('.rp-qmark');
        if (old) old.remove();
        if (st && st.q) {
          const r = g.querySelector('rect');
          const NS = 'http://www.w3.org/2000/svg';
          const cx = Number(r.getAttribute('x')) + Number(r.getAttribute('width')) - 2;
          const cy = Number(r.getAttribute('y')) + 1;
          const mark = document_.createElementNS(NS, 'g');
          mark.setAttribute('class', 'rp-qmark');
          mark.setAttribute('aria-hidden', 'true');
          const c = document_.createElementNS(NS, 'circle');
          c.setAttribute('cx', String(cx));
          c.setAttribute('cy', String(cy));
          c.setAttribute('r', '6.5');
          const t = document_.createElementNS(NS, 'text');
          t.setAttribute('x', String(cx));
          t.setAttribute('y', String(cy + 3.5));
          t.setAttribute('text-anchor', 'middle');
          t.textContent = '?';
          mark.append(c, t);
          g.appendChild(mark);
        }
        const label = g.getAttribute('aria-label') || '';
        const base = label.replace(/\. Reading: .*$/, '');
        g.setAttribute('aria-label', st ? `${base}. Reading: ${st.s}${st.q ? ', flagged with a question' : ''}` : base);
      });
      let legend = body.querySelector('.rp-legend');
      if (!any) { if (legend) legend.remove(); return; }
      if (!legend) {
        legend = document_.createElement('div');
        legend.className = 'dep-legend rp-legend';
        legend.innerHTML = ['unread', 'skimmed', 'read', 'understood']
          .map((k) => `<span><span class="rp-key rp-key-${k}" aria-hidden="true"></span> ${k}</span>`).join('') +
          '<span><span class="rp-key rp-key-q" aria-hidden="true">?</span> question</span>';
        const wrap = body.querySelector('.dep-wrap');
        const after = wrap && wrap.nextElementSibling && wrap.nextElementSibling.classList.contains('dep-legend') ? wrap.nextElementSibling : wrap;
        if (after) after.after(legend);
      }
    }

    /** The reader changed a status: recolour the maps on show, and the picked result's detail. */
    function repaint() {
      for (const v of views) {
        if (v.tab !== 'deps' || !v.isShown()) continue;
        paintStatus(v);
        if (v.selected != null && !v.synced && v.lay) {
          const detail = v.body.querySelector('.dep-detail');
          const keep = detail ? detail.scrollTop : 0;
          select(v, v.selected);
          if (detail) detail.scrollTop = keep;
        }
      }
    }

    // --- zooming and moving around a map -----------------------------------------

    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 3;

    /** The scale at which the whole map fits in its frame (at most 1). */
    function fitScale(view) {
      const svg = view.body.querySelector('.dep-map');
      const wrap = view.body.querySelector('.dep-wrap');
      if (!svg || !wrap || !wrap.clientWidth) return 1;
      const w = Number(svg.getAttribute('width'));
      const h = Number(svg.getAttribute('height'));
      return Math.min(1, (wrap.clientWidth - 2) / w, (wrap.clientHeight - 2) / h);
    }

    /**
     * Draw the map at scale s, keeping the point at (x, y) of the frame (its
     * middle by default) where it is. The SVG is scaled, so it stays sharp.
     */
    function zoomTo(view, s, at) {
      const svg = view.body.querySelector('.dep-map');
      const wrap = view.body.querySelector('.dep-wrap');
      if (!svg || !wrap) return;
      s = Math.min(ZOOM_MAX, Math.max(Math.min(ZOOM_MIN, fitScale(view)), s));
      const old = svg.style.width ? view.scale || 1 : 1;
      const cx = at ? at.x : wrap.clientWidth / 2;
      const cy = at ? at.y : wrap.clientHeight / 2;
      const px = (wrap.scrollLeft + cx) / old;
      const py = (wrap.scrollTop + cy) / old;
      svg.style.width = `${Number(svg.getAttribute('width')) * s}px`;
      svg.style.height = `${Number(svg.getAttribute('height')) * s}px`;
      view.scale = s;
      wrap.scrollLeft = px * s - cx;
      wrap.scrollTop = py * s - cy;
      const label = view.body.querySelector('.dep-zoom-level');
      if (label) label.textContent = `${Math.round(s * 100)}%`;
      view.body.querySelectorAll('.dep-zoom [data-zoom="-1"]').forEach((b) => { b.disabled = s <= Math.min(ZOOM_MIN, fitScale(view)) + 1e-3; });
      view.body.querySelectorAll('.dep-zoom [data-zoom="1"]').forEach((b) => { b.disabled = s >= ZOOM_MAX - 1e-3; });
    }

    /** One step: 1 in, -1 out, 0 actual size, 'fit' the whole map. False if no map is on show. */
    function zoomStep(view, dir) {
      if (!view.zoomable || view.tab !== 'deps' || !view.body.querySelector('.dep-map')) return false;
      if (dir === 'fit') zoomTo(view, fitScale(view));
      else if (!dir) zoomTo(view, 1);
      else zoomTo(view, (view.scale || 1) * (dir > 0 ? 1.25 : 0.8));
      return true;
    }

    /** Drag the map's background to move around it; Ctrl + wheel or a pinch zooms (larger map). */
    function wireMapMoves(view) {
      const body = view.body;
      let drag = null;
      body.addEventListener('pointerdown', (e) => {
        const wrap = e.target.closest && e.target.closest('.dep-wrap');
        if (!wrap || e.button !== 0 || e.target.closest('.dep-node, .dep-fold')) return;
        const r = wrap.getBoundingClientRect();
        if (e.clientX - r.left > wrap.clientWidth || e.clientY - r.top > wrap.clientHeight) return; // a scroll bar
        if (wrap.scrollWidth <= wrap.clientWidth && wrap.scrollHeight <= wrap.clientHeight) return;
        drag = { wrap, x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop, id: e.pointerId, moved: false };
      });
      body.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!drag.moved) {
          drag.moved = true;
          drag.wrap.classList.add('dep-dragging');
          try { drag.wrap.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          hidePop();
        }
        e.preventDefault();
        drag.wrap.scrollLeft = drag.l - dx;
        drag.wrap.scrollTop = drag.t - dy;
      });
      const end = (e) => {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        drag.wrap.classList.remove('dep-dragging');
        drag = null;
      };
      body.addEventListener('pointerup', end);
      body.addEventListener('pointercancel', end);
      if (!view.zoomable) return;
      body.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey) || view.tab !== 'deps') return;
        const wrap = e.target.closest && e.target.closest('.dep-wrap');
        if (!wrap) return;
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        zoomTo(view, (view.scale || 1) * Math.exp(-e.deltaY / 300), { x: e.clientX - r.left, y: e.clientY - r.top });
      }, { passive: false });
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-zoom]');
        if (!b) return;
        e.preventDefault();
        zoomStep(view, b.dataset.zoom === 'fit' ? 'fit' : Number(b.dataset.zoom));
      });
    }

    /** Fold or unfold the lemmas folded into the result with this id, on one map. */
    function toggleFold(view, id) {
      if (!view.expanded) view.expanded = new Set();
      if (view.expanded.has(id)) {
        view.expanded.delete(id);
        // a lemma picked inside the group gives way to the result it folds into
        const nodes = view.body._nodes || [];
        const root = nodes.find((n) => n.id === id);
        const list = root && view.lay && view.lay.groups.get(root);
        if (list && view.selected != null && list.includes(nodes[view.selected])) view.selected = root.order;
      } else view.expanded.add(id);
      fillDeps(view);
    }

    /**
     * A result picked on a map: while "What does this use?" is on, the light in the
     * text moves to it (and the maps follow); otherwise only this map lights it up.
     */
    function pick(view, k) {
      const n = view.body._nodes && view.body._nodes[k];
      if (!n) return;
      if (focusState && !focusState.set && n.el && doc.contains(n.el)) focus(n.el, focusState.dir, true);
      else select(view, k);
    }

    /**
     * A second click (or tap) on the same map node within a moment jumps to that
     * result in the text, closing the larger map. Counted by hand rather than with
     * dblclick, which phones do not all send, and the first click may redraw the node.
     */
    function twice(view, node, e) {
      const key = node.dataset.c != null ? 'c' + node.dataset.c : node.dataset.e != null ? 'e' + node.dataset.e : node.dataset.n;
      const last = view.lastNodeClick;
      const near = last && last.key === key && e.timeStamp - last.t < 450 &&
        Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) < 24;
      view.lastNodeClick = near ? null : { key, t: e.timeStamp, x: e.clientX, y: e.clientY };
      if (!near) return false;
      const m = thingOf(view.body, key);
      const el = m && m.el;
      if (!el || !doc.contains(el)) return false;
      hidePop();
      view.leave();
      opts.jump(el);
      return true;
    }

    /** What a key on the map (data-n, data-from…) stands for: a result, or "c3", a cited work. */
    const thingOf = (body, key) => {
      const s = String(key);
      if (s[0] === 'c') return body._cites[Number(s.slice(1))];
      if (s[0] === 'e') return (body._eqs || [])[Number(s.slice(1))];
      return body._nodes[Number(s)];
    };

    /** Light up these on a map: { sel, up: Set, down: Set }, results or cited works, as drawn. */
    function lightMap(view, sel, up, down) {
      const body = view.body;
      const svg = body.querySelector('.dep-map');
      const lay = view.lay;
      const drawn = (set) => new Set(Array.from(set, (m) => (m.cite || m.eq ? m : lay.drawnOf(m))));
      const U = drawn(up);
      const D = drawn(down);
      U.delete(sel);
      D.delete(sel);
      svg.classList.add('dep-picked');
      svg.querySelectorAll('.dep-node').forEach((g) => {
        const m = thingOf(body, g.dataset.c != null ? 'c' + g.dataset.c : g.dataset.e != null ? 'e' + g.dataset.e : g.dataset.n);
        g.classList.toggle('dep-sel', m === sel);
        g.classList.toggle('dep-up', U.has(m));
        g.classList.toggle('dep-down', D.has(m));
      });
      svg.querySelectorAll('.dep-edge').forEach((p) => {
        const a = thingOf(body, p.dataset.from);
        const b = thingOf(body, p.dataset.to);
        const on = ((U.has(a) || a === sel) && (U.has(b) || b === sel)) || ((D.has(a) || a === sel) && (D.has(b) || b === sel));
        p.classList.toggle('dep-lit', on);
      });
      const node = svg.querySelector(sel.cite ? `.dep-node[data-c="${sel.order}"] rect` : sel.eq ? `.dep-node[data-e="${sel.order}"] rect` : `.dep-node[data-n="${sel.order}"] rect`);
      const wrap = body.querySelector('.dep-wrap');
      if (node && wrap) {
        // bring the node into the map's own scroll box, without scrolling anything else
        const r = node.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        if (r.left < w.left || r.right > w.right) wrap.scrollLeft += r.left - w.left - (w.width - r.width) / 2;
        if (r.top < w.top || r.bottom > w.bottom) wrap.scrollTop += r.top - w.top - (w.height - r.height) / 2;
      }
    }

    /** "Lemma 2.1 (guessed)": a list of results to pick, each with how it is linked. */
    function pickList(set, edgeOf, unlinkKey) {
      if (!set.size) return '<span class="insight-muted">nothing</span>';
      return Array.from(set).sort((a, b) => a.order - b.order).map((m) => {
        const e = edgeOf && edgeOf(m);
        let tag = '';
        if (unlinkKey) tag += ` <button type="button" class="dep-unlink" data-unlink="${esc(unlinkKey(m))}" aria-label="${esc('Take away the link with ' + m.name)}" title="Take this link away">×</button>`;
        if (e && e.mine) tag = ' <span class="dep-tag dep-tag-mine" title="A link you drew">yours</span>' + tag;
        else if (e && e.guessed) tag = ` <span class="dep-tag dep-tag-guess" title="${esc(`No link in the text: guessed from “${e.why}”`)}">guessed</span>` + tag;
        else if (e && !e.proof) tag = ' <span class="dep-tag" title="Named in the statement, not in a proof">statement</span>' + tag;
        return `<a href="#" data-pick="${m.order}"${e && e.guessed ? ' class="dep-l-guess"' : ''}>${esc(m.name)}</a>${tag}`;
      }).join(', ');
    }

    /**
     * Light up result k on a map and what it rests on and what rests on it, or,
     * with dir ('uses' | 'usedBy', from "What does this use?"), only that side.
     */
    function select(view, k, dir) {
      const body = view.body;
      const nodes = body._nodes;
      const n = nodes && nodes[k];
      if (!n || !view.lay) return;
      if (view.lay.foldedInto.has(n)) {
        // folded into a bigger result: unfold it there first
        view.expanded.add(view.lay.foldedInto.get(n).id);
        view.selected = k;
        view.selectedCite = null;
        fillDeps(view);
        return;
      }
      view.selected = k;
      view.selectedCite = null;
      view.selectedEq = null;
      view.synced = !!dir;
      const up = dir === 'usedBy' ? new Set() : closure(n, 'uses');
      const down = dir === 'uses' ? new Set() : closure(n, 'usedBy');
      // the works cited by what it rests on
      const cited = new Set();
      if (dir !== 'usedBy') for (const m of [n, ...up]) for (const c of m.cites.keys()) cited.add(c);
      const svg = body.querySelector('.dep-map');
      if (!svg) return;
      svg.classList.toggle('dep-synced', !!dir);
      lightMap(view, n, new Set([...up, ...cited]), down);
      const indirect = (all, direct) => {
        const rest = new Set(Array.from(all).filter((m) => !direct.has(m)));
        return rest.size ? `<br><span class="insight-usedby-k">Indirectly</span> ${pickList(rest)}` : '';
      };
      const detail = body.querySelector('.dep-detail');
      const lit = focusState && focusState.id === n.id;
      const folded = view.lay.shownFold.get(n);
      const cites = Array.from(n.cites.keys()).sort((a, b) => a.order - b.order);
      const editing = view.linkEdit && !locked;
      const unlink = (keyOf) => (editing ? keyOf : null);
      // links taken away: where they went, and what uses n that lost its link to it
      const lost = [];
      if (editing) {
        for (const dep of n.removed || []) lost.push([dep, dep.key + ' > ' + n.key]);
        for (const m of getGraph().nodes) if ((m.removed || []).includes(n)) lost.push([m, n.key + ' > ' + m.key]);
      }
      const removedHtml = lost.length
        ? `<p><span class="insight-usedby-k">Taken away</span> ${lost.map(([m, k]) => `${esc(m.name)} <button type="button" class="dep-relink" data-relink="${esc(k)}" title="Bring this link of the paper back">Restore</button>`).join(', ')}</p>`
        : '';
      detail.innerHTML =
        `<div class="dep-detail-head"><strong>${esc(n.name)}</strong>${n.note ? ` <span class="insight-muted">(${esc(n.note)})</span>` : ''} <a href="#" class="dep-go">Go to it</a>` +
        (lit
          ? ` <span class="insight-muted">lit up in the text</span> <a href="#" class="dep-unfocus" title="Show the whole page again">Done</a></div>`
          : ` <a href="#" class="dep-focus" title="Light up what it uses in the text, and fade the rest">Show what it uses</a></div>`) +
        `<p><span class="insight-usedby-k">Uses</span> ${pickList(n.uses, (m) => n.edges.get(m), unlink((m) => m.key + ' > ' + n.key))}${indirect(up, n.uses)}</p>` +
        `<p><span class="insight-usedby-k">Used in</span> ${pickList(n.usedBy, (m) => m.edges.get(n), unlink((m) => n.key + ' > ' + m.key))}${indirect(down, n.usedBy)}</p>` +
        removedHtml +
        notUnderstood(n, up) +
        (cites.length ? `<p><span class="insight-usedby-k">Cites</span> ${cites.map((c) => (c.el ? `<a href="#" data-cite="${c.order}">${esc(`${c.label} ${c.who}`.trim())}</a>` : `<span>${esc(c.label)}</span>`)).join(', ')}</p>` : '') +
        (folded ? `<p><span class="insight-usedby-k">Folded in</span> ${pickList(new Set(folded))} <a href="#" data-fold="${esc(n.id)}">Show them</a></p>` : '') +
        editRowHtml(view, n);
      const go = detail.querySelector('.dep-go');
      go.dataset.go = '';
      go._target = n.el;
      detail.querySelectorAll('a[data-cite]').forEach((a) => {
        a.dataset.go = '';
        a._target = body._cites[Number(a.dataset.cite)].el;
      });
      const fb = detail.querySelector('.dep-focus');
      if (fb) fb.addEventListener('click', (e) => {
        e.preventDefault();
        view.leave();
        focus(n.el, 'uses', true);
      });
    }

    /** "Not yet understood": what a result rests on that the reader has not marked understood. */
    function notUnderstood(n, up) {
      if (!statusOf(n) || !up.size) return '';
      const rest = new Set(Array.from(up).filter((m) => !m.cite && (statusOf(m) || {}).s !== 'understood'));
      if (!rest.size) return '<p class="rp-detail"><span class="insight-usedby-k">Reading</span> everything it rests on is marked understood</p>';
      return `<p class="rp-detail"><span class="insight-usedby-k">Not yet understood</span> ${rest.size} of the ${up.size} result${up.size === 1 ? '' : 's'} it rests on: ${pickList(rest)}</p>`;
    }

    /** Light up a cited work on a map, and the results that rest on it. */
    function selectCite(view, k) {
      const body = view.body;
      const c = body._cites && body._cites[k];
      if (!c || !view.lay || !body.querySelector(`.dep-node[data-c="${k}"]`)) return;
      view.selected = null;
      view.selectedCite = k;
      view.selectedEq = null;
      view.synced = false;
      const down = new Set();
      for (const u of c.usedBy) {
        down.add(u);
        for (const m of closure(u, 'usedBy')) down.add(m);
      }
      body.querySelector('.dep-map').classList.remove('dep-synced');
      lightMap(view, c, new Set(), down);
      const direct = new Set(c.usedBy);
      const rest = new Set(Array.from(down).filter((m) => !direct.has(m)));
      const detail = body.querySelector('.dep-detail');
      detail.innerHTML =
        `<div class="dep-detail-head"><strong>${esc(`${c.label} ${c.who}`.trim())}</strong> <span class="insight-muted">${c.el ? 'cited work' : 'cited work, not in the bibliography on this page'}</span>${c.el ? ' <a href="#" class="dep-go">Go to it</a>' : ''}</div>` +
        `<p><span class="insight-usedby-k">Cited in</span> ${pickList(direct)}` +
        (rest.size ? `<br><span class="insight-usedby-k">Indirectly</span> ${pickList(rest)}` : '') + '</p>' + editRowHtml(view, c);
      const go = detail.querySelector('.dep-go');
      if (go) {
        go.dataset.go = '';
        go._target = c.el;
      }
    }

    /** Ctrl+Z (undo), Ctrl+Shift+Z or Ctrl+Y (redo) on a map. True if it did something. */
    function mapUndoKey(e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || typing(e.target)) return false;
      const k = e.key.toLowerCase();
      let done = false;
      if (k === 'z' && !e.shiftKey) done = undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') done = redo();
      if (done) e.preventDefault();
      return done;
    }

    /** Clicks on the map's editing controls (pins, hiding, links, saved maps). True if handled. */
    function mapClick(view, e) {
      const t = e.target.closest('[data-mpin], [data-mhide], [data-link], [data-link-cancel], [data-link-edit], [data-unlink], [data-relink], ' +
        '[data-show-pinned], [data-save-view], [data-save-ok], [data-save-cancel], [data-unpin-all], [data-view], [data-view-del], [data-reset-layout], ' +
        '[data-undo], [data-redo], [data-reset-map], [data-reset-yes], [data-reset-no], [data-view-update]');
      if (!t) return false;
      e.preventDefault();
      const cur = () => {
        if (view.selected != null) return view.body._nodes[view.selected];
        if (view.selectedCite != null) return view.body._cites[view.selectedCite];
        if (view.selectedEq != null) return (view.body._eqs || []).find((q) => q.key === view.selectedEq) || { key: view.selectedEq, eq: true };
        return null;
      };
      const x = cur();
      const d = t.dataset;
      if (d.mpin != null) { if (x) setPin(x.key, d.mpin); }
      else if (d.mhide != null) { if (x) setHidden(x.key, d.mhide === '1'); }
      else if (d.link != null) {
        if (x && !locked) { view.linking = { key: x.key, dir: d.link }; view.linkEdit = false; fillDeps(view); }
      } else if (d.linkCancel != null) { view.linking = null; fillDeps(view); }
      else if (d.linkEdit != null) { view.linkEdit = !view.linkEdit; fillDeps(view); }
      else if (d.unlink != null) { const [a, b] = d.unlink.split(' > '); removeLink(a, b); }
      else if (d.relink != null) { const [a, b] = d.relink.split(' > '); restoreLink(a, b); }
      else if (d.showPinned != null) { if (opts.showPinned) { view.leave(); opts.showPinned(); } }
      else if (d.saveView != null) { view.naming = true; fillDeps(view); }
      else if (d.saveCancel != null) { view.naming = false; fillDeps(view); }
      else if (d.saveOk != null) {
        const inp = view.body.querySelector('.dep-view-name');
        if (inp && saveView(inp.value)) view.naming = false;
        else if (inp) inp.focus();
      } else if (d.unpinAll != null) unpinAll();
      else if (d.view != null) loadView(d.view);
      else if (d.viewDel != null) deleteView(d.viewDel);
      else if (d.resetLayout != null) resetLayout();
      else if (d.undo != null) undo();
      else if (d.redo != null) redo();
      else if (d.resetMap != null) { view.confirmReset = true; fillDeps(view); const y = view.body.querySelector('[data-reset-yes]'); if (y) y.focus(); }
      else if (d.resetNo != null) { view.confirmReset = false; fillDeps(view); }
      else if (d.resetYes != null) { view.confirmReset = false; resetMap(); }
      else if (d.viewUpdate != null) saveView(d.viewUpdate);
      return true;
    }

    /** Light up a pinned equation on a map, and the results that refer to it. */
    function selectEq(view, k) {
      const body = view.body;
      const q = body._eqs && body._eqs[k];
      if (!q || !view.lay || !body.querySelector(`.dep-node[data-e="${k}"]`)) return;
      view.selected = null;
      view.selectedCite = null;
      view.selectedEq = q.key;
      view.synced = false;
      body.querySelector('.dep-map').classList.remove('dep-synced');
      const down = new Set();
      for (const u of q.usedBy) { down.add(u); for (const m of closure(u, 'usedBy')) down.add(m); }
      lightMap(view, q, new Set(), down);
      const detail = body.querySelector('.dep-detail');
      detail.innerHTML =
        `<div class="dep-detail-head"><strong>Equation ${esc(q.name)}</strong> <a href="#" class="dep-go">Go to it</a></div>` +
        `<p><span class="insight-usedby-k">Referred to in</span> ${pickList(q.usedBy)}</p>` + editRowHtml(view, q);
      const go = detail.querySelector('.dep-go');
      go.dataset.go = '';
      go._target = q.el;
    }

    /** A map with nothing picked. */
    function clearPick(view, note) {
      const body = view.body;
      view.selected = null;
      view.selectedCite = null;
      view.selectedEq = null;
      view.synced = false;
      const svg = body.querySelector('.dep-map');
      if (svg) {
        svg.classList.remove('dep-picked', 'dep-synced');
        svg.querySelectorAll('.dep-sel, .dep-up, .dep-down, .dep-lit').forEach((x) => x.classList.remove('dep-sel', 'dep-up', 'dep-down', 'dep-lit'));
      }
      const detail = body.querySelector('.dep-detail');
      if (detail) detail.innerHTML = `<p class="insight-muted">${note || 'No result picked.'}</p>`;
    }

    /**
     * Keep a map in step with "What does this use?": light up the focused result
     * and the same side of it as the text. True when the map now shows the focus.
     */
    function syncMap(view) {
      const nodes = view.body._nodes;
      if (!nodes || !view.body.querySelector('.dep-map')) return false;
      if (!focusState) {
        if (view.synced) clearPick(view);
        return false;
      }
      if (focusState.set) return lightSet(view);
      const n = nodes.find((m) => m.id === focusState.id);
      const drawn = n && view.lay && view.lay.drawnOf(n);
      if (n && drawn !== n) {
        // folded into a bigger result: unfold it, then light it up
        view.expanded.add(drawn.id);
        fillDeps(view);
        return true;
      }
      if (n && view.body.querySelector(`.dep-node[data-n="${n.order}"]`)) select(view, n.order, focusState.dir);
      else clearPick(view, `${esc(focusState.name)} is lit up in the text, but it is not on the map: it refers to no other result, and none refers to it.`);
      view.synced = true;
      return true;
    }

    /** A search by use on a map: its results lit, what was searched for picked. */
    function lightSet(view) {
      const body = view.body;
      const svg = body.querySelector('.dep-map');
      if (!svg || !view.lay) return false;
      const g = getGraph();
      const on = new Set(focusState.stops.map((el) => g.byEl.get(el)).filter(Boolean).map((m) => view.lay.drawnOf(m)));
      const sel = new Set(focusState.set.inc.map((k) => g.byKey.get(k)).filter(Boolean).map((m) => view.lay.drawnOf(m)));
      svg.classList.add('dep-picked', 'dep-synced');
      svg.querySelectorAll('.dep-node').forEach((node) => {
        const m = node.dataset.n != null ? body._nodes[Number(node.dataset.n)] : null;
        node.classList.toggle('dep-sel', !!m && sel.has(m));
        node.classList.toggle('dep-down', !!m && on.has(m));
        node.classList.remove('dep-up');
      });
      svg.querySelectorAll('.dep-edge').forEach((p) => p.classList.remove('dep-lit'));
      const detail = body.querySelector('.dep-detail');
      if (detail) {
        detail.innerHTML = `<p><strong>${focusState.stops.length || 'No'} result${focusState.stops.length === 1 ? '' : 's'}</strong> ${esc(focusState.text)} ` +
          '<span class="insight-muted">lit up in the text</span> <a href="#" class="dep-unfocus" title="Show the whole page again">Done</a></p>';
      }
      view.synced = true;
      return true;
    }

    function syncMaps() {
      for (const v of views) if (v.tab === 'deps' && v.isShown()) syncMap(v);
    }

    function setHover(on, fromUi) {
      hoverOn = !!on;
      if (!hoverOn) hidePop();
      document_.querySelectorAll('.insight-hover input').forEach((b) => { b.checked = hoverOn; });
      if (fromUi && opts.onHoverChange) opts.onHoverChange(hoverOn);
    }

    // The large dialog, for a map too big for the side panel.
    let dialog = null;
    let dialogView = null;

    function build() {
      dialog = document_.createElement('dialog');
      dialog.className = 'insight-dialog';
      dialog.setAttribute('aria-label', 'Notation and dependencies');
      dialog.innerHTML =
        '<div class="insight-head">' +
        '<div class="insight-tabs" role="tablist">' +
        '<button type="button" role="tab" data-tab="deps">Map</button>' +
        '<button type="button" role="tab" data-tab="notation">Notation</button>' +
        '</div>' +
        hoverBox() +
        '<button type="button" class="insight-close" aria-label="Close">×</button>' +
        '</div><div class="insight-body"></div>';
      document_.body.appendChild(dialog);
      dialog.querySelector('.insight-close').addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => { if (popView === dialogView) hidePop(); });
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close(); // a click on the backdrop
      });
      dialog.querySelector('.insight-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-tab]');
        if (b) { dialogView.tab = b.dataset.tab; fillDialog(); }
      });
      dialog.querySelector('.insight-head').addEventListener('change', (e) => {
        if (e.target.matches('.insight-hover input')) setHover(e.target.checked, true);
      });
      dialogView = { body: dialog.querySelector('.insight-body'), tab: 'notation', selected: null, side: false, zoomable: true, leave: () => dialog.close(), isShown: () => dialog.open };
      wire(dialogView);
      // In the larger map, + − 0 (with Ctrl/Cmd or without) and F zoom the map, not
      // the page. Listened for on the document: focus falls back to the body when
      // an option redraws the map.
      document_.addEventListener('keydown', (e) => {
        if (!dialog.open || e.altKey || typing(e.target)) return;
        if (dialogView.tab === 'deps' && !dialogView.body.contains(e.target) && mapUndoKey(e)) return;
        const key = e.key;
        let dir = null;
        if (key === '+' || key === '=') dir = 1;
        else if (key === '-' || key === '_') dir = -1;
        else if (key === '0') dir = 0;
        else if ((key === 'f' || key === 'F') && !e.ctrlKey && !e.metaKey) dir = 'fit';
        if (dir === null || !zoomStep(dialogView, dir)) return;
        e.preventDefault();
        e.stopPropagation();
      });
    }

    function fillDialog() {
      dialog.querySelectorAll('.insight-tabs button').forEach((b) => { b.hidden = !tabOn(b.dataset.tab); });
      dialog.classList.toggle('insight-dialog-map', dialogView.tab === 'deps');
      dialog.querySelectorAll('.insight-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === dialogView.tab)));
      fill(dialogView);
      dialog.dataset.ms = dialogView.body.dataset.ms;
    }

    const tabOn = (t) => (t === 'deps' ? feats.map : feats.notation);
    function open(which, selected) {
      const tab = which || (dialogView && dialogView.tab) || 'notation';
      if (!tabOn(tab)) {
        const other = tab === 'deps' ? 'notation' : 'deps';
        if (!tabOn(other)) return;
        which = other;
      }
      if (!dialog) build();
      if (which) dialogView.tab = which;
      if (selected != null) dialogView.selected = selected;
      fillDialog();
      if (!dialog.open) dialog.showModal();
    }

    // M (outside text fields) opens the larger map, and closes it again.
    const typing = (t) => !!t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) ||
      (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(t.type)));
    function toggleMap() {
      if (!feats.map) return;
      if (dialog && dialog.open && dialogView.tab === 'deps') { dialog.close(); return; }
      let selected = null;
      for (const v of views) if (v !== dialogView && v.tab === 'deps' && v.isShown() && v.selected != null) selected = v.selected;
      open('deps', selected);
    }
    if (opts.mapKey !== false) {
      document_.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.key !== 'm' && e.key !== 'M')) return;
        if (typing(e.target)) return;
        const other = document_.querySelector('dialog[open]');
        if (other && other !== dialog) return;
        e.preventDefault();
        toggleMap();
      });
    }

    /**
     * Draw the notation index or the map into an element of the page, such as a
     * tab of the side panel. Returns { show(tab), refresh(), hide() }.
     */
    function mount(body, mopts) {
      mopts = mopts || {};
      body.classList.add('insight-view', 'insight-side');
      const view = {
        body, tab: 'notation', selected: null, side: true, shown: false,
        leave: mopts.onJump || (() => {}),
        isShown: () => view.shown,
      };
      wire(view);
      return {
        show(tab) {
          view.tab = tab === 'deps' ? 'deps' : 'notation';
          view.shown = true;
          fill(view);
        },
        hide() { view.shown = false; },
        refresh() { if (view.shown) fill(view); },
      };
    }


    // --- "What does this use?": light up a result's dependencies in the text ------

    // Each result gets a small button by its heading (added when the pointer
    // first comes near it, never while rendering). Pressing it lights up the
    // result, its proof, the results it rests on (directly or not) and the
    // equations it refers to, and fades the rest of the page. A bar at the
    // bottom steps through them, switches to "what uses it", and ends it.
    let focusState = null; // { id, dir, marked: [el], stops: [el], at }
    let bar = null;
    // "Hide the rest": the unrelated text is folded away instead of faded
    // (kept from one result to the next until switched off).
    let collapseRest = false;

    const USES_ICON =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<circle cx="12" cy="4" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="12.5" r="2.2" fill="currentColor"/>' +
      '<path d="M5.1 5.6 7 10.4M10.9 5.6 9 10.4" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';

    function headOf(el) {
      for (const h of el.querySelectorAll('.thm-head')) if (h.closest('.theorem') === el) return h;
      return null;
    }

    function addUsesButton(el) {
      if (!feats.uses || el._usesBtn || !el.id || el.closest(INSIDE_POPOVER)) return;
      const head = headOf(el);
      if (!head) return;
      const b = document_.createElement('button');
      b.type = 'button';
      b.className = 'uses-btn';
      b.title = 'What does this use? Light up what it rests on, and fade the rest';
      b.setAttribute('aria-label', 'What does this use?');
      b.innerHTML = USES_ICON;
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (focusState && focusState.id === el.id) unfocus();
        else focus(el, 'uses');
      });
      head.after(b);
      el._usesBtn = b;
    }
    doc.addEventListener('mouseover', (e) => {
      const t = e.target.closest && e.target.closest('.theorem[id]');
      if (t && doc.contains(t)) addUsesButton(t);
    });
    doc.addEventListener('focusin', (e) => {
      const t = e.target.closest && e.target.closest('.theorem[id]');
      if (t) addUsesButton(t);
    });

    const HEADING = /^H[1-6]$/;

    // With "Hide the rest" on, a click on a folded proof opens it, and its fold
    // arrow folds it again. This sits above the host's own proof folding (run
    // first, in the capture phase) and leaves the folds the host remembers alone.
    doc.addEventListener('click', (e) => {
      if (!focusState || !collapseRest || e.ctrlKey || e.metaKey || !e.target.closest) return;
      const proof = e.target.closest('.uses-proof');
      if (!proof || !doc.contains(proof)) return;
      const toggle = e.target.closest('.fold-toggle');
      if (proof.classList.contains('uses-open')) {
        if (!toggle || toggle.closest('.proof') !== proof || proof.classList.contains('folded')) return;
        proof.classList.remove('uses-open');
      } else {
        if (!toggle && e.target.closest('a, .math-copyable .math[data-tex]')) return;
        proof.classList.add('uses-open');
        if (proof.classList.contains('folded')) return; // the host unfolds its own fold too
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    /** The block an equation, figure or item reference lights up. */
    const blockOf = (t) => t.closest('.math-display, figure, table, .theorem, .proof, li, p') || t;

    function clearMarks() {
      if (!focusState) return;
      for (const el of focusState.marked) el.classList.remove('uses-on', 'uses-sel', 'uses-fade', 'uses-ref', 'uses-head', 'uses-guess', 'uses-proof', 'uses-open');
      doc.classList.remove('uses-focus', 'uses-collapse');
      if (focusState.btn) focusState.btn.setAttribute('aria-pressed', 'false');
    }

    /** Mark the page: keep (Map element → classes) lit, fade the rest. Returns what was marked. */
    function markKeep(keep) {
      // Fade every block that holds nothing lit; go inside the ones that do.
      const lit = new Set();
      for (const k of keep.keys()) for (let p = k.parentElement; p && p !== doc; p = p.parentElement) lit.add(p);
      const marked = [];
      const walk = (node) => {
        for (const c of node.children) {
          const cls = keep.get(c);
          if (cls) { c.classList.add(...cls.split(' ')); marked.push(c); }
          else if (lit.has(c)) walk(c);
          else if (!c.classList.contains('uses-btn')) {
            c.classList.add('uses-fade');
            if (HEADING.test(c.tagName) || (c.children.length === 1 && HEADING.test(c.firstElementChild.tagName))) c.classList.add('uses-head');
            marked.push(c);
          }
        }
      };
      walk(doc);
      doc.classList.add('uses-focus');
      doc.classList.toggle('uses-collapse', collapseRest);
      return marked;
    }

    /** The blocks a set of results refers to (equations, figures, cited works), lit with them. */
    function addRefs(keep, nodes) {
      const refs = new Set();
      for (const m of nodes) {
        for (const r of m.refs.statement) refs.add(r);
        for (const [c, e] of m.cites) if (e.statement && c.el) refs.add(c.el);
      }
      for (const r of refs) {
        const b = blockOf(r);
        if (!doc.contains(b) || Array.from(keep.keys()).some((k) => k.contains(b) || b.contains(k))) continue;
        keep.set(b, 'uses-ref');
      }
    }

    /**
     * Light up what el uses (dir 'uses'), what uses it ('usedBy'), or both
     * ('both'). collapse: also switch on "Hide the rest".
     */
    function focus(el, dir, scroll, collapse) {
      if (!el || !doc.contains(el)) return;
      if (collapse) collapseRest = true;
      if (!focusState && opts.onFocusStart) opts.onFocusStart(); // e.g. end "Show pinned results"
      clearMarks();
      hidePop();
      const g = getGraph();
      const n = g.byEl.get(el) || { el, name: thmName(el), proofs: [], refs: { statement: new Set(), proof: new Set() }, uses: new Set(), usedBy: new Set(), edges: new Map(), cites: new Map() };
      const others = Array.from(closure(n, dir)).sort((a, b) => a.order - b.order);
      // reached only through a link guessed from the wording ("the previous lemma")
      const sure = explicitClosure(n, dir);
      const guessed = others.filter((m) => !sure.has(m));
      const keep = new Map(); // element -> class
      keep.set(el, 'uses-sel');
      for (const p of n.proofs) keep.set(p, 'uses-sel');
      for (const m of others) if (!keep.has(m.el)) keep.set(m.el, sure.has(m) ? 'uses-on' : 'uses-on uses-guess');
      if (dir !== 'usedBy') {
        const refs = new Set([...n.refs.statement, ...n.refs.proof]);
        for (const m of others) for (const r of m.refs.statement) refs.add(r);
        // the works it cites, and those cited in the statements of what it uses
        for (const c of n.cites.keys()) if (c.el) refs.add(c.el);
        for (const m of others) for (const [c, e] of m.cites) if (e.statement && c.el) refs.add(c.el);
        for (const r of refs) {
          const b = blockOf(r);
          if (!doc.contains(b) || Array.from(keep.keys()).some((k) => k.contains(b) || b.contains(k))) continue;
          keep.set(b, 'uses-ref');
        }
      }
      // The proofs of the other results: faded with the rest, but with "Hide
      // the rest" on they stay, folded to their first line (a click opens one).
      for (const m of others) for (const p of m.proofs) {
        if (keep.has(p) || !doc.contains(p) || Array.from(keep.keys()).some((k) => k.contains(p) || p.contains(k))) continue;
        keep.set(p, 'uses-fade uses-proof');
      }
      const marked = markKeep(keep);
      const stops = [el].concat(others.map((m) => m.el));
      const counts = dir === 'both' ? { up: closure(n, 'uses').size, down: closure(n, 'usedBy').size } : null;
      focusState = { id: el.id, key: n.key || keyOfEl(el), dir, marked, stops, at: 0, btn: el._usesBtn || null, name: n.name, count: others.length, counts, guessed: guessed.length };
      if (focusState.btn) focusState.btn.setAttribute('aria-pressed', 'true');
      showBar();
      syncMaps();
      if (scroll) opts.jump(el);
    }

    // --- Search by use: light up every result that uses these, and none of those ---

    /** A search term from a result or displayed-equation element (or a key): a graph node, or { eq, el, key }. */
    function termOf(x) {
      const g = getGraph();
      if (typeof x === 'string') {
        if (x.startsWith('eq:')) { const el = eqEls().get(x); return el ? { eq: true, el, key: x, name: eqNameOf(el) } : null; }
        const n = g.byKey.get(x);
        return n && !n.cite ? n : null;
      }
      if (!x) return null;
      const n = g.byEl.get(x);
      if (n) return n;
      const el = x.closest && x.closest('.math-display');
      return el ? { eq: true, el, key: eqKeyOf(el), name: eqNameOf(el) } : null;
    }

    /** "Lemma 2 and (3.1)", "Lemma 2 or Lemma 3". */
    const joinNames = (terms, word) => {
      const names = terms.map((t) => t.name);
      return names.length < 3 ? names.join(` ${word} `) : names.slice(0, -1).join(', ') + ` ${word} ` + names[names.length - 1];
    };

    /**
     * Search by use. q: { inc: [element or key], exc: [...], any, direct }.
     * Returns { results: [result elements], inc: [names], exc: [names], text } or
     * null when a term is neither a result nor a displayed equation.
     */
    function searchUses(q) {
      const g = getGraph();
      const inc = (q.inc || []).map(termOf);
      const exc = (q.exc || []).map(termOf);
      if (inc.some((t) => !t) || exc.some((t) => !t)) return null;
      const found = searchByUse(g, { inc, exc, any: !!q.any, direct: !!q.direct });
      let text = inc.length ? `use${q.direct ? ' directly' : ''} ${joinNames(inc, q.any ? 'or' : 'and')}` : '';
      if (exc.length) text += (inc.length ? ' but not ' : `do not use${q.direct ? ' directly' : ''} `) + joinNames(exc, 'or');
      return { results: found.map((n) => n.el), nodes: found, inc, exc, text };
    }

    /** Light up the results a search by use finds, and fade the rest. at: the result to go to. */
    function showUses(q, at, scroll, collapse) {
      const res = searchUses(q);
      if (!res) return null;
      if (collapse) collapseRest = true;
      if (!focusState && opts.onFocusStart) opts.onFocusStart();
      clearMarks();
      hidePop();
      const keep = new Map();
      // what was searched for stays lit; what was searched against stays visible, not lit
      for (const t of res.inc) if (doc.contains(t.el)) keep.set(t.el, 'uses-sel');
      for (const t of res.exc) if (doc.contains(t.el) && !keep.has(t.el)) keep.set(t.el, 'uses-ref');
      for (const n of res.nodes) if (!keep.has(n.el)) keep.set(n.el, 'uses-on');
      for (const n of res.nodes) for (const p of n.proofs) {
        if (keep.has(p) || !doc.contains(p) || Array.from(keep.keys()).some((k) => k.contains(p) || p.contains(k))) continue;
        keep.set(p, 'uses-fade uses-proof');
      }
      addRefs(keep, res.nodes);
      const marked = markKeep(keep);
      const stops = res.nodes.map((n) => n.el);
      let k = at ? stops.indexOf(at) : 0;
      if (k < 0) k = 0;
      focusState = {
        id: null, key: null, dir: 'set', marked, stops, at: k, btn: null, name: '', count: stops.length, guessed: 0,
        set: { inc: res.inc.map((t) => t.key), exc: res.exc.map((t) => t.key), any: !!q.any, direct: !!q.direct }, text: res.text,
      };
      showBar();
      syncMaps();
      if (scroll && stops[k]) opts.jump(stops[k]);
      return res;
    }

    function unfocus() {
      clearMarks();
      focusState = null;
      if (bar) bar.hidden = true;
      syncMaps();
    }

    /** After a new render: light up the same result again, if it is still there. */
    function refocus() {
      if (!focusState) return;
      const { id, dir, set } = focusState;
      focusState = null;
      if (set) {
        if (!showUses(set)) {
          doc.classList.remove('uses-focus');
          if (bar) bar.hidden = true;
          syncMaps();
        }
        return;
      }
      const el = document_.getElementById(id);
      if (el && doc.contains(el) && el.classList.contains('theorem')) focus(el, dir);
      else {
        doc.classList.remove('uses-focus');
        if (bar) bar.hidden = true;
        syncMaps();
      }
    }

    function showBar() {
      if (!bar) {
        bar = document_.createElement('div');
        bar.className = 'uses-bar';
        bar.setAttribute('role', 'status');
        bar.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b || !focusState) return;
          if (b.dataset.act === 'done') return unfocus();
          if (b.dataset.act === 'print') return opts.print();
          if (b.dataset.act === 'edit') return opts.onEditSearch(focusState.set);
          if (b.dataset.act === 'pin') {
            setPin(focusState.key, pinMap().get(focusState.key) === focusState.dir ? '' : focusState.dir);
            return showBar();
          }
          if (b.dataset.act === 'collapse') {
            collapseRest = !collapseRest;
            doc.classList.toggle('uses-collapse', collapseRest);
            showBar();
            // stay with the result being read
            opts.jump(focusState.stops[focusState.at]);
            return;
          }
          if (b.dataset.dir) {
            const el = document_.getElementById(focusState.id);
            return focus(el, b.dataset.dir);
          }
          const k = focusState.stops.length;
          if (!k) return;
          focusState.at = (focusState.at + (b.dataset.act === 'next' ? 1 : -1) + k) % k;
          opts.jump(focusState.stops[focusState.at]);
          showBar();
        });
        document_.body.appendChild(bar);
      }
      const f = focusState;
      const results = (k) => `${k} result${k > 1 ? 's' : ''}`;
      const step = f.stops.length > 1
        ? `<button type="button" data-act="prev" aria-label="Previous" title="Previous">‹</button><span class="uses-step">${f.at + 1}/${f.stops.length}</span><button type="button" data-act="next" aria-label="Next" title="Next">›</button>`
        : '';
      const rest =
        `<button type="button" data-act="collapse" aria-pressed="${collapseRest}" title="Fold away the text that has nothing to do with it, or bring it back faded">Hide the rest</button>` +
        (opts.print ? '<button type="button" data-act="print" title="Print what is shown, or save it as a PDF (with Hide the rest on, only that; folded proofs are left out)">Print</button>' : '') +
        '<button type="button" data-act="done" class="uses-done" title="Show the whole page again (Esc)">Done</button>';
      if (f.set) {
        const n = f.stops.length;
        bar.innerHTML =
          `<span class="uses-what"><strong>${n ? results(n) : 'No result'}</strong> ${esc(f.text)}</span>` +
          (opts.onEditSearch ? '<button type="button" data-act="edit" title="Change the search">Change</button>' : '') +
          step + rest;
        bar.hidden = false;
        return;
      }
      const what = f.dir === 'uses'
        ? (f.count ? `uses ${results(f.count)}` : 'uses no other numbered result')
        : f.dir === 'usedBy'
          ? (f.count ? `is used in ${results(f.count)}` : 'is not used in any numbered result')
          : (f.count
            ? `uses ${f.counts.up ? results(f.counts.up) : 'none'}, is used in ${f.counts.down ? results(f.counts.down) : 'none'}`
            : 'neither uses nor is used in any numbered result');
      const guess = f.guessed ? ` <span class="uses-guessed" title="Named in the text without a link (“the previous lemma”, “Lemma 2.3”), so TeXglass guessed which result is meant. These have a dashed outline.">(${f.guessed} guessed)</span>` : '';
      bar.innerHTML =
        `<span class="uses-what"><strong>${esc(f.name)}</strong> ${what}${guess}</span>` +
        `<span class="uses-dir" role="group" aria-label="Direction"><button type="button" data-dir="uses" aria-pressed="${f.dir === 'uses'}">Uses</button>` +
        `<button type="button" data-dir="usedBy" aria-pressed="${f.dir === 'usedBy'}">Used in</button>` +
        `<button type="button" data-dir="both" aria-pressed="${f.dir === 'both'}" title="What it uses and what uses it">Both</button></span>` +
        step +
        `<button type="button" data-act="pin" aria-pressed="${pinMap().get(f.key) === f.dir}" title="Pin ${esc(f.name)} with ${f.dir === 'uses' ? 'what it uses' : f.dir === 'usedBy' ? 'what uses it' : 'what it uses and what uses it'}, to show only these later (Show pinned) or save them">${pinMap().get(f.key) === f.dir ? 'Pinned' : 'Pin'}</button>` +
        rest;
      bar.hidden = false;
    }

    document_.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && focusState && !e.defaultPrevented && !document_.querySelector('dialog[open]')) unfocus();
    });

    // after the page changed: redraw what is showing
    let refreshTimer = null;
    refreshViews = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        for (const v of views) if (v.isShown()) fill(v);
      }, 300);
    };

    return {
      open,
      toggleMap,
      mount,
      invalidate,
      setDefinitions,
      usedByNote,
      setHover: (on) => setHover(on, false),
      /** Arrange the notation index: 'section', 'kind' or 'az'. */
      setNotationOrder: (order) => setNotationOrder(order, false),
      notationOrder: () => notationOrder,
      /** Keep "Used in …" in view at the top of the side panel's Notation tab. */
      setUsedPinned: (on) => setUsedPinned(on, false),
      /** The host's pins changed (another paper opened): draw them. */
      refreshPins: () => { pinned = readPins(); for (const v of views) if (v.tab === 'notation' && v.isShown()) fillNotation(v); pinsChanged(); },
      /** Switch parts on or off: { map, notation, uses, words } (missing keys stay as they are). */
      setFeatures(f) {
        const before = Object.assign({}, feats);
        for (const k of Object.keys(feats)) if (f && typeof f[k] === 'boolean') feats[k] = f[k];
        doc.classList.toggle('tg-no-uses', !feats.uses);
        if (!feats.uses && focusState) unfocus();
        if (before.words !== feats.words) { index = null; hidePop(); }
        if (dialog && dialog.open && !tabOn(dialogView.tab)) dialog.close();
        if (Object.keys(feats).some((k) => before[k] !== feats[k])) refreshViews();
      },
      features: () => Object.assign({}, feats),
      // o: { scroll, collapse } (collapse switches on "Hide the rest")
      focus: (el, dir, o) => focus(el, dir || 'uses', !!(o && o.scroll), !!(o && o.collapse)),
      /** How many results el uses and is used in, directly or not, or null if it is not a result. */
      related: (el) => {
        const n = getGraph().byEl.get(el);
        return n ? { uses: closure(n, 'uses').size, usedBy: closure(n, 'usedBy').size } : null;
      },
      /**
       * Search by use: { inc: [result or equation elements], exc: [...], any, direct }
       * → { results: [elements], text } (null if a term is not a result or equation).
       */
      searchUses: (q) => { const r = searchUses(q); return r && { results: r.results, text: r.text }; },
      /** Light up what searchUses(q) finds and fade the rest; o: { at: element, scroll, collapse }. */
      showUses: (q, o) => !!showUses(q, o && o.at, !!(o && o.scroll), !!(o && o.collapse)),
      unfocus,
      repaint,
      focused: () => (focusState ? { id: focusState.id, dir: focusState.dir, search: focusState.set ? Object.assign({ text: focusState.text }, focusState.set) : null } : null),
      graph: getGraph,
      index: getIndex,
      notesFor,
      // --- the reader's changes to the map (pins, hidden results, own links, layout, saved maps)
      /** The host's copy changed (another device, an import): read it again and redraw. */
      refreshEdits() {
        edits = readEdits();
        committed = edits;
        undoStack.length = 0;
        redoStack.length = 0;
        if (graph) applyLinks(graph, edits.link);
        for (const v of views) if (v.tab === 'deps' && v.isShown()) fillDeps(v);
        markPins();
        if (focusState) refocus();
        pinsChanged();
      },
      /** The elements "Show pinned" shows, pins with their submaps brought along. */
      pinnedEls,
      /** How many results and equations are pinned (on the map). */
      pinCount: () => pinMap().size,
      /** Everything pinned: map pins and Notation rows (see pinnedList above). */
      pinnedList,
      /** How many things are pinned anywhere: map pins and Notation rows. */
      allPinCount: () => pinMap().size + pinned.size,
      /** A pin button for the preview of a result or numbered equation (null for anything else). */
      pinButtonFor,
      /** Unpin one item of pinnedList by its key. */
      unpinKey,
      /** Hear of every change to the pins; returns a function that stops it. */
      onPins: (fn) => { pinListeners.add(fn); return () => pinListeners.delete(fn); },
      /** Fill elements carrying data-sym (TeX) with the rendered symbol, the document's macros known. */
      renderSymbols,
      /** Whether a result or numbered equation element is pinned (any way). */
      isPinned: (el) => { const k = keyOfEl(el); return !!(k && pinMap().has(k)); },
      /** Pin (d 'self' | 'uses' | 'usedBy' | 'both') or unpin ('') a result or numbered equation element. */
      pin: (el, d) => setPin(keyOfEl(el), d == null ? 'self' : d),
      /** Pin or unpin it (just it). */
      togglePin: (el) => { const k = keyOfEl(el); if (k) setPin(k, pinMap().has(k) ? '' : 'self'); },
      unpinAll,
      undo,
      redo,
      resetMap,
      saveView,
      loadView,
      deleteView,
      savedViews: () => savedViews().map(([name]) => name),
      setLocked: (on) => setLocked(on, false),
      locked: () => locked,
    };
  }

  /**
   * The side panel: tabs Contents, Map and Notation over the table of
   * contents, and a divider that drags to resize it (the width is remembered).
   *
   *   TeXglassInsight.sidePanel({
   *     pane, head, list,                 // the panel, its head row, the contents list
   *     insight,                          // from attach()
   *     store: { get(k), set(k, v) },     // where the tab and width are kept
   *     onTab(tab) { ... },               // optional
   *   });
   */
  function sidePanel(o) {
    const doc = o.pane.ownerDocument || document;
    const tabs = doc.createElement('div');
    tabs.className = 'side-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.innerHTML = [['toc', 'Contents'], ['deps', 'Map'], ['notation', 'Notation']]
      .map(([k, label]) => `<button type="button" role="tab" data-side-tab="${k}">${label}</button>`).join('');
    const title = o.head.querySelector('.toc-pane-title');
    if (title) title.replaceWith(tabs);
    else o.head.prepend(tabs);
    const body = doc.createElement('div');
    body.className = 'side-insight';
    body.hidden = true;
    o.list.after(body);
    const view = o.insight ? o.insight.mount(body, { onJump: o.onJump }) : null;
    if (!view) tabs.querySelectorAll('[data-side-tab="notation"], [data-side-tab="deps"]').forEach((b) => b.remove());

    // Stack the tabs when one row does not fit the panel.
    function fitTabs() {
      tabs.classList.remove('side-tabs-stacked');
      if (tabs.scrollWidth > tabs.clientWidth + 1) tabs.classList.add('side-tabs-stacked');
      // the head's height, for what sticks under it (the Notation tab's "Used in …")
      o.pane.style.setProperty('--side-head-h', o.head.offsetHeight + 'px');
    }
    const win = doc.defaultView || window;
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(fitTabs).observe(o.head);
    else win.addEventListener('resize', fitTabs);

    let tab = 'toc';
    const off = new Set(); // tabs switched off in Settings
    function show(t, quiet) {
      tab = view && (t === 'notation' || t === 'deps') && !off.has(t) ? t : 'toc';
      tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.sideTab === tab)));
      o.list.hidden = tab !== 'toc';
      body.hidden = tab === 'toc';
      o.pane.dataset.tab = tab;
      if (view) {
        if (tab === 'toc') view.hide();
        else view.show(tab);
      }
      if (o.store && !quiet) o.store.set('texglass:side-tab', tab);
      if (o.onTab) o.onTab(tab);
    }
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-side-tab]');
      if (b) show(b.dataset.sideTab);
    });

    // The divider: drag the panel's inner edge.
    const grip = doc.createElement('div');
    grip.className = 'side-resizer';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', 'Resize the side panel');
    grip.tabIndex = 0;
    grip.title = 'Drag to resize · double-click to reset';
    o.pane.after(grip);
    const MIN = 180;
    const maxWidth = () => Math.max(MIN, Math.round((doc.defaultView || window).innerWidth * 0.7));
    const setWidth = (w, save) => {
      if (w == null) {
        doc.body.style.removeProperty('--side-width');
        if (save && o.store) o.store.set('texglass:side-width', '');
        return;
      }
      w = Math.round(Math.min(maxWidth(), Math.max(MIN, w)));
      doc.body.style.setProperty('--side-width', w + 'px');
      grip.setAttribute('aria-valuenow', String(w));
      fitTabs();
      if (save && o.store) o.store.set('texglass:side-width', String(w));
    };
    const right = () => doc.body.classList.contains('toc-right');
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const width = o.pane.getBoundingClientRect().width;
      doc.body.classList.add('side-resizing');
      const move = (ev) => setWidth(width + (right() ? start - ev.clientX : ev.clientX - start), false);
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        doc.body.classList.remove('side-resizing');
        setWidth(o.pane.getBoundingClientRect().width, true);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => setWidth(null, true));
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = (e.key === 'ArrowRight') !== right();
      setWidth(o.pane.getBoundingClientRect().width + (grow ? 20 : -20), true);
    });
    const saved = o.store ? parseFloat(o.store.get('texglass:side-width')) : NaN;
    if (!isNaN(saved)) setWidth(saved, false);
    show((o.store && o.store.get('texglass:side-tab')) || 'toc', true);

    return {
      show: (t) => show(t, true),
      tab: () => tab,
      /** Show or hide the Map and Notation tabs: { deps, notation }. */
      setTabs(f) {
        for (const k of ['deps', 'notation']) {
          if (f && f[k] === false) off.add(k);
          else if (f && f[k] === true) off.delete(k);
          const b = tabs.querySelector(`[data-side-tab="${k}"]`);
          if (b) b.hidden = off.has(k);
        }
        if (off.has(tab)) show('toc', true);
        fitTabs();
      },
      setWidth: (w) => setWidth(w, false),
    };
  }

  const api = { attach, sidePanel, dependencyGraph, usersOf, searchByUse, notationIndex, kindOfSymbol, alphaOf, greekQuery, definedSymbol, proseDefinitions, texTokens, patternOf, occurrences, layout, foldGroups, mentionsIn };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassInsight = api;
})(typeof self !== 'undefined' ? self : this);
