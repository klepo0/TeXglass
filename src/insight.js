/*
 * Reading aids built from the rendered page, in the web viewer and the VS Code
 * preview:
 *
 *   - notation on hover: resting the pointer on a formula shows where its
 *     notation comes from (the paper's own macros, and symbols defined with :=);
 *   - a dependency map: which results each theorem's statement and proof refer to;
 *   - a notation index: the paper's macros and defined symbols, with first uses;
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
 *   });
 *   insight.setDefinitions(result.defs);   // after each render: the paper's macros
 *   insight.invalidate();                  // after the page changed
 *   insight.open('notation' | 'deps');     // the panel
 *   insight.usedByNote(target);            // "Used in …" for the reference popover, or null
 *   insight.focus(theoremEl, 'uses' | 'usedBy'); insight.unfocus();
 */
(function (root) {
  'use strict';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------------------------------------------------------------------
  // Reading the page
  // ---------------------------------------------------------------------------

  const INSIDE_POPOVER = '.ref-popover, .insight-popover, .insight-dialog';

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

  /** A key for matching a symbol inside other formulas: no spaces, no optional braces around one token. */
  const keyOf = (s) => s.replace(/\s+/g, '').replace(/\{(\\?[A-Za-z0-9]+)\}/g, '$1');

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
    return { nodes, byEl, cites, sections };
  }

  /**
   * The paper's notation: { macros, symbols, byName }.
   * macros: [{ name, mac, first, count }] for the macros its formulas use;
   * symbols: [{ tex, key, el }] for the symbols defined with := and the like.
   */
  function notationIndex(doc, definitions) {
    const macros = (definitions && definitions.macros) || {};
    const byName = new Map();
    const symbols = [];
    const seen = new Set();
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
        if (s) {
          const key = keyOf(s);
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({ tex: s, key, el });
          }
        }
      }
    }
    // in the order a reader meets them
    return { macros: Array.from(byName.values()), symbols, byName };
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

    // the edges between what is drawn, merged: [{ a, b, statement, proof, guessed, cite }]
    const edgeMap = new Map();
    const key = (x) => (x.cite ? 'c' + x.order : String(x.order));
    const addEdge = (a, b, e, cite) => {
      if (a === b) return;
      const k = key(a) + '>' + key(b);
      let d = edgeMap.get(k);
      if (!d) {
        d = { a, b, statement: false, proof: false, guessed: true, cite: !!cite };
        edgeMap.set(k, d);
      }
      d.statement = d.statement || !!e.statement;
      d.proof = d.proof || !!e.proof;
      if (!e.guessed) d.guessed = false;
    };
    for (const n of graph.nodes) {
      const b = drawnOf(n);
      for (const [dep, e] of n.edges) addEdge(drawnOf(dep), b, e);
      if (showCites) for (const [c, e] of n.cites) addEdge(c, b, { statement: e.statement, proof: e.proof, guessed: false }, true);
    }
    const edges = Array.from(edgeMap.values());
    const into = new Map(); // drawn thing → [edges into it]
    const has = new Set();
    for (const e of edges) {
      has.add(e.a);
      has.add(e.b);
      if (!into.has(e.b)) into.set(e.b, []);
      into.get(e.b).push(e);
    }
    const nodes = graph.nodes.filter((n) => has.has(n));
    const cites = showCites ? graph.cites.filter((c) => has.has(c)) : [];

    // columns
    const col = new Map();
    const visiting = new Set();
    const colOf = (n) => {
      if (col.has(n)) return col.get(n);
      if (n.cite) { col.set(n, 0); return 0; }
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

    // bands: one per section, in the paper's order, or one for everything
    const sectionOf = new Map();
    for (const n of nodes) sectionOf.set(n, n.section || null);
    for (const c of cites) {
      // a cited work sits with the first result that cites it
      let first = null;
      for (const e of edges) if (e.a === c && (!first || e.b.order < first.order)) first = e.b;
      sectionOf.set(c, first ? first.section || null : null);
    }
    const used = new Set(sectionOf.values());
    const grouped = !!o.sections && used.size > 1;
    const bands = [];
    if (grouped) {
      if (used.has(null)) bands.push({ section: null, items: [] });
      for (const s of graph.sections || []) if (used.has(s)) bands.push({ section: s, items: [] });
    } else bands.push({ section: null, items: [] });
    const bandOf = new Map(bands.map((b) => [b.section, b]));
    for (const x of [...cites, ...nodes]) (grouped ? bandOf.get(sectionOf.get(x)) : bands[0]).items.push(x);

    const ROW = 34;
    const H = 24;
    const LABEL = grouped ? 20 : 0;
    const shownFold = new Map(); // result → the lemmas folded into it, on this map
    for (const [r, list] of groups) if (has.has(r) && !(o.expanded && o.expanded.has(r.id))) shownFold.set(r, list);
    const width = (n) => (n.cite ? Math.min(150, 16 + (n.label.length + n.who.length + 1) * 6.6) : Math.min(190, 18 + n.name.length * 7.2) + (shownFold.has(n) ? 26 : 0));
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
      delete band.items;
    }
    return {
      nodes, cites, edges, x: xs, y, width, H, bands: grouped ? bands : [], grouped,
      drawnOf, foldedInto, groups, shownFold,
      size: { w: Math.max(x - 58, 200), h: Math.max(top + 4, 40) },
    };
  }

  function mapSvg(lay) {
    const parts = [];
    const { H } = lay;
    const k = (x) => (x.cite ? 'c' + x.order : String(x.order));
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
      const x1 = lay.x.get(d) + lay.width(d);
      const y1 = lay.y.get(d) + H / 2;
      const x2 = lay.x.get(n);
      const y2 = lay.y.get(n) + H / 2;
      const back = x2 <= x1;
      const dx = back ? 40 : Math.max(24, (x2 - x1) / 2);
      const cls = 'dep-edge' + (e.cite ? ' dep-cite-edge' : e.proof ? ' dep-proof' : ' dep-stmt') + (e.guessed && !e.cite ? ' dep-guess' : '');
      parts.push(`<path class="${cls}" data-from="${k(d)}" data-to="${k(n)}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2 - 4},${y2}" marker-end="url(#dep-arrow)"/>`);
    }
    for (const c of lay.cites) {
      const cw = lay.width(c);
      const label = `${c.label} ${c.who}`.trim();
      parts.push(
        `<g class="dep-node dep-citenode" data-c="${c.order}" tabindex="0" role="button" aria-label="${esc('Cited work ' + label)}">` +
          `<rect x="${lay.x.get(c)}" y="${lay.y.get(c)}" width="${cw}" height="${H}" rx="${H / 2}"/>` +
          `<text x="${lay.x.get(c) + cw / 2}" y="${lay.y.get(c) + H / 2 + 4.5}" text-anchor="middle">${esc(label.length > 22 ? label.slice(0, 21) + '…' : label)}</text></g>`
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
        `<g class="dep-node dep-${n.style}${main}${folded ? ' dep-has-fold' : ''}" data-n="${n.order}" tabindex="0" role="button" aria-label="${esc(n.name + (n.note ? ' (' + n.note + ')' : '') + (folded ? `, with ${folded.length} lemmas folded in` : ''))}">` +
          `<rect x="${x}" y="${y}" width="${nw}" height="${H}" rx="5"/>` +
          `<text x="${x + tw / 2}" y="${y + H / 2 + 4.5}" text-anchor="middle">${esc(label)}</text></g>`
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
    if (any((e) => !e.cite && e.proof && !e.guessed)) items.push(`${line('dep-proof')} used in a proof`);
    if (any((e) => !e.cite && !e.proof && !e.guessed)) items.push(`${line('dep-stmt')} named in a statement`);
    if (any((e) => !e.cite && e.guessed)) items.push(`${line('dep-proof dep-guess')} guessed from the wording (no link)`);
    if (lay.cites.length) items.push('<span class="dep-key-cite" aria-hidden="true"></span> cited work');
    if (lay.shownFold.size) items.push('<span class="dep-key-fold" aria-hidden="true">+2</span> lemmas folded in (pick to show)');
    return items.length ? `<div class="dep-legend">${items.map((i) => `<span>${i}</span>`).join('')}</div>` : '';
  }

  /** Everything n uses, directly or not (dir 'uses'), or everything that uses it ('usedBy'). */
  function closure(n, dir) {
    const out = new Set();
    const stack = [n];
    while (stack.length) {
      for (const m of stack.pop()[dir]) if (!out.has(m) && m !== n) { out.add(m); stack.push(m); }
    }
    return out;
  }

  /** As closure(), but only along links written in the text, not guessed ones. */
  function explicitClosure(n, dir) {
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
    const symbolCache = new Map(); // tex -> html

    const getGraph = () => graph || (graph = dependencyGraph(doc));
    const getIndex = () => index || (index = notationIndex(doc, defs));
    const getLocate = () => locate || (locate = makeLocator(doc));
    const where = (el) => getLocate()(el, getGraph());

    let refreshViews = () => {};
    function invalidate() {
      graph = null;
      index = null;
      locate = null;
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
      const key = keyOf(tex);
      const own = definedSymbol(tex);
      for (const s of idx.symbols) {
        if (s.el === el || s.key.length < 2 || (own && keyOf(own) === s.key)) continue;
        if (!key.includes(s.key)) continue;
        // a one-letter command like \phi must not match inside \phi_n's neighbour \varphi
        const at = key.indexOf(s.key);
        const after = key[at + s.key.length];
        if (/^\\[A-Za-z]+$/.test(s.key) && after && /[A-Za-z]/.test(after)) continue;
        out.push({ kind: 'symbol', s });
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
      if (n.kind === 'symbol') {
        return `<div class="insight-note"><div class="insight-note-what"></div>` +
          `<div class="insight-note-where">Defined in <a href="#" data-go="s">${esc(where(n.s.el))}</a></div></div>`;
      }
      const e = n.e;
      const sample = sampleOf(e);
      const first = e.first === el ? 'first used here' : `first used in <a href="#" data-go="m">${esc(where(e.first))}</a>`;
      return `<div class="insight-note"><div class="insight-note-what">${sample ? `<span class="insight-sym" data-sym="${esc(sample)}"></span> ` : ''}<code>${esc(definitionOf(e))}</code></div>` +
        `<div class="insight-note-where">Macro, ${first}${e.count > 1 ? ` · ${e.count} formulas` : ''}</div></div>`;
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
        if (n.kind === 'symbol') box.querySelector('.insight-note-what').appendChild(copyOf(n.s.el));
        const go = box.querySelector('a[data-go]');
        if (go) go._target = n.kind === 'symbol' ? n.s.el : n.e.first;
      });
      renderSymbols(body);
      if (pop.parentNode !== document_.body) document_.body.appendChild(pop);
      pop.replaceChildren(body);
      pop.hidden = false;
      popFor = el;
      const r = el.getBoundingClientRect();
      const width = Math.min(520, window.innerWidth - 32);
      pop.style.width = width + 'px';
      pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
      const h = pop.offsetHeight;
      pop.style.top = (r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h : r.bottom) + 'px';
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
    pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pop.addEventListener('mouseleave', (e) => {
      if (popFor && popFor.contains(e.relatedTarget)) return;
      hideTimer = setTimeout(() => hidePop(true), 250);
    });
    pop.addEventListener('click', (e) => {
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
      const n = g.dataset.c != null ? view.body._cites && view.body._cites[Number(g.dataset.c)] : view.body._nodes && view.body._nodes[Number(g.dataset.n)];
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
      const r = g.getBoundingClientRect();
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
      pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
      const h = pop.offsetHeight;
      pop.style.top = (r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h : r.bottom) + 'px';
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

    // --- views: the side panel's Notation and Map tabs, and the large dialog --------

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
          if (node.dataset.c != null) selectCite(view, Number(node.dataset.c));
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
        else pick(view, Number(node.dataset.n));
      });
      body.addEventListener('input', (e) => {
        if (e.target.matches('.insight-filter')) filterNotation(view, e.target.value);
      });
      body.addEventListener('change', (e) => {
        if (e.target.matches('.insight-hover input')) setHover(e.target.checked, true);
        if (e.target.matches('.dep-opts input[data-opt]')) {
          mapOpts[e.target.dataset.opt] = e.target.checked;
          if (e.target.dataset.opt === 'fold') for (const v of views) v.expanded = new Set();
          for (const v of views) if (v.tab === 'deps' && v.isShown()) fillDeps(v);
        }
      });
      wirePreviews(view);
      views.add(view);
    }

    function fill(view) {
      const t0 = Date.now();
      if (view.tab === 'deps') fillDeps(view);
      else fillNotation(view);
      view.body.dataset.ms = String(Date.now() - t0);
    }

    const hoverBox = () =>
      `<label class="insight-hover"><input type="checkbox"${hoverOn ? ' checked' : ''}> Show notation when resting on a formula</label>`;

    function fillNotation(view) {
      const body = view.body;
      const idx = getIndex();
      if (!idx.macros.length && !idx.symbols.length) {
        body.innerHTML = '<p class="insight-empty">This document defines no notation of its own: no macros used in its formulas, and no symbols defined with := .</p>' + (view.side ? hoverBox() : '');
        return;
      }
      let html = '<input class="insight-filter" type="search" placeholder="Filter by command or text" aria-label="Filter the notation">';
      if (idx.macros.length) {
        html += `<h3>Macros <span class="insight-count">${idx.macros.length}</span></h3><table class="insight-table"><tbody>`;
        idx.macros.forEach((e, k) => {
          const sample = sampleOf(e);
          const body = String(e.mac.body);
          html += `<tr data-k="m${k}" data-text="${esc((e.name + ' ' + body).toLowerCase())}"><td class="insight-sym-cell">${sample ? `<span class="insight-sym" data-sym="${esc(sample)}"></span>` : ''}</td>` +
            `<td class="insight-cmd"><code>\\${esc(e.name)}</code></td><td class="insight-def"><code>${esc(body.length > 90 ? body.slice(0, 87) + '…' : body)}</code></td>` +
            `<td class="insight-first"><a href="#" data-m="${k}">${esc(where(e.first))}</a><span class="insight-uses">${e.count} formula${e.count > 1 ? 's' : ''}</span></td></tr>`;
        });
        html += '</tbody></table>';
      }
      if (idx.symbols.length) {
        html += `<h3>Defined in the text <span class="insight-count">${idx.symbols.length}</span></h3><ol class="insight-symbols">`;
        idx.symbols.forEach((s, k) => {
          html += `<li data-k="s${k}" data-text="${esc(s.el.dataset.tex.toLowerCase())}"><span class="insight-sym" data-sym="${esc(s.tex)}"><code>${esc(s.tex)}</code></span><span class="insight-sym-src"></span><a href="#" data-s="${k}">${esc(where(s.el))}</a></li>`;
        });
        html += '</ol>';
      }
      if (view.side) html += hoverBox();
      body.innerHTML = html;
      body.querySelectorAll('a[data-m]').forEach((a) => { a.dataset.go = ''; a._target = idx.macros[Number(a.dataset.m)].first; });
      body.querySelectorAll('a[data-s]').forEach((a) => {
        const s = idx.symbols[Number(a.dataset.s)];
        a.dataset.go = '';
        a._target = s.el;
        a.previousElementSibling.appendChild(copyOf(s.el));
      });
      renderSymbols(body);
    }

    function filterNotation(view, q) {
      q = q.trim().toLowerCase().replace(/^\\/, '');
      view.body.querySelectorAll('[data-text]').forEach((row) => {
        row.hidden = !!q && !row.dataset.text.includes(q);
      });
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
      const lay = layout(g, { cites: mapOpts.cites, sections: mapOpts.sections, fold, expanded: view.expanded });
      view.lay = lay;
      body._nodes = g.nodes;
      body._cites = g.cites;
      if (!lay.nodes.length && !lay.cites.length) {
        body.innerHTML = '<p class="insight-empty">No result in this document refers to another one, so there is nothing to map. (The map is drawn from the \\ref and \\cref links in statements and proofs, from results named by hand such as “Lemma 2.3” or “the previous lemma”, and from citations.)</p>';
        return;
      }
      let links = 0;
      let guessed = 0;
      for (const n of g.nodes) for (const e of n.edges.values()) { links++; if (e.guessed) guessed++; }
      const counts = `${linked.length} result${linked.length === 1 ? '' : 's'}, ${links} link${links === 1 ? '' : 's'} between them` +
        (guessed ? ` (${guessed} guessed from the wording)` : '') +
        (g.cites.length ? `, ${g.cites.length} cited work${g.cites.length === 1 ? '' : 's'}` : '');
      const box = (k, label, on, title) => `<label title="${esc(title)}"><input type="checkbox" data-opt="${k}"${on ? ' checked' : ''}> ${label}</label>`;
      const opts_ = [];
      if (g.sections.length > 1) opts_.push(box('sections', 'Sections', mapOpts.sections, 'Group the results by the section they sit in'));
      if (g.cites.length) opts_.push(box('cites', 'Citations', mapOpts.cites, 'Show the works cited in statements and proofs'));
      if (foldGroups(g).size) opts_.push(box('fold', 'Fold lemmas', fold, 'Fold chains of lemmas that serve only one result into that result'));
      const controls = opts_.length ? `<div class="dep-opts">${opts_.join('')}</div>` : '';
      body.innerHTML = view.side
        ? `<p class="insight-lead">${counts}. Each arrow goes to a result that uses the one it starts from; pick one to light up what it rests on. <a href="#" class="dep-larger">Larger map</a></p>` +
          controls + `<div class="dep-wrap">${mapSvg(lay)}</div>${legendHtml(lay)}<div class="dep-detail" aria-live="polite"></div>`
        : `<p class="insight-lead">${counts}, read from the links in statements and proofs, from results named by hand, and from citations. ` +
          'Each arrow goes from a result to one that uses it. Pick a result to light up what it rests on and what rests on it.</p>' +
          controls + `<div class="dep-wrap">${mapSvg(lay)}</div>${legendHtml(lay)}<div class="dep-detail" aria-live="polite"></div>`;
      view.synced = false;
      if (focusState && syncMap(view)) return;
      if (view.selected != null && g.nodes[view.selected]) select(view, view.selected);
      else if (view.selectedCite != null && g.cites[view.selectedCite]) selectCite(view, view.selectedCite);
      else body.querySelector('.dep-detail').innerHTML = '<p class="insight-muted">No result picked.</p>';
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
      if (focusState && n.el && doc.contains(n.el)) focus(n.el, focusState.dir, true);
      else select(view, k);
    }

    /** What a key on the map (data-n, data-from…) stands for: a result, or "c3", a cited work. */
    const thingOf = (body, key) => (String(key)[0] === 'c' ? body._cites[Number(String(key).slice(1))] : body._nodes[Number(key)]);

    /** Light up these on a map: { sel, up: Set, down: Set }, results or cited works, as drawn. */
    function lightMap(view, sel, up, down) {
      const body = view.body;
      const svg = body.querySelector('.dep-map');
      const lay = view.lay;
      const drawn = (set) => new Set(Array.from(set, (m) => (m.cite ? m : lay.drawnOf(m))));
      const U = drawn(up);
      const D = drawn(down);
      U.delete(sel);
      D.delete(sel);
      svg.classList.add('dep-picked');
      svg.querySelectorAll('.dep-node').forEach((g) => {
        const m = thingOf(body, g.dataset.c != null ? 'c' + g.dataset.c : g.dataset.n);
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
      const node = svg.querySelector(sel.cite ? `.dep-node[data-c="${sel.order}"] rect` : `.dep-node[data-n="${sel.order}"] rect`);
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
    function pickList(set, edgeOf) {
      if (!set.size) return '<span class="insight-muted">nothing</span>';
      return Array.from(set).sort((a, b) => a.order - b.order).map((m) => {
        const e = edgeOf && edgeOf(m);
        let tag = '';
        if (e && e.guessed) tag = ` <span class="dep-tag dep-tag-guess" title="${esc(`No link in the text: guessed from “${e.why}”`)}">guessed</span>`;
        else if (e && !e.proof) tag = ' <span class="dep-tag" title="Named in the statement, not in a proof">statement</span>';
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
      detail.innerHTML =
        `<div class="dep-detail-head"><strong>${esc(n.name)}</strong>${n.note ? ` <span class="insight-muted">(${esc(n.note)})</span>` : ''} <a href="#" class="dep-go">Go to it</a>` +
        (lit
          ? ` <span class="insight-muted">lit up in the text</span> <a href="#" class="dep-unfocus" title="Show the whole page again">Done</a></div>`
          : ` <a href="#" class="dep-focus" title="Light up what it uses in the text, and fade the rest">Show what it uses</a></div>`) +
        `<p><span class="insight-usedby-k">Uses</span> ${pickList(n.uses, (m) => n.edges.get(m))}${indirect(up, n.uses)}</p>` +
        `<p><span class="insight-usedby-k">Used in</span> ${pickList(n.usedBy, (m) => m.edges.get(n))}${indirect(down, n.usedBy)}</p>` +
        (cites.length ? `<p><span class="insight-usedby-k">Cites</span> ${cites.map((c) => (c.el ? `<a href="#" data-cite="${c.order}">${esc(`${c.label} ${c.who}`.trim())}</a>` : `<span>${esc(c.label)}</span>`)).join(', ')}</p>` : '') +
        (folded ? `<p><span class="insight-usedby-k">Folded in</span> ${pickList(new Set(folded))} <a href="#" data-fold="${esc(n.id)}">Show them</a></p>` : '');
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

    /** Light up a cited work on a map, and the results that rest on it. */
    function selectCite(view, k) {
      const body = view.body;
      const c = body._cites && body._cites[k];
      if (!c || !view.lay || !body.querySelector(`.dep-node[data-c="${k}"]`)) return;
      view.selected = null;
      view.selectedCite = k;
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
        (rest.size ? `<br><span class="insight-usedby-k">Indirectly</span> ${pickList(rest)}` : '') + '</p>';
      const go = detail.querySelector('.dep-go');
      if (go) {
        go.dataset.go = '';
        go._target = c.el;
      }
    }

    /** A map with nothing picked. */
    function clearPick(view, note) {
      const body = view.body;
      view.selected = null;
      view.selectedCite = null;
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
        '<button type="button" role="tab" data-tab="notation">Notation</button>' +
        '<button type="button" role="tab" data-tab="deps">Map</button>' +
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
      dialogView = { body: dialog.querySelector('.insight-body'), tab: 'notation', selected: null, side: false, leave: () => dialog.close(), isShown: () => dialog.open };
      wire(dialogView);
    }

    function fillDialog() {
      dialog.querySelectorAll('.insight-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === dialogView.tab)));
      fill(dialogView);
      dialog.dataset.ms = dialogView.body.dataset.ms;
    }

    function open(which, selected) {
      if (!dialog) build();
      if (which) dialogView.tab = which;
      if (selected != null) dialogView.selected = selected;
      fillDialog();
      if (!dialog.open) dialog.showModal();
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
      if (el._usesBtn || !el.id || el.closest(INSIDE_POPOVER)) return;
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

    /** The block an equation, figure or item reference lights up. */
    const blockOf = (t) => t.closest('.math-display, figure, table, .theorem, .proof, li, p') || t;

    function clearMarks() {
      if (!focusState) return;
      for (const el of focusState.marked) el.classList.remove('uses-on', 'uses-sel', 'uses-fade', 'uses-ref', 'uses-head', 'uses-guess');
      doc.classList.remove('uses-focus', 'uses-collapse');
      if (focusState.btn) focusState.btn.setAttribute('aria-pressed', 'false');
    }

    /** Light up what el uses (dir 'uses') or what uses it ('usedBy'). */
    function focus(el, dir, scroll) {
      if (!el || !doc.contains(el)) return;
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
      if (dir === 'uses') {
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
      const stops = [el].concat(others.map((m) => m.el));
      focusState = { id: el.id, dir, marked, stops, at: 0, btn: el._usesBtn || null, name: n.name, count: others.length, guessed: guessed.length };
      if (focusState.btn) focusState.btn.setAttribute('aria-pressed', 'true');
      showBar();
      syncMaps();
      if (scroll) opts.jump(el);
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
      const { id, dir } = focusState;
      focusState = null;
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
          focusState.at = (focusState.at + (b.dataset.act === 'next' ? 1 : -1) + k) % k;
          opts.jump(focusState.stops[focusState.at]);
          showBar();
        });
        document_.body.appendChild(bar);
      }
      const f = focusState;
      const what = f.dir === 'uses'
        ? (f.count ? `uses ${f.count} result${f.count > 1 ? 's' : ''}` : 'uses no other numbered result')
        : (f.count ? `is used in ${f.count} result${f.count > 1 ? 's' : ''}` : 'is not used in any numbered result');
      const guess = f.guessed ? ` <span class="uses-guessed" title="Named in the text without a link (“the previous lemma”, “Lemma 2.3”), so TeXglass guessed which result is meant. These have a dashed outline.">(${f.guessed} guessed)</span>` : '';
      const step = f.stops.length > 1
        ? `<button type="button" data-act="prev" aria-label="Previous" title="Previous">‹</button><span class="uses-step">${f.at + 1}/${f.stops.length}</span><button type="button" data-act="next" aria-label="Next" title="Next">›</button>`
        : '';
      bar.innerHTML =
        `<span class="uses-what"><strong>${esc(f.name)}</strong> ${what}${guess}</span>` +
        `<span class="uses-dir" role="group" aria-label="Direction"><button type="button" data-dir="uses" aria-pressed="${f.dir === 'uses'}">Uses</button>` +
        `<button type="button" data-dir="usedBy" aria-pressed="${f.dir === 'usedBy'}">Used in</button></span>` +
        step +
        `<button type="button" data-act="collapse" aria-pressed="${collapseRest}" title="Fold away the text that has nothing to do with it, or bring it back faded">Hide the rest</button>` +
        '<button type="button" data-act="done" class="uses-done" title="Show the whole page again (Esc)">Done</button>';
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
      mount,
      invalidate,
      setDefinitions,
      usedByNote,
      setHover: (on) => setHover(on, false),
      focus: (el, dir) => focus(el, dir || 'uses'),
      unfocus,
      focused: () => (focusState ? { id: focusState.id, dir: focusState.dir } : null),
      graph: getGraph,
      index: getIndex,
    };
  }

  /**
   * The side panel: tabs Contents, Notation and Map over the table of
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
    tabs.innerHTML = [['toc', 'Contents'], ['notation', 'Notation'], ['deps', 'Map']]
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
    }
    const win = doc.defaultView || window;
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(fitTabs).observe(o.head);
    else win.addEventListener('resize', fitTabs);

    let tab = 'toc';
    function show(t, quiet) {
      tab = view && (t === 'notation' || t === 'deps') ? t : 'toc';
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
      setWidth: (w) => setWidth(w, false),
    };
  }

  const api = { attach, sidePanel, dependencyGraph, notationIndex, definedSymbol, layout, foldGroups, mentionsIn };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassInsight = api;
})(typeof self !== 'undefined' ? self : this);
