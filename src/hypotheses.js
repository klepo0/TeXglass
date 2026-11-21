/*
 * Hypothesis checker: when a proof cites a result ("by Lemma 3.2"), its
 * preview shows that result's statement split into its hypotheses and its
 * conclusion, each hypothesis with a checkbox to tick once it is checked to
 * hold at this citation. The assumptions the result's section makes once
 * ("Throughout this section, X is compact", an Assumption environment) are
 * shown too, and so is an Assumption the statement refers to. A hypothesis
 * that nothing near the citation mentions gets a quiet hint.
 *
 * The statement is split by its wording: "Let…", "Suppose…", "Assume…",
 * "If… then…", "Under…", "…provided that…", and itemised assumptions such as
 * (H1), (H2) after "Assume the following:". Nothing is read while the page
 * renders: a statement is split when its preview is first shown.
 *
 *   const checker = TeXglassHypotheses.attach({
 *     root,                          // the rendered document
 *     isChecked: (id) => bool,       // the reader's ticks (kept with their notes)
 *     setChecked: (id, on, info) => {}, // info: { result, text, at }
 *     prefs: { get(k), set(k, v) },  // remembers "As written" (optional)
 *     onChange: () => {},            // the preview changed size (place it again)
 *   });
 *   checker.viewFor(target, link, writtenEl) -> element (or null: show writtenEl as usual)
 *
 * The splitting itself works on plain strings and is exported for tests:
 * split(flat, lists) where flat is the statement's text with each formula as
 * \ue000tex\ue001, a paragraph break as \n and each list as \ue002, and
 * lists[k] = [{ label, text }] are the items of the k-th list.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassHypotheses = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const M0 = '\ue000'; // a formula starts (its TeX follows)
  const M1 = '\ue001'; // a formula ends
  const LIST = '\ue002'; // a list, in the flat text

  // --- the flat text ---------------------------------------------------------------------------

  /** The flat text with each formula's TeX blanked out, so wording is never matched inside maths. */
  function maskOf(s) {
    let out = '';
    let inMath = false;
    for (const ch of s) {
      if (ch === M0) { inMath = true; out += M0; } else if (ch === M1) { inMath = false; out += M1; } else out += inMath ? '\u2217' : ch;
    }
    return out;
  }

  const ABBREV = /(?:\b(?:e\.g|i\.e|cf|resp|etc|vs|viz|eq|eqs|thm|lem|prop|cor|def|sec|ch|no|ref|refs|al|esp|resp|fig|thms|props|lems|cors|defs|secs|ex|rem|hyp)|(?:^|[\s(])[A-Za-z])$/i;

  /** The sentences of the flat text, in order: { from, to } or { list: k } for a list. */
  function sentences(s, mask) {
    const out = [];
    let from = 0;
    let listNo = 0;
    const end = (to) => { if (s.slice(from, to).trim()) out.push({ from, to }); from = to; };
    for (let i = 0; i < s.length; i++) {
      const c = mask[i];
      if (c === LIST) {
        end(i);
        out.push({ list: listNo++ });
        from = i + 1;
        continue;
      }
      let stop = false;
      if ((c === '.' || c === '!' || c === '?') && !ABBREV.test(mask.slice(Math.max(0, i - 6), i))) stop = true;
      // a displayed formula that ends with a full stop ends the sentence too
      if (c === M1 && /\.\s*$/.test(s.slice(s.lastIndexOf(M0, i) + 1, i))) stop = true;
      if (!stop) continue;
      const rest = mask.slice(i + 1);
      const next = /^[\s\n]*(.)?/.exec(rest);
      const ch = next[1];
      if (ch === undefined || ch === LIST || /^[\s\n]/.test(rest) && (/[A-Z(\u00c0-\u00de]/.test(ch) || ch === M0)) end(i + 1);
    }
    end(s.length);
    return out;
  }

  const LEAD = '^\\s*(?:(?:moreover|furthermore|in addition|additionally|also|finally|further|now|and)\\s*,?\\s+)?';
  const IF_START = new RegExp(LEAD + '(?:if|whenever|when|in case)\\b', 'i');
  const LET_START = new RegExp(LEAD + '(?:let|suppose|assume|fix|consider|given|we\\s+(?:will\\s+|shall\\s+)?(?:assume|suppose|fix))\\b', 'i');
  const UNDER_START = new RegExp(LEAD + 'under\\b', 'i');
  const THEN_START = /^\s*(?:then|in this case|in that case|consequently|it follows that|we have|one has|hence|thus|therefore|the following (?:hold|holds|are equivalent|is true|are true|statements? hold))\b,?\s*/i;
  const TAIL = /\s(?:provided(?:\s+that)?|whenever|as long as)\s|,\s*if\s(?!and only if)/i;
  const VAGUE_UNDER = /^\s*(?:the\s+)?(?:these|those|this|such|same|above|previous|preceding|foregoing|stated|standing|present)\b[^,]*\b(?:assumptions?|hypothes[ie]s|conditions?|setting|setup)\s*$/i;
  const VERB = /\b(?:is|are|be|being|has|have|satisf(?:y|ies|ied)|belongs?|holds?|exists?|admits?|lies|contains?|converges?|vanish(?:es)?|takes?|denotes?|solves?|does|do)\b/i;
  const RELATION = /=|<|>|\\(?:le|ge|leq|geq|leqslant|geqslant|in|subset|subseteq|subsetneq|supset|neq|ne|to|sim|approx|equiv|notin|ll|gg|asymp|mid|perp|cong|simeq)(?![a-zA-Z])/;

  /** Whether a piece of flat text says something on its own: a verb, or a formula with a relation. */
  function claims(s, mask) {
    if (VERB.test(mask)) return true;
    let m;
    const re = /\ue000([^\ue001]*)\ue001/g;
    while ((m = re.exec(s))) if (RELATION.test(m[1])) return true;
    return false;
  }

  /** [from, to) narrowed past spaces, punctuation and the words that only introduce a hypothesis. */
  function tidy(s, mask, from, to, strip) {
    const lead = strip
      ? /^[\s,;:.]*(?:(?:and|or|but|moreover|furthermore|also|further|in addition|additionally|finally|now)\s*,?\s+)*(?:(?:we\s+(?:will\s+|shall\s+)?)?(?:suppose|assume)|if|whenever|when|in case|provided|as long as|under)?(?:\s+(?:that|also|moreover|furthermore))*[\s,:]*/i
      : /^[\s,;:.]*(?:(?:and|or|but|moreover|furthermore|also|further|in addition|additionally|finally|now)\s*,?\s+)*(?:that\s+)?/i;
    const m = lead.exec(mask.slice(from, to));
    if (m) from += m[0].length;
    while (to > from && /[\s,;:.\n]/.test(mask[to - 1])) to--;
    while (from < to && /[\s\n]/.test(mask[from])) from++;
    return { from, to };
  }

  /** A run of hypotheses split at "; ", "and let", ", suppose", "and that" and between two claims joined by "and". */
  function splitHyps(s, mask, from, to) {
    const cuts = [];
    const piece = mask.slice(from, to);
    const re = /;\s+|,?\s+and\s+(?=(?:let|suppose|assume|that|if|fix|we)\b)|,\s+(?=(?:let|suppose|assume|fix)\b)|,?\s+and\s+(?=\ue000)/gi;
    let m;
    let last = 0;
    while ((m = re.exec(piece))) {
      const at = m.index;
      if (/and\s+$/i.test(m[0]) && piece[at + m[0].length] === M0) {
        // "$f$ is convex and $f(0)=0$": only when both sides say something
        const left = piece.slice(last, at);
        let rightEnd = piece.slice(at + m[0].length).search(/;\s|,?\s+and\s+\ue000|,\s+(?:let|suppose|assume)\b/i);
        rightEnd = rightEnd < 0 ? piece.length : at + m[0].length + rightEnd;
        const right = piece.slice(at + m[0].length, rightEnd);
        const sOf = (a, b) => s.slice(from + a, from + b);
        if (!claims(sOf(last, at), left) || !claims(sOf(at + m[0].length, rightEnd), right)) continue;
      }
      cuts.push([at, at + m[0].length]);
      last = at + m[0].length;
    }
    const out = [];
    let a = 0;
    for (const [c0, c1] of cuts) {
      out.push([a, c0]);
      a = c1;
    }
    out.push([a, piece.length]);
    return out
      .map(([x, y]) => tidy(s, mask, from + x, from + y, true))
      .filter((r) => r.to > r.from && /[\w\ue000]/.test(mask.slice(r.from, r.to)));
  }

  /** Whether "Assume the following:" (and its like) says anything besides introducing a list. */
  function onlyIntroduces(mask) {
    const words = mask.replace(/\ue000[^\ue001]*\ue001/g, ' $ ').replace(/[^\w$]+/g, ' ').trim().toLowerCase().split(' ')
      .filter((w) => w && !/^(let|suppose|assume|that|the|following|conditions?|assumptions?|hypothes[ie]s|hold|holds|are|is|satisfied|we|if|one|of|either|both|all|then|and|moreover|furthermore|also|further|in|addition|statements?|true|equivalent|properties|property)$/.test(w));
    return words.length === 0;
  }

  /**
   * The hypotheses and the conclusion of a statement, as pieces of the flat
   * text: { hyps: [piece], concl: [piece] } where a piece is { from, to } or
   * { list, item } for an item of a list.
   */
  function split(flat, lists) {
    const s = String(flat || '');
    const mask = maskOf(s);
    const units = sentences(s, mask);
    const hyps = [];
    const concl = [];
    let phase = 'hyp';
    let listKind = null; // what the next list holds: 'hyp' or 'concl'
    const thenLater = (k) => units.slice(k + 1).some((u) => u.list == null && THEN_START.test(mask.slice(u.from, u.to)));
    const addHyps = (a, b) => { for (const r of splitHyps(s, mask, a, b)) hyps.push(r); };
    const addConcl = (a, b) => {
      const t = mask.slice(a, b);
      const tail = TAIL.exec(t);
      if (tail && tail.index > 0) {
        const r = tidy(s, mask, a, a + tail.index, false);
        if (r.to > r.from) concl.push(r);
        addHyps(a + tail.index, b);
        return;
      }
      const r = tidy(s, mask, a, b, false);
      if (r.to > r.from) concl.push(r);
    };
    /** A list follows when the sentence ends with ':' (or nothing) and the next unit is a list. */
    const introducesList = (k, u) => units[k + 1] && units[k + 1].list != null && /[:\s]$|[^.!?]$/.test(mask.slice(u.from, u.to).replace(/\s+$/, ''));
    units.forEach((u, k) => {
      if (u.list != null) {
        const items = (lists && lists[u.list]) || [];
        let kind = listKind;
        if (!kind) {
          const hypLabels = items.length && items.every((it) => /^\(?\s*(?:H|A|C|Hyp|B|K|S)\s*\d*['\u2032]?\s*\)?$/i.test(String(it.label || '').trim()) && /\d|^\(?\s*hyp/i.test(String(it.label || '')));
          kind = hypLabels ? 'hyp' : phase === 'hyp' && thenLater(k) ? 'hyp' : 'concl';
        }
        items.forEach((it, j) => { if (String(it.text || '').trim()) (kind === 'hyp' ? hyps : concl).push({ list: u.list, item: j }); });
        if (kind === 'concl') phase = 'concl';
        listKind = null;
        return;
      }
      const t = mask.slice(u.from, u.to);
      const lists0 = introducesList(k, u);
      let m;
      if ((m = IF_START.exec(t))) {
        const after = u.from + m[0].length;
        const rest = mask.slice(after, u.to);
        const th = /,?\s+then\b,?\s*/i.exec(rest) || /,\s+(?!and\b|or\b|i\.e|e\.g|resp|respectively|where|with|for|that|which)/i.exec(rest);
        if (th) {
          addHyps(after, after + th.index);
          addConcl(after + th.index + th[0].length, u.to);
          phase = 'concl';
          if (lists0) listKind = 'concl';
        } else {
          addHyps(after, u.to);
          if (lists0) listKind = onlyIntroduces(rest) ? 'hyp' : 'concl';
          if (lists0 && listKind === 'hyp') hyps.pop();
        }
        return;
      }
      if ((m = LET_START.exec(t))) {
        const th = /,\s*then\b,?\s*/i.exec(t);
        if (th) {
          addHyps(u.from, u.from + th.index);
          addConcl(u.from + th.index + th[0].length, u.to);
          phase = 'concl';
          if (lists0) listKind = 'concl';
          return;
        }
        if (lists0) {
          listKind = 'hyp';
          if (onlyIntroduces(t)) return;
        }
        addHyps(u.from, u.to);
        return;
      }
      if ((m = UNDER_START.exec(t))) {
        const after = u.from + m[0].length;
        const rest = mask.slice(after, u.to);
        const c = /,\s+/.exec(rest);
        if (c) {
          if (!VAGUE_UNDER.test(rest.slice(0, c.index))) addHyps(after, after + c.index);
          addConcl(after + c.index + c[0].length, u.to);
          phase = 'concl';
          if (lists0) listKind = 'concl';
          return;
        }
      }
      if ((m = THEN_START.exec(t))) {
        if (!(lists0 && onlyIntroduces(t.slice(m[0].length)))) addConcl(u.from + m[0].length, u.to);
        phase = 'concl';
        if (lists0) listKind = 'concl';
        return;
      }
      if (phase === 'hyp' && thenLater(k)) {
        if (lists0) {
          listKind = 'hyp';
          if (onlyIntroduces(t)) return;
        }
        addHyps(u.from, u.to);
        return;
      }
      addConcl(u.from, u.to);
      phase = 'concl';
      if (lists0) listKind = 'concl';
    });
    return { hyps, concl };
  }

  /** A piece of flat text as plain words, each formula as $TeX$ (for ids, hints and tests). */
  function plain(s) {
    return String(s).replace(/\ue000([^\ue001]*)\ue001/g, (_, t) => '$' + t.trim() + '$').replace(/\ue002/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // --- does the text near a citation mention a hypothesis? -------------------------------------

  const STOP = new Set(('also each every some such that this these those then there their them they with which where when while from into onto over under than more most less least only very just well into upon within without about above below between both either neither other another same given hold holds held true false following satisfy satisfies satisfying satisfied assume assumed assumption assumptions suppose supposed hypothesis hypotheses condition conditions conclude conclusion respect respectively finally moreover furthermore further case cases exists exist existence function functions space spaces element elements point points number numbers constant constants sequence sequences family families real complex positive negative integer integers order defined define denote denotes notation set sets subset subsets map maps mapping value values whose have has having being been does done make made used using will shall must should would could note result results lemma theorem proposition corollary claim fact section paper above below let fix consider').split(' '));

  const stem = (w) => w.toLowerCase().replace(/(?:ies|es|s|ed|ing|ity|ly)$/, '').slice(0, 6);

  /** The distinctive words of a hypothesis ("compact", "continuous"), as stems. */
  function contentWords(text) {
    const out = new Set();
    String(text).replace(/\$[^$]*\$/g, ' ').replace(/[A-Za-z][A-Za-z-]{3,}/g, (w) => {
      const l = w.toLowerCase().replace(/-/g, '');
      if (!STOP.has(l) && l.length >= 4) out.add(stem(l));
      return w;
    });
    return out;
  }
  const normTex = (t) => String(t).replace(/\\(?:left|right|big+[lr]?|Big+[lr]?)(?![a-zA-Z])/g, '').replace(/\\[,;:! ]|\s+/g, '').replace(/[.,;]+$/, '');
  const formulas = (text) => (String(text).match(/\$[^$]*\$/g) || []).map((f) => normTex(f.slice(1, -1))).filter((f) => f.length >= 2);

  // "the hypotheses of Lemma 3.2 hold", "all assumptions are satisfied", "(H1)–(H3) hold"
  const ALL_CHECKED = /\b(?:hypothes[ie]s|assumptions?|conditions?)\b[^.]{0,60}\b(?:hold|holds|satisfied|fulfilled|met|verified|valid|true|apply|applies)\b|\b(?:satisf(?:y|ies|ying)|verif(?:y|ies|ying)|fulfil(?:l|s|ls|ling)?|meets?)\s+(?:all\s+)?(?:the\s+)?(?:its\s+)?(?:hypothes[ie]s|assumptions?|conditions?)\b/i;

  /**
   * Whether the text near a citation mentions a hypothesis: true (it does),
   * false (none of its distinctive words, formulas or label appear), or null
   * (it cannot tell: a hypothesis made only of formulas, whose letters a proof
   * renames, or text that says all hypotheses hold).
   */
  function mentioned(hyp, near, label) {
    const text = String(near || '');
    if (ALL_CHECKED.test(text)) return null;
    if (label) {
      const l = String(label).replace(/[()\s]/g, '');
      if (l && new RegExp('(?:^|[^\\w])\\(?' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)?(?![\\w])').test(text)) return true;
    }
    const nearForms = new Set(formulas(text));
    for (const f of formulas(hyp)) if (nearForms.has(f)) return true;
    const words = contentWords(hyp);
    if (!words.size) return null;
    const nearWords = new Set();
    text.replace(/\$[^$]*\$/g, ' ').replace(/[A-Za-z][A-Za-z-]{3,}/g, (w) => { nearWords.add(stem(w.replace(/-/g, ''))); return w; });
    for (const w of words) if (nearWords.has(w)) return true;
    return false;
  }

  // --- standing assumptions --------------------------------------------------------------------

  const STANDING = /\b(?:throughout|for the (?:rest|remainder) of|from now on|henceforth|unless (?:otherwise |explicitly )?(?:stated|specified|mentioned|noted)|in (?:this|the present|the whole|the rest of this) (?:section|chapter|part|paper|article|subsection)[^.]{0,40}\b(?:we\s+)?(?:assume|suppose|fix|let|always)|we (?:will |shall )?(?:always |henceforth |also )?(?:assume|fix|suppose)\b[^.]{0,80}\b(?:throughout|always|from now on|in this section|in what follows|for the rest)|in what follows)\b/i;
  const PAPER_WIDE = /\b(?:paper|article|work|thesis|notes|book|monograph)\b/i;
  const ASSUMPTION_NAME = /^(?:assumptions?|hypothes[ie]s|standing|setting|setup|set-up|conventions?|framework|condition)\b/i;
  const RESULT_NAME = /^(?:theorem|lemma|proposition|corollary|claim|fact|conjecture|sublemma|observation|criterion|principle|main theorem|key lemma|thm|lem|prop|cor)\b/i;

  // --- the page --------------------------------------------------------------------------------

  const SKIP = '.thm-head, .proof-head, .item-label, sup.fn, .footnote, .footnotes, .tg-margin, .marginnote, .uses-btn, .fold-toggle, script, style, .katex-mathml, .qed';

  function thmName(el) {
    const n = el.querySelector('.thm-name');
    return n && n.closest('.theorem') === el ? textOf(n) : '';
  }

  /**
   * An element's words as the reader sees them. A formula drawn by KaTeX keeps
   * its TeX in hidden MathML (for screen readers), so textContent would give
   * "∙\bullet∙" for $\bullet$: that copy is left out.
   */
  function textOf(el) {
    if (!el) return '';
    let s = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1 && !c.matches('.katex-mathml, script, style')) walk(c);
      }
    };
    walk(el);
    return s.replace(/\s+/g, ' ').trim();
  }

  /** A copy of an element's content to show elsewhere, without its ids. */
  function contentCopy(el, doc) {
    const span = doc.createElement('span');
    for (const c of el.childNodes) span.appendChild(c.cloneNode(true));
    span.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    return span;
  }

  // An itemize mark (•, ∙, –, ∗, ·, $\bullet$, $\circ$, …) says nothing next to a tick box.
  const MARK_ONLY = /^[\s\u2022\u2219\u00b7\u2013\u2014\u2217*\u2218\u25e6\u25aa\u25ab\u25a0\u25a1\u25cf\u25cb\u22c6\u2023\u2043\u27a2>\-+\u22c4\u2666\u25c6\u2605\u2606\u2713\u2714]*$/;

  /**
   * A statement's flat text and how to get its pieces back as page content:
   * { flat, lists: [[{ label, text, body }]], segs } where segs map the flat text
   * to the page: { from, to, node, kind: 'text' | 'atom' | 'gap', box }.
   */
  function flatten(thm) {
    const segs = [];
    const lists = [];
    let flat = '';
    const add = (seg, s) => { seg.from = flat.length; flat += s; seg.to = flat.length; segs.push(seg); };
    const walk = (n, box, into) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) into({ node: c, kind: 'text', box }, c.nodeValue.replace(/[\ue000-\ue002]/g, ' '));
        else if (c.nodeType === 1) {
          if (c.matches('.math[data-tex]')) into({ node: c, kind: 'atom', box }, M0 + c.getAttribute('data-tex').replace(/[\ue000-\ue002]/g, ' ') + M1);
          else if (!c.matches(SKIP)) walk(c, box, into);
        }
      }
    };
    for (const child of thm.children) {
      if (child.matches('ul.list, ol.list, ul, ol')) {
        const items = [];
        for (const li of child.children) {
          if (li.tagName !== 'LI') continue;
          const labelEl = li.querySelector(':scope > .item-label');
          let label = textOf(labelEl);
          if (MARK_ONLY.test(label)) label = '';
          let text = '';
          walk(li, li, (seg, s) => { text += s; });
          items.push({ label, labelEl: label ? labelEl : null, text, body: li.querySelector(':scope > .item-body') || li });
        }
        lists.push(items);
        add({ kind: 'gap', box: child }, LIST);
        continue;
      }
      if (child.matches('.math-display[data-tex]')) {
        add({ node: child, kind: 'atom', box: child }, M0 + child.getAttribute('data-tex').replace(/[\ue000-\ue002]/g, ' ') + M1);
        continue;
      }
      if (child.matches(SKIP)) continue;
      if (flat && !flat.endsWith(LIST)) add({ kind: 'gap', box: null }, '\n');
      walk(child, child, add);
    }
    return { flat, lists, segs };
  }

  /** The page content of flat text [from, to): the pieces of each paragraph, a displayed formula whole. */
  function contentOf(f, from, to, doc) {
    const out = doc.createDocumentFragment();
    let group = null; // { box, start, end } within one paragraph
    const point = (seg, at, isEnd) => {
      if (seg.kind === 'text') return [seg.node, Math.max(0, Math.min(seg.node.nodeValue.length, at - seg.from))];
      return null; // an atom: before or after it
    };
    const flush = () => {
      if (!group) return;
      const r = doc.createRange();
      const [s0, s1] = group.start;
      const [e0, e1] = group.end;
      if (s1 === 'before') r.setStartBefore(s0); else r.setStart(s0, s1);
      if (e1 === 'after') r.setEndAfter(e0); else r.setEnd(e0, e1);
      const span = doc.createElement('span');
      span.appendChild(r.cloneContents());
      out.appendChild(span);
      out.appendChild(doc.createTextNode(' '));
      group = null;
    };
    for (const seg of f.segs) {
      if (seg.to <= from || seg.from >= to) continue;
      if (seg.kind === 'gap') { flush(); continue; }
      if (seg.kind === 'atom' && seg.node === seg.box) { // a displayed formula
        flush();
        out.appendChild(seg.node.cloneNode(true));
        continue;
      }
      if (group && group.box !== seg.box) flush();
      const startP = seg.kind === 'text' ? point(seg, Math.max(from, seg.from)) : [seg.node, 'before'];
      const endP = seg.kind === 'text' ? point(seg, Math.min(to, seg.to)) : [seg.node, 'after'];
      if (!group) group = { box: seg.box, start: startP, end: endP };
      else group.end = endP;
    }
    flush();
    out.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    return out;
  }

  /** The statement of a result, split: { name, hyps: [{ text, label, content() }], concl: [...] }, or null. */
  function readStatement(thm) {
    const f = flatten(thm);
    if (!f.flat.trim()) return null;
    const parts = split(f.flat, f.lists.map((l) => l.map((it) => ({ label: it.label, text: it.text }))));
    const doc = thm.ownerDocument;
    const piece = (p) => {
      if (p.list != null) {
        const it = f.lists[p.list][p.item];
        return {
          text: plain(it.text).replace(/[\s,;.]+$/, ''),
          label: it.label,
          labelContent: it.labelEl ? () => contentCopy(it.labelEl, doc) : null,
          content: () => contentCopy(it.body, doc),
        };
      }
      return { text: plain(f.flat.slice(p.from, p.to)), label: '', content: () => contentOf(f, p.from, p.to, doc) };
    };
    return { name: thmName(thm), hyps: parts.hyps.map(piece), concl: parts.concl.map(piece) };
  }

  /** The flat text of an element as plain words with $TeX$ formulas (for the text near a citation). */
  function plainOf(el) {
    let s = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1) {
          if (c.matches('.math[data-tex]')) s += ' $' + c.getAttribute('data-tex') + '$ ';
          else if (c.matches('.cite')) s += ' \u2020 ';
          else if (!c.matches(SKIP)) walk(c);
        }
      }
    };
    walk(el);
    return s.replace(/\s+/g, ' ');
  }

  /**
   * The words around a citation: from the start of the paragraph before it (in
   * the same proof) to the end of the sentence after the one citing.
   */
  function nearText(link) {
    const box = link.closest('p, li, .math-display') || link.parentElement;
    if (!box) return '';
    const scope = link.closest('.proof, .theorem') || box.parentElement;
    const mark = link.ownerDocument.createTextNode('\u2021');
    link.after(mark);
    let here;
    try { here = plainOf(box); } finally { mark.remove(); }
    let at = here.indexOf('\u2021');
    if (at < 0) at = here.length;
    // the sentence citing, and the one after
    let end = at;
    for (let k = 0; k < 2; k++) {
      const m = /[.!?](?=\s+[A-Z($]|\s*$)/.exec(here.slice(end + 1));
      end = m ? end + 1 + m.index + 1 : here.length;
    }
    let before = here.slice(0, at);
    const prev = box.previousElementSibling;
    if (prev && scope && scope.contains(prev) && !prev.matches('.theorem')) before = plainOf(prev) + ' ' + before;
    return (before.slice(-600) + ' ' + here.slice(at + 1, end)).replace(/\u2021/g, '');
  }

  /** Elements before `el` in document order, nearest first, among its siblings and its ancestors' siblings. */
  function* before(el, rootEl) {
    let n = el;
    while (n && n !== rootEl && n.parentElement) {
      let p = n.previousElementSibling;
      while (p) {
        yield* inside(p);
        p = p.previousElementSibling;
      }
      n = n.parentElement;
    }
  }
  /** An element, or for a wrapper (the viewer's source blocks) what it wraps, last first. */
  function* inside(el) {
    if (el.tagName === 'DIV' && !el.matches('.theorem, .proof, .math, .tg-diagram, .footnotes, .tg-margin, .list') &&
        el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > p, :scope > .theorem, :scope > .proof, :scope > div')) {
      const kids = Array.from(el.children);
      for (let i = kids.length - 1; i >= 0; i--) yield* inside(kids[i]);
    } else yield el;
  }

  const level = (h) => Number(h.tagName.slice(1));

  /** The sentences of a paragraph that set a standing assumption. */
  function standingSentences(p) {
    const text = plainOf(p).trim();
    const out = [];
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
    for (const s of parts) if (STANDING.test(s.replace(/\$[^$]*\$/g, 'x'))) out.push(s.trim());
    return out;
  }

  /**
   * The assumptions a result's section (or the paper) makes once and does not
   * repeat: [{ name, text, el?, sentence? }], nearest first, at most six.
   */
  function standingFor(thm, rootEl) {
    const out = [];
    const seen = new Set();
    const push = (x) => { if (!seen.has(x.text) && out.length < 6) { seen.add(x.text); out.push(x); } };
    // Assumptions the statement refers to by name
    thm.querySelectorAll('a.ref[href^="#"]').forEach((a) => {
      const t = thm.ownerDocument.getElementById(a.getAttribute('href').slice(1));
      const box = t && (t.matches('.theorem') ? t : t.closest('.theorem, li.item'));
      if (!box || box === thm) return;
      const owner = box.matches('.theorem') ? box : box.closest('.theorem');
      if (owner && ASSUMPTION_NAME.test(thmName(owner))) push({ name: box === owner ? thmName(owner) : `${thmName(owner)} ${textOf(a)}`, text: plainOf(box), el: box, referred: true });
    });
    let headLevel = null; // the level of the section heading reached, once one is
    let crossedSection = false;
    for (const el of before(thm, rootEl)) {
      if (out.length >= 6) break;
      if (/^H[1-6]$/.test(el.tagName)) {
        if (headLevel == null || level(el) < headLevel) headLevel = level(el);
        if (level(el) <= 2) crossedSection = true;
        continue;
      }
      if (el.matches('.theorem')) {
        if (!crossedSection && ASSUMPTION_NAME.test(thmName(el))) push({ name: thmName(el), text: plainOf(el), el });
        continue;
      }
      if (el.matches('.proof, .tg-margin, .footnotes, nav')) continue;
      if (el.tagName !== 'P') continue;
      for (const s of standingSentences(el)) {
        const paperWide = PAPER_WIDE.test(s) && !/\b(?:section|chapter|subsection|part)\b/i.test(s);
        if (!crossedSection || paperWide) push({ name: paperWide ? 'Throughout the paper' : 'In this section', text: s, sentence: el });
      }
    }
    return out;
  }

  /** Where a citation is: the result whose proof (or statement) has it, else its section, plus which one there it is. */
  function placeOf(link, rootEl) {
    let owner = '';
    const proof = link.closest('.proof');
    const thm = link.closest('.theorem');
    if (thm) owner = thmName(thm);
    else if (proof) {
      for (const el of before(proof, rootEl)) {
        if (el.matches('.theorem')) { owner = thmName(el); break; }
        if (/^H[1-6]$/.test(el.tagName)) break;
      }
      owner = 'Proof of ' + (owner || 'result');
    }
    if (!owner) {
      for (const el of before(link.closest('p, li, div') || link, rootEl)) {
        if (/^H[1-6]$/.test(el.tagName)) { owner = textOf(el); break; }
      }
    }
    const scope = proof || thm || link.closest('p') || rootEl;
    const href = link.getAttribute('href');
    const same = Array.from(scope.querySelectorAll('a.ref')).filter((a) => a.getAttribute('href') === href);
    return { owner: owner || 'text', n: Math.max(0, same.indexOf(link)) };
  }

  /** A short, stable hash (FNV-1a, 32 bits, 8 hex digits). */
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** The id of a tick: this hypothesis of this result at this citation, the same on every device. */
  function checkId(result, text, at) {
    return 'chk-' + hash(`${at}\u0000${result}\u0000${String(text).replace(/\s+/g, ' ').trim()}`);
  }

  // --- the preview -----------------------------------------------------------------------------

  function attach(opts) {
    const o = opts || {};
    const rootEl = o.root;
    const memory = new Map(); // ticks, when there is nowhere to keep them
    const isChecked = (id) => (o.isChecked ? !!o.isChecked(id) : !!memory.get(id));
    const setChecked = (id, on, info) => {
      if (o.setChecked) o.setChecked(id, on, info);
      else memory.set(id, on);
    };
    const prefs = o.prefs || null;
    const PREF = 'texglass:hypotheses';
    const cache = new WeakMap();

    const statementOf = (thm) => {
      if (!cache.has(thm)) {
        let st = null;
        try { st = readStatement(thm); } catch (e) { st = null; }
        cache.set(thm, st);
      }
      return cache.get(thm);
    };

    /** Whether a link cites a result whose hypotheses are worth checking. */
    function applies(target, link) {
      if (!target || !link || !target.matches || !target.matches('.theorem')) return false;
      if (!link.closest('.proof, .theorem')) return false;
      const name = thmName(target);
      if (ASSUMPTION_NAME.test(name)) return false;
      return RESULT_NAME.test(name) || (target.classList.contains('thm-plain') && !/^(?:definition|example|remark|notation|exercise|problem|question|note)/i.test(name));
    }

    function viewFor(target, link, writtenEl) {
      if (!applies(target, link)) return null;
      const st = statementOf(target);
      if (!st) return null;
      const standing = standingFor(target, rootEl);
      if (!st.hyps.length && !standing.length) return null;
      const doc = target.ownerDocument;
      const place = placeOf(link, rootEl);
      const at = `${place.owner}#${place.n}`;
      const near = nearText(link);
      const el = (tag, cls, text) => {
        const e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
      };

      const wrap = el('div', 'hyp-view');
      const split = el('div', 'hyp-check');
      const written = el('div', 'hyp-written');
      if (writtenEl) written.appendChild(writtenEl);

      // the head: the result's name, how many are ticked, and the switch to the statement as written
      const head = el('div', 'hyp-head');
      const title = el('strong', 'hyp-title', st.name || 'Result');
      head.appendChild(title);
      const note = target.querySelector('.thm-note');
      if (note && note.closest('.theorem') === target) {
        const n = el('span', 'hyp-note', ' ');
        n.appendChild(contentCopy(note, doc));
        head.appendChild(n);
      }
      const count = el('span', 'hyp-count');
      head.appendChild(count);
      const toWritten = el('button', 'hyp-switch', 'As written');
      toWritten.type = 'button';
      toWritten.title = 'Show the statement as the paper writes it';
      head.appendChild(toWritten);
      split.appendChild(head);

      /** An item's label as the page draws it ("(H1)", "$(\\mathrm{A}_2)$"), then a space. */
      const labelOf = (item) => {
        const s = el('span', 'hyp-label');
        if (item.labelContent) s.appendChild(item.labelContent());
        else s.textContent = item.label;
        s.appendChild(doc.createTextNode(' '));
        return s;
      };
      const boxes = [];
      const row = (item, result, kind) => {
        const li = el('li', 'hyp-item');
        const id = checkId(result, item.text, at);
        const box = el('input', 'hyp-box');
        box.type = 'checkbox';
        box.checked = isChecked(id);
        box.setAttribute('aria-label', `Checked here: ${item.label ? item.label + ' ' : ''}${item.text}`.slice(0, 200));
        box.title = 'Tick once you have checked that this holds here';
        box.addEventListener('change', () => {
          setChecked(id, box.checked, { result, text: item.text, at, kind });
          li.classList.toggle('hyp-done', box.checked);
          updateCount();
        });
        li.classList.toggle('hyp-done', box.checked);
        boxes.push(box);
        li.appendChild(box);
        const body = el('div', 'hyp-text');
        if (item.label) body.appendChild(labelOf(item));
        body.appendChild(item.content());
        li.appendChild(body);
        return li;
      };

      if (st.hyps.length) {
        split.appendChild(el('div', 'hyp-sec', st.hyps.length === 1 ? 'Hypothesis' : 'Hypotheses'));
        const ul = el('ul', 'hyp-list');
        let unseen = 0;
        st.hyps.forEach((h) => {
          const li = row(h, st.name, 'hypothesis');
          if (mentioned(h.text, near, h.label) === false) {
            unseen++;
            const hint = el('span', 'hyp-hint', 'not mentioned near this citation');
            hint.title = 'None of its words, formulas or its label appear around the citation. Did the author check it?';
            li.querySelector('.hyp-text').appendChild(hint);
            li.classList.add('hyp-unseen');
          }
          ul.appendChild(li);
        });
        split.appendChild(ul);
        if (unseen) split.dataset.unseen = String(unseen);
      }
      if (st.concl.length) {
        split.appendChild(el('div', 'hyp-sec', 'Conclusion'));
        const c = el('div', 'hyp-concl');
        st.concl.forEach((p) => {
          const d = el('div', 'hyp-concl-part');
          if (p.label) d.appendChild(labelOf(p));
          d.appendChild(p.content());
          c.appendChild(d);
        });
        split.appendChild(c);
      }
      if (standing.length) {
        const det = el('details', 'hyp-standing');
        if (!st.hyps.length || standing.some((x) => x.referred)) det.open = true;
        det.appendChild(el('summary', null, `Assumed beforehand (${standing.length})`));
        const ul = el('ul', 'hyp-list');
        standing.forEach((x) => {
          const item = {
            text: x.text,
            label: '',
            content: () => {
              const d = doc.createElement('span');
              d.appendChild(el('span', 'hyp-from', x.name + ': '));
              if (x.el) {
                const clone = (x.el.matches('li') ? x.el.querySelector(':scope > .item-body') || x.el : x.el).cloneNode(true);
                clone.querySelectorAll('[id], .thm-head').forEach((n) => (n.matches('.thm-head') ? n.remove() : n.removeAttribute('id')));
                clone.removeAttribute('id');
                d.appendChild(clone);
              } else d.appendChild(textWithMath(x.text, x.sentence, doc));
              return d;
            },
          };
          ul.appendChild(row(item, st.name, 'standing'));
        });
        det.appendChild(ul);
        det.addEventListener('toggle', () => { if (o.onChange) o.onChange(); });
        split.appendChild(det);
      }
      function updateCount() {
        const done = boxes.filter((b) => b.checked).length;
        count.textContent = boxes.length ? ` · ${done} of ${boxes.length} checked here` : '';
        split.classList.toggle('hyp-all-done', boxes.length > 0 && done === boxes.length);
      }
      updateCount();

      const toSplit = el('button', 'hyp-switch hyp-switch-back', 'Check hypotheses');
      toSplit.type = 'button';
      toSplit.title = 'Split the statement into its hypotheses and conclusion, with boxes to tick';
      const show = (asWritten, user) => {
        split.hidden = asWritten;
        written.hidden = !asWritten;
        toSplit.hidden = !asWritten;
        if (user && prefs) prefs.set(PREF, asWritten ? 'written' : 'split');
        if (user && o.onChange) o.onChange();
      };
      toWritten.addEventListener('click', (e) => { e.preventDefault(); show(true, true); });
      toSplit.addEventListener('click', (e) => { e.preventDefault(); show(false, true); });
      wrap.append(split, written, toSplit);
      show(!!(prefs && prefs.get(PREF) === 'written'), false);
      return wrap;
    }

    return { viewFor, applies, statementOf, standingFor: (t) => standingFor(t, rootEl) };
  }

  /** A standing sentence as page content: the paragraph's sentence, with its formulas drawn again. */
  function textWithMath(text, para, doc) {
    const span = doc.createElement('span');
    const maths = para ? Array.from(para.querySelectorAll('.math[data-tex]')) : [];
    const byTex = new Map();
    maths.forEach((m) => { if (!byTex.has(m.getAttribute('data-tex'))) byTex.set(m.getAttribute('data-tex'), m); });
    String(text).split(/(\$[^$]*\$)/).forEach((part) => {
      if (/^\$[^$]*\$$/.test(part)) {
        const m = byTex.get(part.slice(1, -1));
        if (m) { const c = m.cloneNode(true); c.removeAttribute('id'); span.appendChild(c); return; }
      }
      span.appendChild(doc.createTextNode(part.replace(/\u2020/g, '')));
    });
    return span;
  }

  return { attach, split, plain, mentioned, checkId, sentences: (s) => sentences(s, maskOf(s)), contentWords };
});
