/*
 * Compare two versions of a paper (arXiv v1 and v2, a file and its last
 * commit, any two .tex files) block by block, the way a reader thinks of a
 * paper: theorems, proofs, equations, headings and paragraphs, matched by
 * their \label, their heading or their place in the text rather than by raw
 * lines. A theorem that moved, or was renumbered, is still the same theorem.
 *
 *   compare(oldUnits, newUnits)  the diff of two lists of blocks
 *   unitsOf(blocks, source)      those blocks from TeXglass.render(…, { sourceMap: true })
 *   wordDiff(a, b)               the words two texts share, and those they don't
 *   view(options)                in a page: mark what changed, with a bar to step
 *                                through the changes and show the old version
 *
 * Works in browsers and in Node (compare, unitsOf and wordDiff need no DOM).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLOCK_HEAD = /^<div class="src-block" data-s="(\d+)" data-e="(\d+)">/;
  const THEOREMISH = /^(?:theorem|lemma|proposition|corollary|conjecture|definition|remark|example|claim|assumption|hypothesis|notation|problem|question|exercise|fact|observation|condition|property|axiom|thm|lem|prop|cor|defn?|rem|rmk|ex|conj|ass|hyp|not)\*?$/i;

  /** LaTeX without comments, with runs of white space as one space. */
  function normalize(tex) {
    return String(tex || '')
      .replace(/(^|[^\\])%.*$/gm, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** What identifies a block across versions, read from its source, or null. */
  function keyOf(tex) {
    const t = normalize(tex);
    let m = /^\\begin\s*\{proof\}\s*\[[^\]]*?\\(?:c?ref|Cref|autoref|ref)\*?\s*\{([^}]+)\}/.exec(t);
    if (m) return { key: 'P:L:' + m[1].split(',')[0].trim(), kind: 'proof' };
    if (/^\\begin\s*\{proof\}/.test(t)) return { key: null, kind: 'proof' };
    m = /^\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(t);
    if (m) {
      const label = /\\label\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(t);
      const title = t.slice(m[0].length).replace(/\\label\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '').replace(/\}\s*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return { key: label ? 'L:' + label[1] : 'S:' + m[1] + ':' + title, kind: 'heading' };
    }
    m = /^\\begin\s*\{([^}]+)\}\s*(\[[^\]]*\])?/.exec(t);
    const env = m ? m[1] : '';
    const label = /\\label\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(t);
    const kind = !m ? 'text'
      : /^(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math)\*?$/.test(env) ? 'equation'
        : /^(figure|table)\*?$/.test(env) ? 'figure'
          : THEOREMISH.test(env) || /^\\begin\s*\{[^}]+\}\s*\[/.test(t) ? 'result'
            : 'text';
    if (label) return { key: 'L:' + label[1], kind };
    if (kind === 'result' && m[2]) return { key: 'T:' + env + ':' + m[2].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), kind };
    if (/^(abstract|titlepage|acknowledg(e)?ments?)$/.test(env)) return { key: 'E:' + env, kind: 'text' };
    if (/^\\\[/.test(t) || /^\$\$/.test(t)) return { key: null, kind: 'equation' };
    return { key: null, kind };
  }

  /**
   * The blocks of a render ({ blocks } from TeXglass.render with sourceMap) as
   * units to compare: [{ s, e, tex, text, key, kind, html }].
   */
  function unitsOf(blocks, source) {
    const out = [];
    source = String(source || '').replace(/\r\n?/g, '\n'); // as the renderer reads it, so its offsets fit
    for (const html of blocks || []) {
      const h = BLOCK_HEAD.exec(html);
      if (!h) continue;
      const s = Number(h[1]);
      const e = Number(h[2]);
      const tex = source.slice(s, e);
      const k = keyOf(tex);
      out.push({ s, e, tex, text: normalize(tex), key: k.key, kind: k.kind, html, look: looks(html) });
    }
    // A proof with no label of its own belongs to the result just before it.
    for (let i = 1; i < out.length; i++) {
      if (out[i].kind === 'proof' && !out[i].key && out[i - 1].key && out[i - 1].kind === 'result') out[i].key = 'P:' + out[i - 1].key;
    }
    return out;
  }

  /** A block's HTML without what moves with every edit (source range, ids, numbers kept). */
  const looks = (html) => String(html || '').replace(BLOCK_HEAD, '').replace(/\s(?:id|data-s|data-e)="[^"]*"/g, '');

  /** Words and symbols of a text, for measuring how alike two blocks are. */
  const words = (text) => String(text || '').toLowerCase().match(/\\[a-z]+|[a-z0-9]+|[^\sa-z0-9]/gi) || [];

  /** How alike two texts are, from 0 (nothing shared) to 1 (the same words). */
  function similarity(a, b) {
    if (a === b) return 1;
    const wa = words(a);
    const wb = words(b);
    if (!wa.length || !wb.length) return 0;
    const count = new Map();
    for (const w of wa) count.set(w, (count.get(w) || 0) + 1);
    let shared = 0;
    for (const w of wb) {
      const c = count.get(w);
      if (c) { shared++; count.set(w, c - 1); }
    }
    return (2 * shared) / (wa.length + wb.length);
  }

  /** The longest common subsequence of a and b under eq, as pairs [i, j]. */
  function lcs(a, b, eq) {
    const n = a.length;
    const m = b.length;
    if (!n || !m) return [];
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = eq(a[i], b[j]) ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) { pairs.push([i, j]); i++; j++; } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  /** The longest run of pairs increasing in both coordinates (pairs sorted by [0]). */
  function increasing(pairs) {
    const tails = [];
    const prev = new Array(pairs.length);
    for (let k = 0; k < pairs.length; k++) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
        else hi = mid;
      }
      prev[k] = lo ? tails[lo - 1] : -1;
      tails[lo] = k;
    }
    const out = [];
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k]);
    return out.reverse();
  }

  const MAX_GAP = 600 * 600; // past this, a gap is not searched for exact repeats

  /**
   * The diff of two versions, given as units (unitsOf, or anything with
   * { text, key }). Returns { items, counts }: items in reading order of the
   * new version, each { status, a, b, sim }, status one of 'same', 'changed',
   * 'added', 'removed' or 'moved' (a result or equation that is now somewhere
   * else; moved items may also have changed, see sim < 1); a and b are indexes
   * into the old and new units, null when absent. Removed items sit where they
   * were, after whatever came before them in the old version.
   */
  function compare(olds, news) {
    const A = olds || [];
    const B = news || [];
    const pairOfA = new Array(A.length).fill(-1);
    const pairOfB = new Array(B.length).fill(-1);
    const moved = new Set(); // indexes in B

    // 1. Anchors: the same key on both sides (unique on each), or the same text found once on each side.
    const uniq = (list, f) => {
      const seen = new Map();
      list.forEach((u, i) => { const k = f(u); if (k != null) seen.set(k, seen.has(k) ? -1 : i); });
      return seen;
    };
    const keyA = uniq(A, (u) => u.key);
    const keyB = uniq(B, (u) => u.key);
    const textA = uniq(A, (u) => u.text || null);
    const textB = uniq(B, (u) => u.text || null);
    const cand = new Map();
    for (const [k, i] of keyA) { const j = keyB.get(k); if (i >= 0 && j >= 0) cand.set(i, { j, byKey: true }); }
    for (const [k, i] of textA) {
      const j = textB.get(k);
      if (i >= 0 && j >= 0 && !cand.has(i) && !(B[j].key && keyA.has(B[j].key) && B[j].key !== A[i].key)) cand.set(i, { j, byKey: false });
    }
    const usedB = new Set();
    let pairs = [];
    for (const [i, c] of Array.from(cand.entries()).sort((x, y) => x[0] - y[0])) {
      if (usedB.has(c.j)) continue;
      usedB.add(c.j);
      pairs.push([i, c.j, c.byKey]);
    }
    const order = increasing(pairs);
    const inOrder = new Set(order.map((p) => p[0]));
    for (const p of pairs) {
      if (inOrder.has(p[0])) continue;
      // Out of order: the same block (by its label, or word for word) now somewhere else.
      pairOfA[p[0]] = p[1];
      pairOfB[p[1]] = p[0];
      moved.add(p[1]);
    }
    for (const [i, j] of order) { pairOfA[i] = j; pairOfB[j] = i; }

    // 2. Between anchors: exact repeats in order, then blocks that changed (alike enough), in order.
    const bounds = [[-1, -1]].concat(order.map((p) => [p[0], p[1]])).concat([[A.length, B.length]]);
    for (let g = 0; g + 1 < bounds.length; g++) {
      const ga = [];
      const gb = [];
      for (let i = bounds[g][0] + 1; i < bounds[g + 1][0]; i++) if (pairOfA[i] < 0) ga.push(i);
      for (let j = bounds[g][1] + 1; j < bounds[g + 1][1]; j++) if (pairOfB[j] < 0) gb.push(j);
      if (!ga.length || !gb.length) continue;
      const exact = ga.length * gb.length <= MAX_GAP ? lcs(ga, gb, (i, j) => !!A[i].text && A[i].text === B[j].text) : [];
      for (const [x, y] of exact) { pairOfA[ga[x]] = gb[y]; pairOfB[gb[y]] = ga[x]; }
      // Sub-gaps between those exact repeats.
      const marks = [[-1, -1]].concat(exact).concat([[ga.length, gb.length]]);
      for (let h = 0; h + 1 < marks.length; h++) {
        const sa = ga.slice(marks[h][0] + 1, marks[h + 1][0]);
        const sb = gb.slice(marks[h][1] + 1, marks[h + 1][1]);
        let from = 0;
        for (const i of sa) {
          let best = -1;
          let bestSim = 0;
          for (let y = from; y < sb.length && y < from + 40; y++) {
            const j = sb[y];
            if (A[i].kind !== B[j].kind && !(A[i].kind === 'text' || B[j].kind === 'text')) continue;
            const sim = similarity(A[i].text, B[j].text);
            if (sim > bestSim) { bestSim = sim; best = y; }
          }
          if (best >= 0 && bestSim >= 0.4) {
            pairOfA[i] = sb[best];
            pairOfB[sb[best]] = i;
            from = best + 1;
          }
        }
      }
    }

    // 3. In reading order of the new version, with removed blocks where they were.
    const items = [];
    const counts = { changed: 0, added: 0, removed: 0, moved: 0, same: 0 };
    const push = (it) => { items.push(it); counts[it.status]++; };
    let i = 0;
    const flushRemoved = (upto) => {
      for (; i < upto; i++) {
        if (pairOfA[i] < 0) push({ status: 'removed', a: i, b: null, sim: 0 });
      }
    };
    for (let j = 0; j < B.length; j++) {
      const a = pairOfB[j];
      if (a >= 0 && !moved.has(j)) {
        flushRemoved(a);
        i = Math.max(i, a + 1);
        // the same source, or a different source that looks the same (e.g. \label{x} became \label[lemma]{x})
        const sim = A[a].text === B[j].text || (A[a].look && A[a].look === B[j].look) ? 1 : similarity(A[a].text, B[j].text);
        push({ status: sim === 1 ? 'same' : 'changed', a, b: j, sim });
      } else if (a >= 0) {
        push({ status: 'moved', a, b: j, sim: A[a].text === B[j].text || (A[a].look && A[a].look === B[j].look) ? 1 : similarity(A[a].text, B[j].text) });
      } else push({ status: 'added', a: null, b: j, sim: 0 });
    }
    flushRemoved(A.length);
    return { items, counts };
  }

  /** compare() on two renders: { blocks } and their sources. */
  function compareRenders(oldBlocks, oldSource, newBlocks, newSource) {
    const olds = unitsOf(oldBlocks, oldSource);
    const news = unitsOf(newBlocks, newSource);
    return Object.assign(compare(olds, news), { olds, news });
  }

  /**
   * Which tokens two token lists share: { a: [kept?], b: [kept?] }, true where
   * the token is in both (in order), false where it was taken out (a) or put in (b).
   */
  function wordDiff(a, b) {
    const ka = new Array(a.length).fill(false);
    const kb = new Array(b.length).fill(false);
    // Trim what both ends share, then find the rest; long texts fall back to a coarse answer.
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) { ka[p] = kb[p] = true; p++; }
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) {
      ka[a.length - 1 - q] = kb[b.length - 1 - q] = true;
      q++;
    }
    const ma = a.slice(p, a.length - q);
    const mb = b.slice(p, b.length - q);
    if (ma.length * mb.length <= 4e6) {
      for (const [x, y] of lcs(ma, mb, (u, v) => u === v)) { ka[p + x] = true; kb[p + y] = true; }
    }
    return { a: ka, b: kb };
  }

  // --- in a page ---------------------------------------------------------------

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** What a reader would call a block: "Theorem 2.1", "Proof of Lemma 3.4", "Equation (5)", "§2 Setting", "Text in §3". */
  function nameOf(el, prev) {
    const thm = el.querySelector('.thm-name');
    if (thm) return thm.textContent.trim();
    if (el.querySelector('.abstract')) return 'Abstract';
    const cap = el.querySelector('.caption-head');
    if (cap) return cap.textContent.trim().replace(/[.:]$/, '');
    const h = el.querySelector('h1, h2, h3, h4, h5, h6');
    if (h) {
      const num = h.querySelector('.secnum');
      const title = h.textContent.replace(num ? num.textContent : '', '').trim();
      return (num ? '§' + num.textContent.trim() + ' ' : '') + title;
    }
    if (el.querySelector('.proof')) return prev && prev.result ? 'Proof of ' + prev.result : 'Proof';
    const tag = el.querySelector('.math-display .tag');
    if (tag) return 'Equation ' + tag.textContent.trim();
    if (el.querySelector('.math-display')) return 'Display' + (prev && prev.section ? ' in §' + prev.section : '');
    if (el.querySelector('figure, .figure, img')) return 'Figure' + (prev && prev.section ? ' in §' + prev.section : '');
    return 'Text' + (prev && prev.section ? ' in §' + prev.section : '');
  }

  /** Tokens of a block for the word diff: words in its text, and each formula (by its TeX) as one token. */
  function tokensOf(el) {
    const out = []; // { t, node, start, end } for words; { t, math } for formulas
    const walk = (n) => {
      if (n.nodeType === 3) {
        const re = /\S+/g;
        let m;
        while ((m = re.exec(n.data))) out.push({ t: m[0], node: n, start: m.index, end: m.index + m[0].length });
        return;
      }
      if (n.nodeType !== 1) return;
      const cls = n.classList;
      if (cls.contains('math') || cls.contains('katex')) {
        out.push({ t: '⟨' + (n.getAttribute('data-tex') || n.textContent) + '⟩', math: n });
        return;
      }
      if (cls.contains('fold-toggle') || cls.contains('diff-tag') || cls.contains('rp-marks') || cls.contains('uses-btn') || cls.contains('steps-btn') || cls.contains('tg-pin-btn') || n.tagName === 'BUTTON' || n.tagName === 'SVG' || n.tagName === 'svg') return;
      for (const c of Array.from(n.childNodes)) walk(c);
    };
    walk(el);
    return out;
  }

  /** Wrap the tokens not kept in <ins>/<del> (words) or mark them (formulas). */
  function markTokens(tokens, kept, tag) {
    const byNode = new Map();
    tokens.forEach((tok, k) => {
      if (kept[k]) return;
      if (tok.math) { tok.math.classList.add(tag === 'ins' ? 'diff-math-ins' : 'diff-math-del'); return; }
      if (!byNode.has(tok.node)) byNode.set(tok.node, []);
      byNode.get(tok.node).push(tok);
    });
    for (const [node, toks] of byNode) {
      // Merge neighbouring words (and the space between them) into one mark.
      const runs = [];
      for (const t of toks) {
        const last = runs[runs.length - 1];
        if (last && !/\S/.test(node.data.slice(last.end, t.start))) last.end = t.end;
        else runs.push({ start: t.start, end: t.end });
      }
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const r of runs) {
        if (r.start > at) frag.appendChild(document.createTextNode(node.data.slice(at, r.start)));
        const mark = document.createElement(tag);
        mark.className = 'diff-' + tag;
        mark.textContent = node.data.slice(r.start, r.end);
        frag.appendChild(mark);
        at = r.end;
      }
      if (at < node.data.length) frag.appendChild(document.createTextNode(node.data.slice(at)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /** An old block's HTML made safe to show beside the new one: no ids (they would clash), no source range. */
  function oldBody(html) {
    let h = String(html || '');
    if (BLOCK_HEAD.test(h)) h = h.slice(h.indexOf('>') + 1).replace(/<\/div>\s*$/, '');
    return h.replace(/\sid="/g, ' data-old-id="');
  }

  /**
   * Show a comparison in a page.
   *   root        the element holding the new version's blocks (.src-block with data-s)
   *   result      compareRenders(…)
   *   labels      { old: 'v1', new: 'v2' }
   *   onExit()    the bar's close button
   *   jump(el)    scroll to a block (defaults to scrollIntoView)
   *   resolveOld(html) → html, e.g. to point the old figures at their files
   * Returns { apply(result), clear(), next(), prev(), destroy(), counts }.
   * Call clear() before the page's blocks change and apply() after.
   */
  function view(options) {
    const opts = options || {};
    const root = opts.root;
    const doc = root.ownerDocument;
    const labels = Object.assign({ old: 'old', new: 'new' }, opts.labels || {});
    let result = opts.result || null;
    let marks = []; // [{ el, name, status }] in reading order
    let current = -1;
    let only = false;

    const bar = doc.createElement('div');
    bar.className = 'diff-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Changes between versions');
    bar.innerHTML =
      `<span class="diff-title"><b>${esc(labels.old)}</b> → <b>${esc(labels.new)}</b></span>` +
      '<span class="diff-counts"></span>' +
      '<span class="diff-step-group"><button type="button" class="diff-prev" title="The change before this one">‹</button>' +
      '<span class="diff-step"></span>' +
      '<button type="button" class="diff-next" title="The next change">›</button></span>' +
      '<select class="diff-list" aria-label="Go to a change" title="Go to a change"></select>' +
      '<button type="button" class="diff-only" aria-pressed="false" title="Show only what changed, with the section headings">Only changes</button>' +
      '<button type="button" class="diff-close" title="Stop comparing" aria-label="Stop comparing">×</button>';
    (opts.barParent || doc.body).appendChild(bar);
    const $ = (sel) => bar.querySelector(sel);
    $('.diff-prev').addEventListener('click', () => step(-1));
    $('.diff-next').addEventListener('click', () => step(1));
    $('.diff-list').addEventListener('change', (e) => go(Number(e.target.value)));
    $('.diff-only').addEventListener('click', () => {
      only = !only;
      root.classList.toggle('diff-only-changes', only);
      $('.diff-only').setAttribute('aria-pressed', String(only));
    });
    $('.diff-close').addEventListener('click', () => (opts.onExit ? opts.onExit() : destroy()));

    // Show or hide the old version of a changed block.
    root.addEventListener('click', onClick);
    function onClick(e) {
      const t = e.target.closest && e.target.closest('.diff-tag[data-toggle]');
      if (!t || !root.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
      const box = t.closest('.src-block, .diff-old');
      const old = box && box.nextElementSibling;
      if (box && box.classList.contains('diff-old')) {
        box.classList.toggle('diff-open');
        t.setAttribute('aria-expanded', String(box.classList.contains('diff-open')));
        return;
      }
      if (old && old.classList.contains('diff-old')) {
        old.hidden = !old.hidden;
        t.setAttribute('aria-expanded', String(!old.hidden));
      }
    }

    function tag(text, title, toggle) {
      const b = doc.createElement(toggle ? 'button' : 'span');
      b.className = 'diff-tag';
      if (toggle) {
        b.type = 'button';
        b.dataset.toggle = '1';
        b.setAttribute('aria-expanded', 'false');
      }
      b.textContent = text;
      b.title = title;
      return b;
    }

    function oldBox(k, status) {
      const box = doc.createElement('div');
      box.className = 'diff-old diff-old-' + status;
      const html = oldBody(result.olds[k].html);
      box.innerHTML = '<div class="diff-old-body">' + (opts.resolveOld ? opts.resolveOld(html) : html) + '</div>';
      return box;
    }

    function clear() {
      for (const el of Array.from(root.querySelectorAll('.diff-old'))) el.remove();
      for (const el of Array.from(root.querySelectorAll('.diff-tag'))) el.remove();
      for (const el of Array.from(root.querySelectorAll('ins.diff-ins'))) el.replaceWith(doc.createTextNode(el.textContent));
      for (const el of Array.from(root.querySelectorAll('.diff-math-ins'))) el.classList.remove('diff-math-ins');
      for (const el of Array.from(root.querySelectorAll('.diff-changed, .diff-added, .diff-moved, .diff-current'))) {
        el.classList.remove('diff-changed', 'diff-added', 'diff-moved', 'diff-current');
      }
      root.normalize();
      marks = [];
    }

    function apply(next) {
      if (next) result = next;
      clear();
      if (!result) return;
      const blocks = new Map();
      for (const el of root.querySelectorAll('.src-block[data-s]')) blocks.set(Number(el.dataset.s), el);
      const ctx = { section: '', result: '' };
      let lastEl = null; // where the next removed block goes: after this
      const firstBlock = root.querySelector('.src-block[data-s]');
      for (const it of result.items) {
        const el = it.b != null ? blocks.get(result.news[it.b].s) : null;
        if (it.b != null && !el) continue; // inside the editor, or not shown
        if (el) {
          const h = el.querySelector('h1 .secnum, h2 .secnum, h3 .secnum, h4 .secnum');
          if (h) ctx.section = h.textContent.trim();
        }
        if (it.status === 'same') {
          lastEl = el;
          const thm = el.querySelector('.thm-name');
          if (thm) ctx.result = thm.textContent.trim();
          continue;
        }
        if (it.status === 'removed') {
          const box = oldBox(it.a, 'removed');
          const name = nameOf(box, ctx);
          box.prepend(tag(`Removed in ${labels.new}: ${name}`, `In ${labels.old} only. Click to show or hide it.`, true));
          if (lastEl) lastEl.after(box);
          else if (firstBlock) firstBlock.before(box);
          else root.appendChild(box);
          lastEl = box;
          marks.push({ el: box, name: name + ' (removed)', status: 'removed' });
          continue;
        }
        const name = nameOf(el, ctx);
        const thm = el.querySelector('.thm-name');
        if (thm) ctx.result = thm.textContent.trim();
        if (it.status === 'added') {
          el.classList.add('diff-added');
          el.prepend(tag(`New in ${labels.new}`, `Not in ${labels.old}`));
          marks.push({ el, name: name + ' (new)', status: 'added' });
        } else {
          const changed = it.sim < 1;
          el.classList.add(it.status === 'moved' ? 'diff-moved' : 'diff-changed');
          if (changed) {
            const box = oldBox(it.a, 'changed');
            box.hidden = true;
            const ta = tokensOf(box);
            const tb = tokensOf(el);
            const d = wordDiff(ta.map((x) => x.t), tb.map((x) => x.t));
            markTokens(ta, d.a, 'del');
            markTokens(tb, d.b, 'ins');
            el.after(box);
            lastEl = box;
          } else lastEl = el;
          const what = it.status === 'moved' ? (changed ? 'Moved and changed' : 'Moved') : 'Changed';
          el.prepend(changed
            ? tag(`${what} · show ${labels.old}`, `Show or hide this block as it was in ${labels.old}`, true)
            : tag(what, `In another place in ${labels.old}`));
          marks.push({ el, name: name + (it.status === 'moved' ? ' (moved)' : ' (changed)'), status: it.status });
          continue;
        }
        lastEl = el;
      }
      current = -1;
      fill();
    }

    function fill() {
      const c = { changed: 0, added: 0, removed: 0, moved: 0 };
      for (const m of marks) c[m.status]++;
      const parts = [];
      if (c.changed) parts.push(`<span class="diff-n diff-n-changed">${c.changed} changed</span>`);
      if (c.added) parts.push(`<span class="diff-n diff-n-added">${c.added} new</span>`);
      if (c.removed) parts.push(`<span class="diff-n diff-n-removed">${c.removed} removed</span>`);
      if (c.moved) parts.push(`<span class="diff-n diff-n-moved">${c.moved} moved</span>`);
      $('.diff-counts').innerHTML = parts.length ? parts.join(' · ') : 'No changes';
      const list = $('.diff-list');
      list.innerHTML = `<option value="-1">${marks.length ? `${marks.length} change${marks.length > 1 ? 's' : ''}…` : 'No changes'}</option>` +
        marks.map((m, k) => `<option value="${k}">${esc(m.name)}</option>`).join('');
      list.disabled = !marks.length;
      $('.diff-prev').disabled = $('.diff-next').disabled = !marks.length;
      showStep();
    }

    function showStep() {
      $('.diff-step').textContent = marks.length ? `${current >= 0 ? current + 1 : '–'} / ${marks.length}` : '';
      $('.diff-list').value = String(current);
    }

    function go(k) {
      if (k < 0 || k >= marks.length) return;
      const prevEl = marks[current] && marks[current].el;
      if (prevEl) prevEl.classList.remove('diff-current');
      current = k;
      const el = marks[k].el;
      el.classList.add('diff-current');
      if (el.classList.contains('diff-old') && !el.classList.contains('diff-open')) {
        el.classList.add('diff-open');
        const t = el.querySelector('.diff-tag');
        if (t) t.setAttribute('aria-expanded', 'true');
      }
      if (opts.jump) opts.jump(el);
      else el.scrollIntoView({ block: 'center' });
      showStep();
    }

    /** The next (dir 1) or previous (dir −1) change from the one shown, or from where the reader is. */
    function step(dir) {
      if (!marks.length) return;
      if (current < 0) {
        // start from the first change below the top of the window (or the last above it)
        const top = 80;
        let k = marks.findIndex((m) => m.el.getBoundingClientRect().top > top);
        if (k < 0) k = dir > 0 ? 0 : marks.length - 1;
        else if (dir < 0) k = Math.max(0, k - 1);
        go(k);
        return;
      }
      go((current + dir + marks.length) % marks.length);
    }

    function destroy() {
      clear();
      root.classList.remove('diff-only-changes');
      root.removeEventListener('click', onClick);
      bar.remove();
    }

    if (result) apply();
    return {
      apply, clear, destroy, next: () => step(1), prev: () => step(-1),
      get counts() { const c = { changed: 0, added: 0, removed: 0, moved: 0 }; for (const m of marks) c[m.status]++; return c; },
      get marks() { return marks.slice(); },
      bar,
    };
  }

  return { normalize, keyOf, unitsOf, similarity, compare, compareRenders, wordDiff, view, nameOf, oldBody, BLOCK_HEAD };
});
