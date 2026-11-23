/*
 * TeXglass find bar: search the rendered document, and go to a theorem,
 * equation, section, figure or table by its number.
 *
 * Shared by the web viewer and the VS Code preview. It reads only the
 * rendered HTML (theorems carry data-number, headings a .secnum, equation
 * numbers are KaTeX \tag spans, captions a .caption-head), so the converter
 * needs no changes. Matches are painted with the CSS Custom Highlight API,
 * which leaves the DOM alone, so the preview can keep patching its blocks
 * while a search is open; the search re-runs when the preview changes.
 *
 * Works in the browser (window.TeXglassFind) and in Node (require), where
 * only the pure helpers (findRegex, parseJump, rankTargets) are of use.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassFind = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  /** A case-insensitive regex for `query`, where any run of spaces matches any whitespace. */
  function findRegex(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const src = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return new RegExp(src, 'giu');
  }

  // Short names people type for the kinds of things a paper numbers.
  const ALIASES = {
    th: 'theorem', thm: 'theorem', thms: 'theorem',
    lem: 'lemma', lma: 'lemma', lm: 'lemma',
    pr: 'proposition', prop: 'proposition', props: 'proposition',
    cor: 'corollary', coro: 'corollary', corr: 'corollary',
    def: 'definition', defn: 'definition', dfn: 'definition',
    rem: 'remark', rmk: 'remark', rk: 'remark',
    ex: 'example', exa: 'example', exm: 'example', eg: 'example',
    exer: 'exercise', exc: 'exercise',
    conj: 'conjecture', cj: 'conjecture',
    hyp: 'hypothesis', ass: 'assumption', asm: 'assumption', assump: 'assumption',
    obs: 'observation', nota: 'notation', notn: 'notation',
    alg: 'algorithm', algo: 'algorithm', prob: 'problem', qu: 'question', ques: 'question',
    ax: 'axiom', cond: 'condition', fact: 'fact', cl: 'claim',
    eq: 'equation', eqn: 'equation', eqs: 'equation', eqns: 'equation', formula: 'equation',
    s: 'section', sec: 'section', sect: 'section', secs: 'section', '§': 'section',
    ss: 'subsection', subsec: 'subsection', subsect: 'subsection',
    ch: 'chapter', chap: 'chapter', chapt: 'chapter',
    app: 'appendix', apx: 'appendix', appx: 'appendix',
    fig: 'figure', figs: 'figure', tab: 'table', tbl: 'table',
  };

  const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  /**
   * Split what was typed into the Go to box into kind words and a number:
   * "Lemma 4.1" → { kinds: ['lemma'], num: '4.1' }, "(3.2)" → equation 3.2,
   * "§2" → section 2, "thm3" → theorem 3, "hahn banach" → { words }.
   */
  function parseJump(query) {
    let q = String(query || '').trim().replace(/\s+/g, ' ');
    const kinds = [];
    if (q.startsWith('§')) {
      kinds.push('section');
      q = q.replace(/^§+\s*/, '');
    }
    let paren = /^(.*?)\s*\(([^()]*)\)?$/.exec(q);
    if (paren && paren[2] !== undefined && /\d/.test(paren[2]) && !/[()]/.test(paren[1])) {
      // "(3.2)", "eq (3.2)", or "(3.2" while typing.
      if (!paren[1]) kinds.push('equation');
      q = (paren[1] + ' ' + paren[2]).trim();
    } else if ((paren = /^\(([^()]*\d[^()]*)$/.exec(q))) {
      kinds.push('equation');
      q = paren[1];
    }
    // "thm3.2" → "thm 3.2"
    q = q.replace(/^([\p{L}]+\.?)(?=\d)/u, '$1 ');
    const toks = q.split(' ').filter(Boolean);
    let num = '';
    const last = toks[toks.length - 1];
    if (last && (/\d/.test(last) || (toks.length > 1 && /^[A-Z](\.[\dA-Za-z]+)*\.?$/.test(last)))) {
      num = toks.pop().replace(/^[([]+|[)\].,:;]+$/g, '');
    }
    for (const t of toks) {
      const w = t.toLowerCase().replace(/\.$/, '');
      if (w) kinds.push(w);
    }
    return { kinds, num, words: words(query) };
  }

  /** Does kind word `w` (as typed) name one of `kindWords`? */
  function kindMatches(w, kindWords) {
    const full = ALIASES[w];
    return kindWords.some((k) => k.startsWith(w) || (full && k.startsWith(full)));
  }

  /**
   * The targets that match `query`, best first. A target is
   * { kinds: [words], num, label, title } plus whatever the caller needs.
   */
  function rankTargets(targets, query, limit) {
    const max = limit || 200;
    const p = parseJump(query);
    const out = [];
    targets.forEach((t, order) => {
      let score;
      if (p.num) {
        if (!t.num) return;
        const n = t.num.toLowerCase();
        const want = p.num.toLowerCase();
        if (n === want) score = 0;
        else if (n.startsWith(want) && /^[^\p{L}\p{N}]/u.test(n.slice(want.length))) score = 1;
        else if (n.startsWith(want)) score = 2;
        else return;
        if (!p.kinds.every((w) => kindMatches(w, t.kinds))) return;
      } else {
        if (!p.words.length) {
          score = 0;
        } else {
          const hay = t.kinds.concat(words(t.label), words(t.title), words(t.num));
          const ok = p.words.every((w) => hay.some((h) => h.startsWith(w)) || kindMatches(w, t.kinds));
          if (!ok) return;
          // Kind matches ("lemma") before title matches.
          score = p.words.every((w) => kindMatches(w, t.kinds)) ? 0 : 1;
        }
      }
      out.push({ t, score, order });
    });
    out.sort((a, b) => a.score - b.score || a.order - b.order);
    return out.slice(0, max).map((x) => x.t);
  }

  /**
   * Read a search by use: "Lemma 2, (3.1) but not Assumption A" →
   * { inc: ['Lemma 2', '(3.1)'], exc: ['Assumption A'], any: false, direct: false }.
   * Terms are split at commas, "and", "&" and "+"; "or" between them asks for
   * any one instead of all. Everything after "not" ("but not", "without",
   * "except") is left out, as is a single term written "-Lemma 3". A leading
   * "uses" or "using" is dropped, and "directly" counts only links written in
   * the result itself.
   */
  function parseUses(query) {
    let q = String(query || '').replace(/\s+/g, ' ').trim();
    let direct = false;
    q = q.replace(/\bdirect(ly)?\b/gi, () => { direct = true; return ' '; }).replace(/\s+/g, ' ').trim();
    q = q.replace(/^(?:(?:results?|everything|what)\s+)?(?:that\s+|which\s+)?(?:uses?|using|needs?|needing|rel(?:y|ies|ying)\s+on|depends?\s+on|depending\s+on)\b\s*/i, '');
    const cut = /(?:^|[\s,;])(?:but\s+not|and\s+not|not|without|except|excluding|minus)(?=\s|$)/i.exec(q);
    const before = cut ? q.slice(0, cut.index) : q;
    const after = cut ? q.slice(cut.index + cut[0].length) : '';
    const SPLIT = /\s*(?:[,;&+]|\band\b|\bor\b)\s*|\s+(?=[-!−]\S)/i;
    const any = /\bor\b/i.test(before);
    const inc = [];
    const exc = [];
    for (const raw of before.split(SPLIT)) {
      const t = (raw || '').trim();
      if (/^[-!−]/.test(t)) { if (t.slice(1).trim()) exc.push(t.slice(1).trim()); } else if (t) inc.push(t);
    }
    for (const raw of after.split(SPLIT)) {
      const t = (raw || '').trim().replace(/^[-!−]\s*/, '');
      if (t) exc.push(t);
    }
    return { inc, exc, any: any && inc.length > 1, direct };
  }

  // ---------------------------------------------------------------------------
  // Reading the rendered document
  // ---------------------------------------------------------------------------

  // Not searched: math (KaTeX glyph soup), our own buttons and editors.
  const SKIP = '.katex, .math-src, .fold-toggle, .tg-sliders, button, textarea, input, select, script, style, .find-bar';
  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|SECTION|ARTICLE|FIGURE|TABLE|TR|TD|TH|BLOCKQUOTE|PRE|DT|DD|NAV)$/;
  const SEP = '￼'; // stands in for a formula, so words on either side don't run together

  /** The visible text of `root`, with a map back to its text nodes. */
  function indexText(rootEl) {
    const doc = rootEl.ownerDocument;
    const parts = []; // { node, start } for text, { node: null, start } for separators
    let text = '';
    const push = (node, s) => {
      parts.push({ node, start: text.length });
      text += s;
    };
    const walker = doc.createTreeWalker(rootEl, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode(n) {
        if (n.nodeType === 3) return 1; // FILTER_ACCEPT
        if (n.matches(SKIP)) {
          if (n.matches('.katex, .math-src')) push(null, SEP);
          return 2; // FILTER_REJECT: skip the subtree
        }
        if (BLOCK.test(n.tagName) || n.tagName === 'BR') push(null, '\n');
        return 3; // FILTER_SKIP: look inside
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) push(n, n.data);
    return { text, parts };
  }

  /** The DOM position of character `pos`; `end` picks the end of the previous text node at a separator. */
  function locate(index, pos, end) {
    const parts = index.parts;
    let lo = 0;
    let hi = parts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (parts[mid].start < pos || (!end && parts[mid].start === pos)) lo = mid;
      else hi = mid - 1;
    }
    let k = lo;
    if (!end) {
      while (k < parts.length && !parts[k].node) k++;
      if (k >= parts.length) return null;
      return { node: parts[k].node, offset: Math.max(0, pos - parts[k].start) };
    }
    while (k >= 0 && !parts[k].node) k--;
    if (k < 0) return null;
    return { node: parts[k].node, offset: Math.min(parts[k].node.data.length, pos - parts[k].start) };
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** The text of `el`, with each formula as its LaTeX source and no fold arrows. */
  function plainText(el) {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.katex').forEach((k) => {
      const tex = k.querySelector('annotation[encoding="application/x-tex"]');
      k.replaceWith(tex ? tex.textContent : '');
    });
    copy.querySelectorAll('.fold-toggle, .secnum').forEach((n) => n.remove());
    return clean(copy.textContent);
  }

  /** Everything in `rootEl` that has a number or a name to go to, in document order. */
  function collectTargets(rootEl) {
    const found = [];
    const sel = '[data-number], h1, h2, h3, h4, h5, h6, .math-display .katex-html .tag, .caption';
    for (const el of rootEl.querySelectorAll(sel)) {
      if (el.closest('.ref-popover, .find-bar, .toc, .editing')) continue;
      if (el.hasAttribute('data-number')) {
        const nameEl = el.querySelector('.thm-name');
        if (!nameEl) continue;
        const num = el.getAttribute('data-number') || '';
        const name = plainText(nameEl);
        const kind = num && name.endsWith(num) ? clean(name.slice(0, -num.length)) : name;
        const note = el.querySelector('.thm-note');
        found.push({ kinds: words(kind), label: kind, num, title: note ? plainText(note).replace(/^\((.*)\)$/, '$1') : '', el, block: el, type: 'theorem' });
      } else if (/^H[1-6]$/.test(el.tagName)) {
        if (!el.id || el.closest('.theorem, .proof')) continue;
        const numEl = el.querySelector('.secnum');
        let num = numEl ? clean(numEl.textContent) : '';
        const kindWord = (el.className.match(/\b(part|chapter|section|subsection|subsubsection|paragraph)\b/) || [])[1];
        const title = plainText(el);
        let label = kindWord ? kindWord[0].toUpperCase() + kindWord.slice(1) : 'Section';
        const kinds = [kindWord || 'section'];
        if (/^appendix\b/i.test(num)) {
          num = clean(num.replace(/^appendix\b/i, ''));
          label = 'Appendix';
          kinds.push('appendix');
        } else if (/^[A-Z]\b/.test(num)) {
          kinds.push('appendix');
        }
        if (kindWord && kindWord !== 'section' && /section$/.test(kindWord)) kinds.push('section');
        if (el.classList.contains('doc-title')) continue;
        found.push({ kinds, label, num, title, el, block: el, type: 'section' });
      } else if (el.classList.contains('tag')) {
        // One \tag per row; a multi-line display stacks them in one column.
        const rows = Array.from(el.querySelectorAll('.mord.text')).filter((r) => !r.parentElement.closest('.mord.text'));
        const block = el.closest('.math-display');
        for (const row of rows.length ? rows : [el]) {
          const num = clean(row.textContent).replace(/^\((.*)\)$/, '$1');
          if (num) found.push({ kinds: ['equation'], label: 'Equation', num, title: '', el: row, block, type: 'equation' });
        }
      } else {
        const head = el.querySelector('.caption-head');
        if (!head) continue;
        const m = /^(.*?)\s*([^\s]+?)\.?$/.exec(clean(head.textContent));
        if (!m) continue;
        const kind = m[1] || m[2];
        const num = m[1] ? m[2] : '';
        const title = plainText(el).slice(clean(head.textContent).length).trim();
        const block = el.parentElement && el.parentElement.tagName === 'FIGURE' ? el.parentElement : el;
        found.push({ kinds: words(kind), label: kind, num, title, el: block, block, type: 'figure' });
      }
    }
    return found;
  }

  /** How a target reads in the Go to list: "Lemma 4.1", "(3.2)", "Section 2". */
  function displayName(t) {
    if (t.type === 'equation') return `Equation (${t.num})`;
    return t.num ? `${t.label} ${t.num}` : t.label;
  }

  // ---------------------------------------------------------------------------
  // The find bar
  // ---------------------------------------------------------------------------

  const MAX_MATCHES = 10000;
  const ICONS = {
    up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  /**
   * Add the find bar to a preview.
   * options: { root: the rendered document, scroller: the element that scrolls it,
   *   reveal(el): unfold whatever hides el, onJump(el): optional, after going to a target,
   *   The Uses tab (with onFocus or uses): pick or type a result to see two
   *   lists, what it uses and what uses it; "and", "or" or "but not" between
   *   names searches by use instead.
   *   onFocus(el, o): optional; light up el with what it uses and what uses it
   *     (o.dir 'uses' or 'usedBy' for one side), starting at o.at if given
   *     (TeXglassInsight focus),
   *   related(el, { direct }): optional, { uses, usedBy } counts and the lists
   *     { usesEls, usedByEls } (TeXglassInsight related),
   *   uses(q): optional; search by use: q is { inc: [element],
   *     exc: [element], any, direct } (results and displayed equations), and it
   *     returns { results: [result elements], text } (TeXglassInsight searchUses),
   *   onUses(q, el): picking one of those results: light them all up, at el,
   *   pinSet(el): optional; "Pin as a set": pin a result with what it uses, as a
   *     pin set of its own (TeXglassInsight pinAsSet); returns the set's name }
   * Returns { open(mode, text), close(), next(), prev(), refresh(), state() }.
   */
  function attach(options) {
    const rootEl = options.root;
    const scroller = options.scroller || rootEl;
    const doc = rootEl.ownerDocument;
    const win = doc.defaultView;
    const reveal = options.reveal || (() => {});
    const hasHighlights = !!(win.CSS && win.CSS.highlights && win.Highlight);
    const hasUses = !!(options.onFocus || options.uses);

    const bar = doc.createElement('div');
    bar.className = 'find-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'search');
    bar.innerHTML =
      '<div class="find-row">' +
      '<div class="find-modes" role="tablist" aria-label="Search or go to">' +
      '<button type="button" role="tab" data-mode="find" title="Search the text (Ctrl+F)">Find</button>' +
      '<button type="button" role="tab" data-mode="goto" title="Go to a theorem, equation or section by its number (Ctrl+G)">Go to</button>' +
      (hasUses ? '<button type="button" role="tab" data-mode="uses" title="Pick a result to see what it uses and what uses it, or search by use: Lemma 2 but not Assumption A">Uses</button>' : '') +
      '</div>' +
      '<input class="find-input" type="text" spellcheck="false" autocomplete="off" aria-label="Search">' +
      '<span class="find-count" aria-live="polite"></span>' +
      `<button type="button" class="find-icon find-prev" title="Previous match (Shift+Enter)" aria-label="Previous match">${ICONS.up}</button>` +
      `<button type="button" class="find-icon find-next" title="Next match (Enter)" aria-label="Next match">${ICONS.down}</button>` +
      `<button type="button" class="find-icon find-close" title="Close (Esc)" aria-label="Close">${ICONS.close}</button>` +
      '</div>' +
      '<ul class="goto-list" role="listbox" aria-label="Places to go to" hidden></ul>';
    doc.body.appendChild(bar);
    const input = bar.querySelector('.find-input');
    const count = bar.querySelector('.find-count');
    const list = bar.querySelector('.goto-list');
    const prevBtn = bar.querySelector('.find-prev');
    const nextBtn = bar.querySelector('.find-next');

    let mode = 'find';
    let matches = []; // Ranges, in document order
    let current = -1;
    let capped = false;
    let results = []; // Go to: targets shown in the list
    let selected = 0;
    let queries = { find: '', goto: '', uses: '' };
    let usesDirect = false; // the Directly button in the Uses tab
    let usesQuery = null; // the search the Uses list shows: { inc, exc, any, direct }
    let kinds = []; // Uses tab: what picking results[k] does ('self', 'uses', 'usedBy', 'pick', 'found')
    let subject = null; // Uses tab: the result whose two lists are shown
    let searchTimer = 0;
    let stale = false;
    let lastQuery = '';

    // --- placing the bar over the top-right corner of the preview ---
    function place() {
      if (bar.hidden) return;
      const r = scroller.getBoundingClientRect();
      const vw = doc.documentElement.clientWidth;
      const width = Math.min(440, Math.max(240, r.width - 24));
      bar.style.width = width + 'px';
      bar.style.top = Math.max(0, r.top) + 8 + 'px';
      bar.style.left = Math.max(8, Math.min(r.right - width - 20, vw - width - 8)) + 'px';
    }
    win.addEventListener('resize', place);
    if (win.ResizeObserver) new win.ResizeObserver(place).observe(scroller);

    // --- highlights ---
    function paint() {
      if (!hasHighlights) return;
      if (matches.length) win.CSS.highlights.set('texglass-find', new win.Highlight(...matches));
      else win.CSS.highlights.delete('texglass-find');
      if (current >= 0 && matches[current]) win.CSS.highlights.set('texglass-find-current', new win.Highlight(matches[current]));
      else win.CSS.highlights.delete('texglass-find-current');
    }
    function clearPaint() {
      if (!hasHighlights) return;
      win.CSS.highlights.delete('texglass-find');
      win.CSS.highlights.delete('texglass-find-current');
    }

    function showCount() {
      const q = input.value.trim();
      if (mode !== 'find') return;
      bar.classList.toggle('no-match', !!q && !matches.length);
      if (!q) count.textContent = '';
      else if (!matches.length) count.textContent = 'No results';
      else count.textContent = `${current + 1} of ${matches.length}${capped ? '+' : ''}`;
      prevBtn.disabled = nextBtn.disabled = matches.length === 0;
    }

    /** Find every match; keep the current one near where it was. */
    function search(keepPlace) {
      stale = false;
      lastQuery = input.value.trim();
      const re = findRegex(input.value);
      const before = keepPlace && current >= 0 && matches[current] ? matches[current] : null;
      matches = [];
      current = -1;
      capped = false;
      if (re) {
        const index = indexText(rootEl);
        let m;
        while ((m = re.exec(index.text))) {
          if (!m[0]) { re.lastIndex++; continue; }
          const a = locate(index, m.index, false);
          const b = locate(index, m.index + m[0].length, true);
          if (!a || !b) continue;
          const range = doc.createRange();
          try {
            range.setStart(a.node, a.offset);
            range.setEnd(b.node, b.offset);
          } catch (e) { continue; }
          if (range.collapsed) continue;
          matches.push(range);
          if (matches.length >= MAX_MATCHES) { capped = true; break; }
        }
      }
      if (matches.length) {
        if (before) {
          // The first match at or after where we were.
          current = matches.findIndex((r) => {
            try { return r.compareBoundaryPoints(0 /* START_TO_START */, before) >= 0; } catch (e) { return false; }
          });
          if (current < 0) current = 0;
        } else {
          current = firstInView();
        }
      }
      paint();
      showCount();
    }

    /** The first match at or below the top of the view, so a new search starts where you are reading. */
    function firstInView() {
      const top = scroller.getBoundingClientRect().top;
      for (let k = 0; k < matches.length; k++) {
        const r = matches[k].getBoundingClientRect();
        if ((r.width || r.height) && r.bottom >= top) return k;
      }
      return 0;
    }

    let searchMoved = false; // since the bar opened
    function scrollToRange(range) {
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return;
      reveal(el);
      const view = scroller.getBoundingClientRect();
      let r = range.getBoundingClientRect();
      const margin = 64; // clear of the bar
      const away = (q) => q.top < view.top + margin || q.bottom > view.bottom - 24;
      // The first match the search moves to is a jump: Back (Alt+Left) returns from it.
      if (!searchMoved && ((!r.width && !r.height) || away(r))) {
        searchMoved = true;
        if (win.TeXglassScroll && win.TeXglassScroll.remember) win.TeXglassScroll.remember(scroller);
      }
      if (!r.width && !r.height) {
        el.scrollIntoView({ block: 'center' });
        r = range.getBoundingClientRect();
      }
      if (away(r)) {
        scroller.scrollTop += r.top - (view.top + view.height / 3);
      }
      if (!hasHighlights) {
        const s = win.getSelection();
        s.removeAllRanges();
        s.addRange(range);
      }
    }

    function step(dir) {
      if (mode !== 'find') return;
      if (stale) search(true);
      if (!matches.length) return;
      current = (current + dir + matches.length) % matches.length;
      paint();
      showCount();
      scrollToRange(matches[current]);
    }

    // --- Go to ---
    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    }
    function related(el) {
      try { return options.related ? options.related(el, { direct: usesDirect }) : null; } catch (e) { return null; }
    }
    /** "uses 3 · used in 5" for a result in the Uses list, or '' when unknown. */
    function relatedNote(t) {
      let c = null;
      try { c = options.related ? options.related(t.el) : null; } catch (e) { c = null; }
      if (!c) return '';
      const parts = [];
      if (c.uses) parts.push(`uses ${c.uses}`);
      if (c.usedBy) parts.push(`used in ${c.usedBy}`);
      return `<span class="goto-rel">${parts.length ? parts.join(' · ') : 'stands alone'}</span>`;
    }
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    /** One row of the Uses list; picking it does what kind says. */
    function row(t, kind, note) {
      const k = results.length;
      results.push(t);
      kinds.push(kind);
      return `<li role="option" id="goto-${k}" data-k="${k}" class="goto-${t.type}${kind === 'self' ? ' uses-self' : ''}"${k === 0 ? ' aria-selected="true"' : ''}>` +
        `<span class="goto-name">${escapeHtml(displayName(t))}</span>` +
        (t.title ? `<span class="goto-title">${escapeHtml(t.title)}</span>` : '') +
        (note || '') + '</li>';
    }
    const directBtn = (direct, locked) =>
      `<button type="button" class="uses-direct" aria-pressed="${direct}"${locked ? ' disabled' : ''} title="Count only links written in a result itself, not what it uses through other results">Directly</button>`;
    /** What the Uses tab can pick: results with an id, and displayed equations when it can search by them. */
    function usesTargets(withEquations) {
      return collectTargets(rootEl).filter((t) => (t.type === 'theorem' && t.el.id) || (withEquations && options.uses && t.type === 'equation'));
    }
    /** The Uses tab: one result's two lists, or a search by use when the text combines names. */
    function showUses() {
      const p = parseUses(input.value);
      const q = input.value.trim();
      results = [];
      kinds = [];
      selected = 0;
      usesQuery = null;
      subject = null;
      let html;
      if (p.inc.length + p.exc.length > 1 || p.exc.length) html = options.uses ? usesSearchHtml(p) : '<li class="goto-empty">Searching by several results isn\'t available here.</li>';
      else html = usesOneHtml(p);
      list.innerHTML = html;
      list.hidden = false;
      count.textContent = '';
      bar.classList.toggle('no-match', !!q && !results.length);
      input.setAttribute('aria-activedescendant', results.length ? 'goto-0' : '');
    }
    /** No text yet: every result, to pick one. One name: that result, what it uses and what uses it. */
    function usesOneHtml(p) {
      const term = p.inc[0] || '';
      if (!term) {
        const all = usesTargets(false);
        return '<li class="goto-empty uses-help">Pick or type a result to see what it uses and what uses it. ' +
          'Combine names to search by use: <b>Lemma 2, (3.1)</b> (both), <b>Lemma 2 or Lemma 3</b>, <b>Theorem 1 but not Assumption A</b>, <b>not Assumption A</b>.</li>' +
          (all.length ? all.map((t) => row(t, 'pick', relatedNote(t))).join('') : '<li class="goto-empty">This document has no numbered theorems, lemmas or definitions.</li>');
      }
      const ranked = rankTargets(usesTargets(true), term, 40);
      if (!ranked.length) return `<li class="goto-empty">No theorem, lemma or equation matches “${escapeHtml(term)}”</li>`;
      const t = ranked[0];
      subject = t;
      const direct = p.direct || usesDirect;
      const eq = t.type === 'equation';
      let usesEls = null;
      let usedByEls = null;
      if (!eq) {
        const c = related(t.el);
        if (c && c.usesEls) { usesEls = c.usesEls; usedByEls = c.usedByEls; }
      }
      if (!usedByEls && options.uses) {
        let res = null;
        try { res = options.uses({ inc: [eq ? t.block : t.el], exc: [], any: false, direct }); } catch (e) { res = null; }
        if (res) usedByEls = res.results;
      }
      const byEl = new Map(usesTargets(false).map((x) => [x.el, x]));
      const asTarget = (el) => byEl.get(el) || { el, block: el, type: 'theorem', label: (el.querySelector('.thm-name') || el).textContent.trim(), num: '', title: '' };
      const name = escapeHtml(displayName(t));
      const sum = [];
      if (usesEls) sum.push(usesEls.length ? `uses ${plural(usesEls.length, 'result')}` : 'uses no result');
      if (usedByEls) sum.push(usedByEls.length ? `is used in ${plural(usedByEls.length, 'result')}` : 'is used in no result');
      const pinSetBtn = !eq && options.pinSet && usesEls && usesEls.length
        ? '<button type="button" class="uses-pinset" title="Pin it with everything it uses, kept as a pin set of its own (your other pins stay)">Pin as a set</button>' : '';
      let html = `<li class="uses-head"><span class="uses-sum"><strong>${name}</strong> ${sum.join(', ') || ''}${direct ? ' directly' : ''}</span>${pinSetBtn}${directBtn(direct, p.direct)}</li>`;
      html += row(t, 'self', `<span class="goto-rel">${eq ? 'light up what uses it' : 'light up both ways'}</span>`);
      const group = (title, els, kind) => {
        let h = `<li class="uses-group" role="presentation">${title}</li>`;
        h += els.length ? els.map((el) => row(asTarget(el), kind)).join('') : '<li class="goto-empty uses-none">Nothing</li>';
        return h;
      };
      if (usesEls) html += group('Uses', usesEls, 'uses');
      if (usedByEls) html += group('Used by', usedByEls, 'usedBy');
      const others = ranked.slice(1, 9);
      if (others.length) html += '<li class="uses-group" role="presentation">Other matches</li>' + others.map((x) => row(x, 'pick', x.type === 'theorem' ? relatedNote(x) : '')).join('');
      return html;
    }
    /** Several names: every result that uses all of them (or any one), and none of those after "but not". */
    function usesSearchHtml(p) {
      const targets = usesTargets(true);
      const pick = (term) => {
        const t = rankTargets(targets, term, 1)[0];
        return t ? (t.type === 'equation' ? t.block : t.el) : null;
      };
      const inc = p.inc.map(pick);
      const exc = p.exc.map(pick);
      const missing = p.inc.concat(p.exc).filter((term, k) => !(k < p.inc.length ? inc[k] : exc[k - p.inc.length]));
      const direct = p.direct || usesDirect;
      let res = null;
      if (!missing.length) {
        usesQuery = { inc, exc, any: p.any, direct };
        try { res = options.uses(usesQuery); } catch (e) { res = null; }
      }
      if (!res) {
        usesQuery = null;
        return `<li class="goto-empty">${missing.length ? 'No theorem, lemma or equation matches “' + escapeHtml(missing[0]) + '”' : 'Nothing to search by.'}</li>`;
      }
      const byEl = new Map(targets.map((t) => [t.el, t]));
      const found = res.results.map((el) => byEl.get(el) || { el, block: el, type: 'theorem', label: (el.querySelector('.thm-name') || el).textContent.trim(), num: '', title: '' });
      const n = found.length;
      return `<li class="uses-head"><span class="uses-sum"><strong>${n ? plural(n, 'result') : 'No result'}</strong> ${escapeHtml(res.text)}</span>${directBtn(direct, p.direct)}</li>` +
        found.map((t) => row(t, 'found')).join('');
    }

    function showGoto() {
      if (mode === 'uses') return showUses();
      results = rankTargets(collectTargets(rootEl), input.value, 200);
      kinds = [];
      selected = 0;
      const q = input.value.trim();
      const empty = q ? 'Nothing numbered or named “' + escapeHtml(q) + '”' : 'This document has no numbered theorems, equations or sections.';
      list.innerHTML = results.length
        ? results.map((t, k) =>
          `<li role="option" id="goto-${k}" data-k="${k}" class="goto-${t.type}"${k === 0 ? ' aria-selected="true"' : ''}>` +
          `<span class="goto-name">${escapeHtml(displayName(t))}</span>` +
          (t.title ? `<span class="goto-title">${escapeHtml(t.title)}</span>` : '') +
          '</li>').join('')
        : `<li class="goto-empty">${empty}</li>`;
      list.hidden = false;
      count.textContent = '';
      bar.classList.toggle('no-match', !!q && !results.length);
      input.setAttribute('aria-activedescendant', results.length ? 'goto-0' : '');
    }
    function select(k) {
      if (!results.length) return;
      selected = (k + results.length) % results.length;
      list.querySelectorAll('[aria-selected]').forEach((li) => li.removeAttribute('aria-selected'));
      const li = list.querySelector(`[data-k="${selected}"]`);
      if (li) {
        li.setAttribute('aria-selected', 'true');
        li.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', li.id);
      }
    }
    function go(k) {
      const t = results[k];
      if (!t || !t.el.isConnected) return;
      if (mode === 'uses' && kinds[k] === 'pick') {
        // another result: show its two lists
        input.value = queries.uses = displayName(t);
        showUses();
        input.focus();
        return;
      }
      if (mode === 'uses' && goUses(t, kinds[k])) return;
      close();
      reveal(t.el);
      // Glide only when it is close; a long smooth scroll sweeps the whole page.
      const r = t.el.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if ((r.bottom < view.top || r.top > view.bottom) && win.TeXglassScroll && win.TeXglassScroll.remember) win.TeXglassScroll.remember(scroller);
      const far = r.bottom < -innerHeight || r.top > 2 * innerHeight;
      t.el.scrollIntoView({ behavior: far ? 'auto' : 'smooth', block: 'center' });
      const flash = t.block || t.el;
      flash.classList.remove('flash');
      void flash.offsetWidth;
      flash.classList.add('flash');
      if (options.onJump) options.onJump(t.el);
    }

    /** Picking in the Uses tab: light up what it found, starting at t. */
    function goUses(t, kind) {
      const s = subject;
      const one = s && (s.type === 'equation' ? s.block : s.el);
      const byUse = (inc, at) => {
        if (!options.onUses) return false;
        options.onUses({ inc: [inc], exc: [], any: false, direct: usesDirect || parseUses(input.value).direct }, at);
        return true;
      };
      let done = false;
      close();
      reveal(t.el);
      if (kind === 'found') {
        // every result the search found, starting at this one
        if (options.onUses && usesQuery) { options.onUses(usesQuery, t.el); done = true; }
      } else if (kind === 'self') {
        if (t.type === 'equation') done = byUse(t.block, null);
        else if (options.onFocus) { options.onFocus(t.el, { dir: 'both' }); done = true; }
        else done = byUse(t.el, null);
      } else if (kind === 'usedBy' && one) {
        // what uses it, as a search by use, so the bar steps through them
        done = byUse(one, t.el);
        if (!done && options.onFocus && s.type !== 'equation') { options.onFocus(s.el, { dir: 'usedBy', at: t.el }); done = true; }
      } else if (kind === 'uses' && one && options.onFocus) {
        options.onFocus(s.el, { dir: 'uses', at: t.el });
        done = true;
      }
      if (!done) return false;
      if (options.onJump) options.onJump(t.el);
      return true;
    }

    // --- modes, opening and closing ---
    function setMode(m) {
      // (same mode: open() may have just put new text in queries[m])
      if (m !== mode) queries[mode] = input.value;
      mode = m;
      bar.dataset.mode = m;
      bar.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
      input.value = queries[m];
      input.placeholder = m === 'find' ? 'Find in document' : m === 'goto' ? 'Lemma 4.1, (3.2), §2, or a name' : 'Lemma 2, or Lemma 2 but not Assumption A';
      input.setAttribute('aria-label', m === 'find' ? 'Find in document' : m === 'goto' ? 'Go to a theorem, equation or section' : 'A result, to see what it uses and what uses it, or a search by use');
      input.setAttribute('role', m === 'find' ? 'searchbox' : 'combobox');
      list.setAttribute('aria-label', m === 'uses' ? 'Results' : 'Places to go to');
      if (m !== 'find') input.setAttribute('aria-expanded', 'true');
      else input.removeAttribute('aria-expanded');
      prevBtn.hidden = nextBtn.hidden = m !== 'find';
      if (m === 'find') {
        list.hidden = true;
        bar.classList.remove('no-match');
        search(false);
        if (current >= 0) scrollToRange(matches[current]);
      } else {
        clearPaint();
        showGoto();
      }
    }

    function open(m, text) {
      if (m === 'trace') m = 'uses'; // the old Trace tab is part of Uses now
      if (m === 'uses' && !hasUses) m = 'goto';
      const wasOpen = !bar.hidden;
      if (!wasOpen) searchMoved = false;
      bar.hidden = false;
      place();
      if (text != null) queries[m || mode] = text;
      if (!wasOpen || (m && m !== mode) || text != null) setMode(m || mode);
      input.focus();
      input.select();
    }

    function close() {
      if (bar.hidden) return;
      queries[mode] = input.value;
      bar.hidden = true;
      clearPaint();
      list.hidden = true;
      if (!hasHighlights && mode === 'find') win.getSelection().removeAllRanges();
      // Leave the current match selected, like a browser's find.
      if (hasHighlights && mode === 'find' && matches[current]) {
        try {
          const s = win.getSelection();
          s.removeAllRanges();
          s.addRange(matches[current]);
        } catch (e) { /* ignore */ }
      }
      matches = [];
      current = -1;
      if (doc.activeElement === input || bar.contains(doc.activeElement)) scroller.focus({ preventScroll: true });
    }

    // --- events ---
    input.addEventListener('input', () => {
      queries[mode] = input.value;
      if (mode !== 'find') return showGoto();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        search(false);
        if (current >= 0) scrollToRange(matches[current]);
      }, input.value.length < 3 ? 250 : 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (bar.hidden) return; // closed already (the focus stayed here): Esc is for the page
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'find') {
          clearTimeout(searchTimer);
          if (input.value.trim() !== lastQuery) {
            // Typed but not searched yet: land on the first match, not the second.
            search(false);
            if (current >= 0) scrollToRange(matches[current]);
          } else {
            step(e.shiftKey ? -1 : 1);
          }
        } else {
          go(selected);
        }
      } else if (mode !== 'find' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        select(selected + (e.key === 'ArrowDown' ? 1 : -1));
      }
    });
    // Esc closes the bar from anywhere in the page, not only from its input
    // (after clicking a match, a button or the document, say), unless an
    // editor or another box has the focus and wants Esc for itself.
    win.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || bar.hidden || e.defaultPrevented) return;
      const t = e.target;
      if (t && t.closest && !bar.contains(t) && t.matches('textarea, input, select, [contenteditable="true"]')) return;
      e.preventDefault();
      close();
    });
    bar.addEventListener('click', (e) => {
      // Not just [data-mode]: the bar itself carries data-mode, so that would catch every click.
      const tab = e.target.closest('button[role="tab"][data-mode]');
      if (tab) {
        setMode(tab.dataset.mode);
        input.focus();
        return;
      }
      const ps = e.target.closest('.uses-pinset');
      if (ps) {
        let name = null;
        try { name = subject && options.pinSet ? options.pinSet(subject.el) : null; } catch (err) { name = null; }
        if (name) { ps.textContent = 'Pinned ✓'; ps.disabled = true; ps.title = `Kept as the pin set “${name}” (the Pins tab lists it)`; }
        return;
      }
      if (e.target.closest('.uses-direct')) {
        usesDirect = !usesDirect;
        showUses();
        input.focus();
        return;
      }
      if (e.target.closest('.find-prev')) step(-1);
      else if (e.target.closest('.find-next')) step(1);
      else if (e.target.closest('.find-close')) close();
      else {
        const li = e.target.closest('li[data-k]');
        if (li) go(Number(li.dataset.k));
      }
    });
    list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('li[data-k]');
      if (li && Number(li.dataset.k) !== selected) select(Number(li.dataset.k));
    });

    // Keep matches current while the preview re-renders underneath.
    let refreshTimer = 0;
    function refresh() {
      if (bar.hidden) return;
      if (mode === 'find') {
        stale = true;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { if (!bar.hidden && mode === 'find') search(true); }, 200);
      } else {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { if (!bar.hidden && mode !== 'find') { const k = selected; showGoto(); select(Math.min(k, results.length - 1)); } }, 200);
      }
    }
    if (win.MutationObserver) {
      new win.MutationObserver((records) => {
        if (records.some((r) => !bar.contains(r.target))) refresh();
      }).observe(rootEl, { childList: true, subtree: true, characterData: true });
    }

    return {
      open,
      close,
      next: () => step(1),
      prev: () => step(-1),
      refresh,
      isOpen: () => !bar.hidden,
      state: () => ({ open: !bar.hidden, mode, query: input.value, count: matches.length, current, results: results.map(displayName) }),
      element: bar,
    };
  }

  /**
   * The usual shortcuts: Ctrl/Cmd+F to find, Ctrl/Cmd+G to go to, F3 and
   * Shift+F3 for the next and previous match. Not while typing in an editor,
   * so the source pane keeps the browser's own find.
   */
  function bindKeys(win, finder, options) {
    const opts = options || {};
    win.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target;
      const typing = t && t.closest && !t.closest('.find-bar') && t.matches('textarea, input, [contenteditable="true"]');
      if (typing && !opts.evenWhileTyping) return;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && !e.shiftKey && key === 'f') {
        e.preventDefault();
        finder.open('find', selectedText(win));
      } else if (mod && !e.altKey && !e.shiftKey && key === 'g') {
        e.preventDefault();
        finder.open('goto');
      } else if (e.key === 'F3' && finder.isOpen()) {
        e.preventDefault();
        if (e.shiftKey) finder.prev();
        else finder.next();
      }
    });
  }

  /** A short single-line selection seeds the search, like a browser's find. */
  function selectedText(win) {
    const s = String(win.getSelection ? win.getSelection() : '').trim();
    return s && s.length <= 100 && !/\n/.test(s) ? s : null;
  }

  return { attach, bindKeys, findRegex, parseJump, parseUses, rankTargets, collectTargets, indexText, locate, displayName };
});
