/*
 * Step through a proof, one piece at a time, in the web viewer, the browser
 * extension's viewer and the VS Code preview.
 *
 * A "Step through" button by each proof's heading shows the proof as a slide
 * reveal: one sentence, displayed equation or list item at a time. → (or
 * Space, or a tap on the proof) shows the next piece, ← goes back, Escape or
 * "Show all" ends it. The rendered proof is not split ahead of time: its
 * paragraphs are cut into sentences only while it is being stepped through,
 * and put back together after.
 *
 * Nested parts (a claim with its own proof, a proof inside the proof, a
 * "Case 1." / "Step 2." paragraph and what follows it, a long list item)
 * open while you step through them and fold into their first line once you
 * have stepped past them, with a button to open them again.
 *
 * Each reference or citation in a piece gets a small "why?" chip: it opens
 * the referenced result (or bibliography entry) in the host's usual preview,
 * a popover or, on a touch screen, a bottom sheet, without leaving your place.
 *
 *   const steps = TeXglassSteps.attach({
 *     root: preview,                // the rendered document
 *     preview(link, chip) { ... },  // show the preview of a reference link
 *     closePreview() { ... },       // hide it
 *     reveal(proof) { ... },        // optional: unfold a folded proof
 *     previewOpen() { ... },        // optional: whether a preview shows (Esc closes it first)
 *     dismissPreview() { ... },     // optional: close any preview, on Esc
 *     enabled: true,
 *   });
 *   steps.refresh();                // after a render (buttons; keeps stepping)
 *   steps.setEnabled(on);
 *   steps.start(proofEl); steps.next(); steps.back(); steps.stop();
 *   steps.active();                 // the proof being stepped through, or null
 *
 * The pure parts (sentence ends, nested-part headers) are exported for tests:
 *   TeXglassSteps.sentenceEnds(text, more), TeXglassSteps.partHeader(text)
 *
 * An author can choose the pieces: texglass.sty's \tgstep[title] renders as an
 * empty <span class="tg-stepmark" data-tg-step="title">. A proof holding any
 * such mark is cut only at the marks (and between paragraphs, displays and
 * list items), never at guessed sentence ends.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassSteps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Text: where sentences end, and which paragraphs open a nested part
  // ---------------------------------------------------------------------------

  // Words that end with a full stop without ending the sentence.
  const ABBR = new Set(['e.g', 'i.e', 'cf', 'resp', 'viz', 'vs', 'etc', 'al', 'ibid', 'thm', 'lem', 'prop', 'cor', 'def',
    'rem', 'eq', 'eqs', 'sec', 'secs', 'fig', 'figs', 'ch', 'chap', 'no', 'nos', 'p', 'pp', 'ex', 'ref', 'refs', 'approx',
    'w.r.t', 'a.e', 'a.s', 'i.i.d', 'esp', 'incl', 'vol', 'thms', 'lems', 'props', 'defs', 'sect',
    'art', 'part', 'eqn', 'eqns', 'assm', 'hyp', 'obs', 'conj', 'alg', 'app', 'appx']);

  /**
   * Where sentences end in a run of text: the offsets just after the space
   * that follows each sentence's last character. `more` says whether more of
   * the paragraph follows (an element such as a link or a formula): a full
   * stop at the very end then ends a sentence only if `more` starts with a
   * capital (`more` is the following text, or '' when unknown).
   */
  function sentenceEnds(text, more) {
    const out = [];
    const re = /([.!?])(["'”’)\]]*)(\s+)/g;
    let m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      const after = text.slice(end);
      if (after) {
        // the next sentence starts with a capital, an opening bracket or quote, or a digit
        if (!/^["'“‘(\[]?[A-Z0-9]/.test(after)) continue;
      } else if (more === undefined || !/^\s*["'“‘(\[]?[A-Z]/.test(more)) {
        continue;
      }
      if (m[1] === '.') {
        const before = text.slice(0, m.index);
        const word = (before.match(/(\S+)$/) || ['', ''])[1].replace(/^[("'“‘\[]+/, '');
        const w = word.toLowerCase();
        if (!word && m.index > 0) continue; // (at 0 the sentence ended with an element, such as a formula)
        if (ABBR.has(w) || ABBR.has(w.replace(/\.$/, ''))) continue;
        if (/^[A-Za-z]$/.test(word)) continue; // an initial ("J. Smith") or "Lemma A."
        if (/^\d+$/.test(word) && /(?:^|\s)(Step|Case|Part|Subcase)\s*$/i.test(before.slice(0, -word.length))) continue;
      }
      out.push(end);
    }
    return out;
  }

  // "Case 1.", "Step 2:", "Part (ii).", "Claim.", "First case:", "Proof of (a)."
  const PART_RE = /^\s*(?:(case|step|part|claim|stage|subcase)\b\s*(?:\(?[0-9ivxlcdmIVXLCDM]+[a-z]?\)?|[a-zA-Z]\b|\(?[a-z]\))?\s*(?:[.:)]|$)|(?:(?:first|second|third|fourth|last|final|general|base|inductive|induction)\s+(case|step|part))\b|(proof of)\b)/i;

  /** The kind of nested part a paragraph's opening words start ("case", "step", ...), or ''. */
  function partHeader(text) {
    const m = PART_RE.exec(String(text || ''));
    if (!m) return '';
    return ((m[1] || m[2] || m[3] || '').toLowerCase()).replace('subcase', 'case').replace('stage', 'step');
  }

  // A paragraph that follows the last case and closes the argument, so it is not part of that case.
  const CLOSING_RE = /^\s*(?:hence|thus|therefore|this (?:ends|completes|proves|shows|concludes)|in (?:all|both|each|either|any) cases?|combining|altogether|so in|finally|consequently|it follows|we conclude|putting)/i;

  // ---------------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------------

  // Leading parts of a paragraph that are never a sentence of their own.
  const HEADISH = '.proof-head, .thm-head, .item-label, .fold-toggle, .rp-marks, .uses-btn, .tg-step-btn, .thm-name';
  const NOT_TEXT = '.katex-mathml, script, style';
  const INTERACTIVE = 'a, button, input, textarea, select, label, summary, .math, .katex, .tg-margin, .marginnote, .tg-step-bar, [contenteditable]';
  const INSIDE_POPOVER = '.ref-popover, .insight-popover, .insight-dialog, .cited-box, .tg-margin, .uses-bar, .pick-bar, .diff-old';
  const MIN_STEPS = 3; // fewer pieces than this: no button
  const FOLD_MIN = 3; // a nested part folds when it has at least this many pieces

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** The proof's own direct children that are content (not the stepping bar). */
  const blocksOf = (el) => Array.from(el.children).filter((c) => !c.classList.contains('tg-step-bar') && !c.matches('script, style'));

  /** Opening text of a block, without its heading, for nested-part headers. */
  function openingText(el) {
    let s = '';
    const walk = (n) => {
      if (s.length > 60) return;
      if (n.nodeType === 3) { s += n.nodeValue; return; }
      if (n.nodeType !== 1 || n.matches(NOT_TEXT) || n.matches('.fold-toggle, .rp-marks, .uses-btn, .tg-step-btn, .proof-head')) return;
      n.childNodes.forEach(walk);
    };
    walk(el);
    return s.trim();
  }

  /** A quick count of the pieces a proof would be cut into, without changing it. */
  function countPieces(proof) {
    let n = 0;
    const walk = (el) => {
      for (const b of blocksOf(el)) {
        if (b.tagName === 'P') {
          const t = b.textContent.replace(/\s+/g, ' ');
          n += 1 + sentenceEnds(t, '').length;
        } else if (b.matches('ul, ol')) {
          b.querySelectorAll(':scope > li').forEach((li) => { n += 1; });
        } else if (b.matches('.proof, .theorem')) {
          walk(b);
        } else n += 1;
        if (n >= MIN_STEPS) return;
      }
    };
    walk(proof);
    return n;
  }

  function attach(opts) {
    const rootEl = opts.root;
    const doc = rootEl.ownerDocument;
    const win = doc.defaultView;
    let enabled = opts.enabled !== false;
    let state = null; // { proof, key, steps, groups, boxes, at, bar, made: [...] }
    let idle = null;

    // --- the buttons by each proof ------------------------------------------------

    function proofKey(proof) {
      return proof.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    function topProofs() {
      // Proofs inside another proof are stepped through with it.
      return Array.from(rootEl.querySelectorAll('.proof')).filter((p) => !p.parentElement.closest('.proof') && !p.closest(INSIDE_POPOVER));
    }

    function addButtons() {
      for (const proof of topProofs()) {
        const head = proof.querySelector(':scope > p:first-child > .proof-head');
        if (!head) continue;
        const p = head.parentElement;
        let btn = p.querySelector(':scope > .tg-step-btn');
        if (proof._tgCount === undefined) proof._tgCount = countPieces(proof);
        if (proof._tgCount < MIN_STEPS) { if (btn) btn.remove(); continue; }
        if (!btn) {
          btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'tg-step-btn';
          btn.title = 'Step through this proof one piece at a time (→ next, ← back, Esc to stop)';
          btn.setAttribute('aria-label', 'Step through this proof');
          btn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2.2v7.6L9.4 6z" fill="currentColor"/></svg><span>Step through</span>';
          // after the heading and the markers the other tools put there
          let at = head;
          while (at.nextSibling && at.nextSibling.nodeType === 1 && at.nextSibling.matches('.rp-marks, .uses-btn')) at = at.nextSibling;
          at.after(btn);
        }
      }
    }

    function removeButtons() {
      rootEl.querySelectorAll('.tg-step-btn').forEach((b) => b.remove());
    }

    function refresh() {
      if (idle) (win.cancelIdleCallback || win.clearTimeout)(idle);
      const run = () => {
        idle = null;
        if (state && !rootEl.contains(state.proof)) {
          // Rendered again (an edit, a reload): carry on in the same proof if it is still there.
          const { key, at, nth } = state;
          state = null;
          if (enabled) {
            // the same proof by its text, else (it was edited) the proof in the same place
            const all = topProofs();
            const again = all.find((p) => proofKey(p) === key) || all[nth];
            if (again) start(again);
            if (state) go(Math.min(at, state.steps.length - 1));
          }
        } else if (state && state.proof.classList.contains('folded')) stop();
        if (enabled) addButtons();
      };
      idle = win.requestIdleCallback ? win.requestIdleCallback(run, { timeout: 800 }) : win.setTimeout(run, 50);
    }

    function setEnabled(on) {
      enabled = !!on;
      if (!enabled) { stop(); removeButtons(); } else refresh();
    }

    // --- cutting the proof into pieces ---------------------------------------------

    /** Wrap the sentences of paragraph `p` in spans; returns the spans. */
    function splitParagraph(p, made, byMarks) {
      const nodes = Array.from(p.childNodes);
      let i = 0;
      // leading heading, markers and blank text stay outside the sentences
      while (i < nodes.length) {
        const n = nodes[i];
        if (n.nodeType === 3 && !n.nodeValue.trim()) { i++; continue; }
        if (n.nodeType === 1 && n.matches(HEADISH)) { i++; continue; }
        break;
      }
      const rest = nodes.slice(i);
      if (!rest.length) return [];
      const sentences = [];
      let cur = [];
      const flush = () => {
        if (!cur.length) return;
        if (cur.every((n) => n.nodeType === 3 && !n.nodeValue.trim())) { cur = []; return; }
        sentences.push(cur);
        cur = [];
      };
      for (let k = 0; k < rest.length; k++) {
        const n = rest[k];
        // an author's step mark (\tgstep in texglass.sty) starts a piece; no guessing at sentences then
        if (n.nodeType === 1 && n.matches('.tg-stepmark')) { flush(); cur.push(n); continue; }
        if (n.nodeType !== 3 || byMarks) { cur.push(n); continue; }
        // what follows this text node, to judge a full stop at its very end
        let more = '';
        for (let j = k + 1; j < rest.length && more.length < 4; j++) {
          const m = rest[j];
          if (m.nodeType === 1 && m.matches('.math, .katex, sup.fn, .tg-margin, .marginnote')) { more = more || 'x'; break; }
          more += m.textContent;
        }
        let text = n.nodeValue;
        let node = n;
        const ends = sentenceEnds(text, more);
        let done = 0;
        for (const e of ends) {
          const tail = node.splitText(e - done);
          cur.push(node);
          flush();
          node = tail;
          done = e;
        }
        if (node.nodeValue) cur.push(node);
      }
      flush();
      return sentences.map((group) => {
        const span = doc.createElement('span');
        span.className = 'tg-step tg-step-text';
        group[0].before(span);
        group.forEach((n) => span.appendChild(n));
        made.spans.push(span);
        return span;
      });
    }

    function build(proof) {
      const made = { spans: [], chips: [], toggles: [] };
      const steps = []; // { el, group }
      const groups = []; // { head, from, to, el(s), kind, open: null|bool, toggle }

      // The author marked the steps: break at those marks only (and between blocks).
      const byMarks = !!proof.querySelector('.tg-stepmark');
      const add = (el, group) => { el.classList.add('tg-step'); steps.push({ el, group }); return steps.length - 1; };

      /** Pieces of one block; returns [first, last] step indices, or null. */
      function blockSteps(b, group) {
        const from = steps.length;
        if (b.tagName === 'P') {
          const spans = splitParagraph(b, made, byMarks);
          if (!spans.length) add(b, group);
          else spans.forEach((s) => add(s, group));
        } else if (b.matches('ul, ol')) {
          const items = Array.from(b.children).filter((li) => li.tagName === 'LI');
          if (!items.length) add(b, group);
          for (const li of items) {
            const body = li.querySelector(':scope > .item-body');
            const inner = body ? blocksOf(body) : [];
            if (inner.length > 1 || (inner.length === 1 && inner[0].tagName === 'P' && countSentences(inner[0]) >= FOLD_MIN)) {
              nested(li, inner, group, 'item');
            } else add(li, group);
          }
        } else if (b.matches('.proof')) {
          nested(b, blocksOf(b), group, 'proof');
        } else if (b.matches('.theorem')) {
          const inner = blocksOf(b);
          if (inner.length > 1 || (inner[0] && inner[0].tagName === 'P' && countSentences(inner[0]) >= FOLD_MIN)) nested(b, inner, group, 'theorem');
          else add(b, group);
        } else {
          add(b, group);
        }
        return steps.length > from ? [from, steps.length - 1] : null;
      }

      const countSentences = (p) => 1 + sentenceEnds(p.textContent.replace(/\s+/g, ' '), '').length;

      /** A nested part made of `blocks` (inside `box`): its pieces, folded once stepped past. */
      function nested(box, blocks, parent, kind, extra) {
        const g = { box, kind, parent, from: steps.length, to: -1, open: null, members: [] };
        groups.push(g);
        seq(blocks, g);
        if (extra) seq(extra, g);
        g.to = steps.length - 1;
        if (g.to - g.from + 1 < FOLD_MIN) {
          // too short to fold: its pieces belong to the parent
          groups.splice(groups.indexOf(g), 1);
          for (let k = g.from; k <= g.to; k++) if (steps[k].group === g) steps[k].group = parent;
          groups.forEach((h) => { if (h.parent === g) h.parent = parent; });
          return;
        }
      }

      /** Pieces of a run of sibling blocks, finding "Case 1." paragraphs and claims with proofs. */
      function seq(blocks, group, inPart) {
        for (let k = 0; k < blocks.length; k++) {
          const b = blocks[k];
          // a claim (theorem-like block) followed by its proof: one nested part
          if (b.matches('.theorem') && blocks[k + 1] && blocks[k + 1].matches('.proof')) {
            const g = { box: b, kind: 'claim', parent: group, from: steps.length, to: -1, open: null };
            groups.push(g);
            const first = steps.length;
            add(b, g); // the statement, whole, is the part's first line
            seq(blocksOf(blocks[k + 1]), g); // its proof's pieces belong to the same part
            g.to = steps.length - 1;
            if (g.to - first + 1 < FOLD_MIN) dissolve(g);
            k++;
            continue;
          }
          const kind = b.tagName === 'P' && !(inPart && k === 0) ? partHeader(openingText(b)) : '';
          if (kind && kind !== 'proof of') {
            // "Case 1." and what follows it, up to the next part of the same kind
            let e = k + 1;
            const isLast = !blocks.slice(k + 1).some((d) => d.tagName === 'P' && partHeader(openingText(d)) === kind);
            while (e < blocks.length) {
              const c = blocks[e];
              if (c.tagName === 'P' && partHeader(openingText(c)) === kind) break;
              // the last part ends where the argument visibly moves on: a closing
              // sentence ("Hence ...", "In both cases ..."), or a new claim
              if (isLast && c.tagName === 'P' && CLOSING_RE.test(openingText(c))) break;
              if (isLast && c.matches('.theorem, .proof')) break;
              e++;
            }
            const g = { box: b, kind, parent: group, from: steps.length, to: -1, open: null };
            groups.push(g);
            seq(blocks.slice(k, e), g, true);
            g.to = steps.length - 1;
            if (g.to - g.from + 1 < FOLD_MIN) dissolve(g);
            k = e - 1;
            continue;
          }
          blockSteps(b, group);
        }
      }

      function dissolve(g) {
        groups.splice(groups.indexOf(g), 1);
        for (let k = g.from; k <= g.to; k++) if (steps[k].group === g) steps[k].group = g.parent;
        groups.forEach((h) => { if (h.parent === g) h.parent = g.parent; });
      }

      seq(blocksOf(proof), null);

      // Boxes: elements that hold pieces (paragraphs, lists, items, nested proofs),
      // hidden while none of their pieces shows.
      const boxes = new Map();
      steps.forEach((s, i) => {
        for (let el = s.el.parentElement; el && el !== proof; el = el.parentElement) {
          const r = boxes.get(el);
          if (r) r.push(i); else boxes.set(el, [i]);
        }
      });

      // A toggle on each nested part's first line.
      for (const g of groups) {
        const t = doc.createElement('button');
        t.type = 'button';
        t.className = 'tg-step-fold';
        t._tgGroup = g;
        g.toggle = t;
        const head = steps[g.from].el;
        if (head.classList.contains('tg-step-text')) head.after(t);
        else {
          const p = head.matches('p') ? head : head.querySelector('p');
          if (p) p.appendChild(t); else head.after(t);
        }
        made.toggles.push(t);
      }

      // "why?" chips after references and citations.
      steps.forEach((s) => {
        const links = s.el.matches('a.ref, .cite') ? [s.el] : Array.from(s.el.querySelectorAll('a.ref, .cite'));
        for (const l of links) {
          if (l.closest('.math, .katex, .ref-popover, .tg-step-bar')) continue;
          if (l.matches('.cite') && l.parentElement.closest('.cite')) continue;
          const a = l.matches('a') ? l : l.querySelector('a[href^="#"]');
          if (!a || !/^#/.test(a.getAttribute('href') || '')) continue;
          const target = doc.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
          if (!target || proof.contains(target) && !target.matches('.math-display, .theorem')) continue;
          const chip = doc.createElement('button');
          chip.type = 'button';
          chip.className = 'tg-why';
          chip.textContent = 'why?';
          chip.title = 'Show what this refers to, without leaving the proof';
          chip.setAttribute('aria-label', 'Show ' + (a.textContent.trim() || 'the reference') + ' here');
          chip._tgLink = a;
          l.after(chip);
          made.chips.push(chip);
        }
      });

      return { steps, groups, boxes, made };
    }

    function unbuild(st) {
      const { made, proof } = st;
      made.chips.forEach((c) => c.remove());
      made.toggles.forEach((t) => t.remove());
      const parents = new Set();
      made.spans.forEach((s) => {
        if (!s.parentNode) return;
        parents.add(s.parentNode);
        while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s);
        s.remove();
      });
      parents.forEach((p) => p.normalize());
      proof.querySelectorAll('.tg-step, .tg-step-hidden, .tg-step-now, .tg-step-box, .tg-step-folded, .tg-step-past').forEach((el) => {
        el.classList.remove('tg-step', 'tg-step-text', 'tg-step-hidden', 'tg-step-now', 'tg-step-box', 'tg-step-folded', 'tg-step-past');
        if (!el.classList.length) el.removeAttribute('class');
      });
      if (st.bar) st.bar.remove();
      proof.classList.remove('tg-stepping');
    }

    // --- showing the pieces up to the current one ------------------------------------

    /** Whether nested part `g` shows only its first line now. */
    function folded(g, at) {
      if (g.open !== null) return !g.open;
      return at > g.to; // stepped past it
    }

    function paint() {
      const { steps, groups, boxes, at, proof } = state;
      const shown = steps.map((s, i) => i <= at);
      // pieces of a folded part, except its first line, are hidden
      const isFolded = new Map();
      for (const g of groups) {
        const f = folded(g, at) && at >= g.from;
        isFolded.set(g, f);
        if (f) for (let k = g.from + 1; k <= g.to; k++) shown[k] = false;
      }
      for (const g of groups) {
        const f = isFolded.get(g);
        steps[g.from].el.classList.toggle('tg-step-folded', f);
        const t = g.toggle;
        const n = g.to - g.from;
        // shown once you are past the part's first line, while that line shows
        t.hidden = !shown[g.from] || (!f && at === g.from);
        t.textContent = f ? `▸ ${n} more` : '▾ fold';
        t.title = f ? 'Open this part again' : 'Fold this part to its first line';
        t.setAttribute('aria-expanded', String(!f));
      }
      steps.forEach((s, i) => {
        s.el.classList.toggle('tg-step-hidden', !shown[i]);
        s.el.classList.toggle('tg-step-now', i === at);
      });
      boxes.forEach((idx, el) => {
        el.classList.add('tg-step-box');
        el.classList.toggle('tg-step-hidden', !idx.some((i) => shown[i]));
      });
      const bar = state.bar;
      bar.querySelector('[data-step="count"]').textContent = `${at + 1} / ${steps.length}`;
      bar.querySelector('[data-step="back"]').disabled = at === 0;
      const next = bar.querySelector('[data-step="next"]');
      const last = at >= steps.length - 1;
      next.innerHTML = last ? 'Done' : 'Next <span aria-hidden="true">›</span>';
      next.title = last ? 'The end of the proof: show it all again (Esc)' : 'Show the next piece (→ or Space)';
      proof.classList.toggle('tg-stepping-end', last);
    }

    function scrollToNow() {
      const el = state && state.steps[state.at] && state.steps[state.at].el;
      if (!el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      const barH = state.bar ? state.bar.getBoundingClientRect().height + 16 : 60;
      const vh = win.innerHeight || doc.documentElement.clientHeight;
      if (r.bottom > vh - barH || r.top < 60) {
        try { el.scrollIntoView({ block: r.height > vh / 2 ? 'start' : 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
      }
    }

    function makeBar() {
      const bar = doc.createElement('div');
      bar.className = 'tg-step-bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Stepping through the proof');
      bar.innerHTML =
        '<button type="button" data-step="back" title="Back one piece (←)"><span aria-hidden="true">‹</span> Back</button>' +
        '<span class="tg-step-count" data-step="count" aria-live="polite"></span>' +
        '<button type="button" data-step="next" class="tg-step-next"></button>' +
        '<button type="button" data-step="all" title="Stop stepping and show the whole proof (Esc)">Show all</button>';
      return bar;
    }

    // --- moving --------------------------------------------------------------------

    function start(proof) {
      if (!proof || !enabled) return;
      if (state) stop();
      if (opts.reveal && proof.classList.contains('folded')) opts.reveal(proof);
      const key = proofKey(proof);
      const built = build(proof);
      if (!built.steps.length) { unbuild(Object.assign({ proof }, built)); return; }
      state = Object.assign({ proof, key, at: 0, nth: topProofs().indexOf(proof) }, built);
      state.bar = makeBar();
      proof.appendChild(state.bar);
      proof.classList.add('tg-stepping');
      paint();
      scrollToNow();
    }

    function go(i) {
      if (!state) return;
      const n = state.steps.length;
      const at = Math.max(0, Math.min(n - 1, i));
      if (opts.closePreview) opts.closePreview();
      // a part folded by hand opens again when you step into it
      for (const g of state.groups) if (at >= g.from && at <= g.to && g.open === false) g.open = null;
      state.at = at;
      paint();
      scrollToNow();
    }

    function next() {
      if (!state) return;
      if (state.at >= state.steps.length - 1) { stop(); return; }
      // skip pieces hidden in a part folded by hand
      let i = state.at + 1;
      for (const g of state.groups) if (g.open === false && i > g.from && i <= g.to) i = g.to + 1;
      if (i >= state.steps.length) { stop(); return; }
      go(i);
    }

    function back() {
      if (!state) return;
      go(state.at - 1);
    }

    function stop() {
      if (!state) return;
      const st = state;
      state = null;
      if (opts.closePreview) opts.closePreview();
      unbuild(st);
    }

    // --- events ----------------------------------------------------------------------

    rootEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.tg-step-btn');
      if (btn && rootEl.contains(btn)) {
        e.preventDefault();
        e.stopPropagation();
        const proof = btn.closest('.proof');
        if (state && state.proof === proof) stop(); else start(proof);
        return;
      }
      if (!state || !state.proof.contains(e.target)) return;
      // the proof's own fold arrow: folding it ends the stepping
      const ft = e.target.closest('.fold-toggle');
      if (ft && ft.closest('.proof') === state.proof) { stop(); return; }
      const act = e.target.closest('[data-step]');
      if (act && state.bar.contains(act)) {
        e.preventDefault();
        e.stopPropagation();
        const a = act.dataset.step;
        if (a === 'next') next();
        else if (a === 'back') back();
        else if (a === 'all') stop();
        return;
      }
      const why = e.target.closest('.tg-why');
      if (why) {
        e.preventDefault();
        e.stopPropagation();
        if (opts.preview) opts.preview(why._tgLink, why);
        return;
      }
      const fold = e.target.closest('.tg-step-fold');
      if (fold) {
        e.preventDefault();
        e.stopPropagation();
        const g = fold._tgGroup;
        const isFolded = folded(g, state.at) && state.at >= g.from;
        g.open = isFolded;
        // folding the part you are in moves you to its first line
        if (!g.open && state.at > g.from && state.at <= g.to) state.at = g.from;
        paint();
        return;
      }
      // a tap or click on the proof's text shows the next piece
      if (e.target.closest(INTERACTIVE)) return;
      const sel = win.getSelection && win.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim()) return;
      e.preventDefault();
      e.stopPropagation();
      next();
    }, true);

    win.addEventListener('keydown', (e) => {
      if (!state || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor, dialog[open]')) return;
      if (t && t !== doc.body && t.closest && t.closest('button') && !state.proof.contains(t) && (e.key === ' ' || e.key === 'Enter')) return;
      let handled = true;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) next();
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) back();
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(state.steps.length - 1);
      else if (e.key === 'Escape') {
        if (opts.previewOpen && opts.previewOpen()) (opts.dismissPreview || opts.closePreview || (() => {}))();
        else stop();
      } else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    if (enabled) refresh();

    return {
      refresh,
      setEnabled,
      start,
      stop,
      next,
      back,
      go,
      active: () => (state ? state.proof : null),
      at: () => (state ? state.at : -1),
      count: () => (state ? state.steps.length : 0),
    };
  }

  return { attach, sentenceEnds, partHeader, countPieces };
});
