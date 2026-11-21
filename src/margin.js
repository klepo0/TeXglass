/*
 * The margin column of the preview, in the web viewer and the VS Code preview.
 *
 * It holds two kinds of notes side by side:
 *
 *  - the author's: \marginpar, \marginnote and \todo. The converter leaves them
 *    in the text as <span class="mnote"> (src/texglass.js); here they are
 *    lifted into the margin, level with the line they were written on.
 *  - the reader's (study tools): highlights and notes made on the preview. A
 *    selection gets a small bar to highlight it or write a note on it, and a
 *    note pad at the bottom right (movable by its handle) can be dragged onto any line. Notes in the
 *    margin can be dragged to another line too.
 *
 * Reader notes never touch the .tex: they are anchored by the text they mark
 * (the quote, with some text before and after it) and the source line it was
 * on. After an edit the quote is looked for again in the rendered text, and
 * the line only decides between equal matches, so notes stay put while the
 * document changes around them. The host stores them (VS Code: in a sidecar
 * file next to the .tex, paper.texglass.json).
 *
 *   const margin = TeXglassMargin.attach({
 *     pane, doc,                       // the scrolling pane and the document in it
 *     blocks: () => [{ el, line, file }], // top-level blocks and their source lines
 *     files: () => ['main.tex', ...],  // names of the source files, by number
 *     save(list) {},                   // the reader's notes changed
 *     renderNote(text) -> Promise<html>, // optional: LaTeX in notes
 *     study: true,                     // the study tools are on
 *     width: 220,                      // optional: the margin's width in px, as dragged before
 *     onWidth(px) {},                  // its divider was dragged (null: back to automatic)
 *     collapsed: false,                // optional: start with the margin folded away
 *     onCollapse(folded) {},           // its fold button was used
 *     filter: 'all', onFilter(kind) {}, // optional: which notes N jumps between, and when it changes
 *     keys: true,                      // N / Shift+N jump to the next / previous note
 *     padAt: { right, bottom },        // optional: where the note pad was moved to (px from the corner)
 *     onPadMove(at) {},                // the note pad was moved by its handle (null: back to the corner)
 *   });
 *   margin.refresh();                  // after the document was rendered again
 *   margin.setAnnotations(list); margin.setStudy(on);
 *   margin.setCollapsed(on);           // fold the margin away, or bring it back
 *   margin.setPadAt(at);               // put the note pad where it was moved to before
 *   margin.next(); margin.previous();  // jump to the next or previous note (N, Shift+N)
 *   margin.setFilter('todo');          // jump between these only: 'all', 'par', 'todo' or 'mine'
 *   margin.setOverlay(on);             // a phone: the margin is a drawer over the text, closed at first
 *
 * Handwritten notes: with the study tools on, a pen (Apple Pencil, a stylus)
 * writes in the margin column; a finger still scrolls, and a mouse still
 * selects. The first touch of a pen opens the margin column even when there is
 * no note yet. Strokes written one soon after another make one note, anchored
 * to the line beside where it starts, and kept as one SVG path (`ink`:
 * { w, h, d }) with the reader's other notes, so it syncs like them.
 *
 * The anchoring functions (describe, locate) work on plain strings and are
 * exported for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassMargin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONTEXT = 32; // characters of text kept before and after a quote
  const COLORS = ['yellow', 'green', 'pink', 'blue'];
  const GAP = 6; // between cards in the margin
  const FOLD_AT = 70; // the margin's divider dragged narrower than this (px) folds it away

  // ---------------------------------------------------------------------------
  // Anchoring in plain text
  // ---------------------------------------------------------------------------

  /** The anchor for text[start, end): the quote and its surroundings. */
  function describe(text, start, end) {
    return {
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT), start),
      suffix: text.slice(end, end + CONTEXT),
    };
  }

  function commonTail(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  function commonHead(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  function occurrences(text, s, limit) {
    const out = [];
    if (!s) return out;
    for (let i = text.indexOf(s); i >= 0 && out.length < limit; i = text.indexOf(s, i + 1)) out.push(i);
    return out;
  }

  /**
   * Find an anchor in `text`. `hint` is where it is expected (an offset in
   * text, from its source line), or null. Returns { start, end, exact } or
   * null. A point (empty quote) is found by the text around it.
   */
  function locate(text, anchor, hint) {
    const quote = anchor.quote || '';
    const prefix = anchor.prefix || '';
    const suffix = anchor.suffix || '';
    const score = (s, e) => {
      const before = commonTail(text.slice(Math.max(0, s - prefix.length), s), prefix);
      const after = commonHead(text.slice(e, e + suffix.length), suffix);
      // Context decides; the source line only breaks ties (and near-ties).
      const far = hint == null ? 0 : Math.min(8, Math.abs(s - hint) / 4000);
      return before + after - far;
    };
    const best = (cands) => {
      let top = null;
      for (const c of cands) {
        const v = score(c.start, c.end);
        if (!top || v > top.v) top = Object.assign({ v }, c);
      }
      return top ? { start: top.start, end: top.end, exact: top.exact } : null;
    };
    if (quote) {
      const at = occurrences(text, quote, 500);
      if (at.length) return best(at.map((s) => ({ start: s, end: s + quote.length, exact: true })));
      // The quote was edited: find its first and last words, close together.
      const k = Math.min(16, Math.floor(quote.length / 3));
      if (k >= 4) {
        const head = quote.slice(0, k);
        const tail = quote.slice(-k);
        const cands = [];
        for (const s of occurrences(text, head, 200)) {
          const e = text.indexOf(tail, s + k);
          if (e >= 0 && e + k - s <= quote.length * 1.5 + 8) cands.push({ start: s, end: e + k, exact: false });
        }
        if (cands.length) return best(cands);
      }
      // Fall back to the text around it.
      const around = locate(text, { quote: '', prefix, suffix }, hint);
      return around ? { start: around.start, end: around.start, exact: false } : null;
    }
    const both = occurrences(text, prefix + suffix, 500);
    if (both.length && (prefix || suffix)) {
      return best(both.map((s) => ({ start: s + prefix.length, end: s + prefix.length, exact: true })));
    }
    const p = prefix.length >= 8 ? occurrences(text, prefix, 200).map((s) => ({ start: s + prefix.length, end: s + prefix.length, exact: false })) : [];
    const q = suffix.length >= 8 ? occurrences(text, suffix, 200).map((s) => ({ start: s, end: s, exact: false })) : [];
    return best(p.concat(q));
  }

  // ---------------------------------------------------------------------------
  // The document's text, with whitespace collapsed, and back to DOM positions
  // ---------------------------------------------------------------------------

  // Not part of the reading text: MathML copies of formulas, buttons, notes.
  const SKIP = '.katex-mathml, .fold-toggle, .mnote, .sync-mark, .tg-margin, script, style, textarea';
  const BLOCKISH = 'p, li, h1, h2, h3, h4, h5, h6, div, figcaption, td, th, dd, dt, blockquote, pre, figure, .math-display, .katex-display';
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === ' ';

  function buildIndex(doc) {
    const parts = [];
    const nodes = []; // { node, start, end, ws, top }
    let length = 0;
    let ws = true;
    let lastBlock = null;
    const tops = new Map(); // top-level element of doc -> offset of its first text
    const walker = doc.ownerDocument.createTreeWalker(doc, 4 /* SHOW_TEXT */, {
      acceptNode(n) {
        const p = n.parentElement;
        return p && !p.closest(SKIP) ? 1 : 2;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = n.parentElement.closest(BLOCKISH);
      if (block !== lastBlock && !ws) {
        parts.push(' ');
        length++;
        ws = true;
      }
      lastBlock = block;
      let top = n.parentElement;
      while (top && top.parentElement !== doc) top = top.parentElement;
      if (top && !tops.has(top)) tops.set(top, length);
      const start = length;
      const before = ws;
      const d = n.data;
      let out = '';
      for (let i = 0; i < d.length; i++) {
        const c = d[i];
        if (isSpace(c)) {
          if (!ws) { out += ' '; ws = true; }
        } else {
          out += c;
          ws = false;
        }
      }
      parts.push(out);
      length += out.length;
      nodes.push({ node: n, start, end: length, ws: before, top });
    }
    return { text: parts.join(''), nodes, tops };
  }

  /** The DOM position of offset `i` in the index. */
  function toDom(index, i, preferEnd) {
    const nodes = index.nodes;
    if (!nodes.length) return null;
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].start < i || (!preferEnd && nodes[mid].start === i)) lo = mid;
      else hi = mid - 1;
    }
    let n = nodes[lo];
    if (preferEnd && n.end < i && lo + 1 < nodes.length) n = nodes[lo + 1];
    if (i < n.start) return { node: n.node, offset: 0 };
    const k = i - n.start;
    const d = n.node.data;
    let count = 0;
    let ws = n.ws;
    for (let j = 0; j < d.length; j++) {
      if (count >= k) return { node: n.node, offset: j };
      if (isSpace(d[j])) {
        if (!ws) { count++; ws = true; }
      } else {
        count++;
        ws = false;
      }
    }
    return { node: n.node, offset: d.length };
  }

  /** The offset in the index of a DOM position (container, offset). */
  function fromDom(index, container, offset) {
    const nodes = index.nodes;
    if (!nodes.length) return 0;
    const own = container.nodeType === 3 ? nodes.findIndex((n) => n.node === container) : -1;
    if (own >= 0) {
      const n = nodes[own];
      const d = container.data;
      let count = 0;
      let ws = n.ws;
      for (let j = 0; j < Math.min(offset, d.length); j++) {
        if (isSpace(d[j])) {
          if (!ws) { count++; ws = true; }
        } else {
          count++;
          ws = false;
        }
      }
      return n.start + count;
    }
    // Elsewhere (an element, or text that is not indexed): the first indexed
    // text at or after it.
    const r = container.ownerDocument.createRange();
    r.setStart(container, offset);
    r.collapse(true);
    let lo = 0;
    let hi = nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.comparePoint(nodes[mid].node, 0) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= nodes.length) return index.text.length;
    return nodes[lo].start;
  }

  // ---------------------------------------------------------------------------
  // The margin
  // ---------------------------------------------------------------------------

  const ICONS = {
    note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v7l-3.5 4H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 13.5v-4H13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.5 5.5h5M5.5 8h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.6L10.5 3.5l2 2-6.9 6.9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  };

  const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const plainHtml = (t) => escapeHtml(t).replace(/\n/g, '<br>');
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** Pen strokes ([[x, y, x, y, …], …], in px) as one compact SVG path: absolute moves, relative lines. */
  function inkPath(strokes) {
    let d = '';
    for (const st of strokes) {
      if (st.length < 2) continue;
      let px = Math.round(st[0]);
      let py = Math.round(st[1]);
      d += `M${px} ${py}`;
      let line = '';
      for (let k = 2; k < st.length; k += 2) {
        const x = Math.round(st[k]);
        const y = Math.round(st[k + 1]);
        if (x === px && y === py) continue;
        line += ` ${x - px} ${y - py}`;
        px = x;
        py = y;
      }
      d += line ? 'l' + line.trim() : 'l0 0'; // a dot is a line of length 0, drawn by the round cap
    }
    return d.replace(/ -/g, '-');
  }

  /** A stored handwritten note as SVG, or '' when it is not a well-formed one (notes come from files and gists). */
  function inkSvg(ink) {
    if (!ink || typeof ink.d !== 'string' || !/^[Ml0-9 .-]*$/.test(ink.d) || ink.d.length > 200000) return '';
    const w = Math.max(1, Math.min(4000, Number(ink.w) || 0));
    const h = Math.max(1, Math.min(8000, Number(ink.h) || 0));
    return `<svg class="tg-ink" viewBox="0 0 ${w} ${h}" style="max-width:${w}px" role="img" aria-label="Handwritten note"><path d="${ink.d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function attach(opts) {
    const { pane, doc } = opts;
    const page = doc.ownerDocument;
    const win = page.defaultView;
    const blocksOf = opts.blocks || (() => []);
    const filesOf = opts.files || (() => []);
    let study = !!opts.study;
    let list = []; // the reader's annotations, as stored
    let index = null; // text index of the document, until it changes
    let placed = new Map(); // annotation id -> { start, end, exact } where it is now
    const noteHtml = new Map(); // note text -> rendered HTML
    let editing = null; // id of the note being edited
    let penSeen = false; // a pen has touched the page: the margin column shows, to write in (below)
    let inkLive = null; // { svg, path, strokes, timer } while a pen writes in the margin

    const layer = page.createElement('aside');
    layer.className = 'tg-margin document';
    layer.setAttribute('aria-label', 'Margin notes');
    pane.appendChild(layer);

    // The divider between the text and the margin: drag it to widen or narrow
    // the margin, arrow keys too; a double-click goes back to the automatic width.
    let userW = opts.width > 0 ? opts.width : null;
    const grip = page.createElement('div');
    grip.className = 'tg-margin-grip';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', 'Resize the margin');
    grip.tabIndex = 0;
    grip.title = 'Drag to resize the margin, or right to fold it away · double-click to reset';
    layer.appendChild(grip);
    const maxW = () => Math.max(160, Math.round(pane.clientWidth * 0.5));
    const setUserW = (w, save) => {
      userW = w == null ? null : Math.round(Math.min(maxW(), Math.max(110, w)));
      layout();
      if (save && opts.onWidth) opts.onWidth(userW);
    };
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const width = marginW;
      const before = userW;
      page.body.classList.add('tg-margin-resizing');
      // Dragged narrower than the narrowest margin, it folds away; back out, it opens again.
      const move = (ev) => {
        const want = width + start - ev.clientX;
        if (want < FOLD_AT) {
          if (!collapsed) { collapsed = true; layout(); }
          return;
        }
        collapsed = false;
        setUserW(want, false);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        grip.removeEventListener('lostpointercapture', up);
        if (!page.body.classList.contains('tg-margin-resizing')) return;
        page.body.classList.remove('tg-margin-resizing');
        if (collapsed) {
          userW = before; // opened again, it has the width it had
          setCollapsed(true, true, true);
        } else {
          setUserW(marginW, true);
        }
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
      grip.addEventListener('lostpointercapture', up, { once: true });
    });
    grip.addEventListener('dblclick', () => setUserW(null, true));
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setUserW(marginW + (e.key === 'ArrowLeft' ? 20 : -20), true);
    });

    // The fold button: it hides the margin, and the text takes the room back. The
    // notes stay marked in the text (a dot); clicking one brings the margin back.
    let collapsed = !!opts.collapsed;
    // On a phone (setOverlay) the margin is a drawer over the text: closed at first,
    // opened by its button, a note's dot or a swipe, and closed again by a tap
    // outside it. Its open or closed state there is not remembered.
    let overlay = false;
    let wideCollapsed = collapsed; // the reader's choice for wider windows, kept while overlaid
    const toggle = page.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tg-margin-toggle';
    const setCollapsed = (on, save, force) => {
      on = !!on;
      if (overlay) save = false;
      const was = collapsed;
      collapsed = on;
      layout();
      if (save && (force || was !== on) && opts.onCollapse) opts.onCollapse(on);
    };
    // Folded, the button is a handle too: drag it left to pull the margin out.
    let dragged = false;
    toggle.addEventListener('pointerdown', (e) => {
      dragged = false;
      if (!collapsed || e.button !== 0) return;
      toggle.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const move = (ev) => {
        const want = start - ev.clientX;
        if (!dragged && Math.abs(want) < 6) return;
        dragged = true;
        page.body.classList.add('tg-margin-resizing');
        if (want < FOLD_AT) {
          if (!collapsed) { collapsed = true; layout(); }
          return;
        }
        collapsed = false;
        setUserW(want, false);
      };
      const up = () => {
        toggle.removeEventListener('pointermove', move);
        toggle.removeEventListener('pointerup', up);
        toggle.removeEventListener('pointercancel', up);
        page.body.classList.remove('tg-margin-resizing');
        if (!dragged) return;
        if (collapsed) {
          layout();
        } else {
          setUserW(marginW, true);
          if (opts.onCollapse) opts.onCollapse(false);
        }
      };
      toggle.addEventListener('pointermove', move);
      toggle.addEventListener('pointerup', up);
      toggle.addEventListener('pointercancel', up);
    });
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      if (dragged) { dragged = false; return; }
      setCollapsed(!collapsed, true);
    });
    doc.addEventListener('click', (e) => {
      if (!collapsed || !e.target.closest || !e.target.closest('.mnote')) return;
      setCollapsed(false, true);
    });
    // The button stays in view while the document scrolls.
    let scrollFrame = 0;
    pane.addEventListener('scroll', () => {
      if (!scrollFrame) scrollFrame = win.requestAnimationFrame(() => { scrollFrame = 0; placeToggle(); });
    }, { passive: true });

    const highlights = win.CSS && win.CSS.highlights && typeof win.Highlight === 'function' ? win.CSS.highlights : null;

    // --- the index, and annotations placed in it ----------------------------------

    function getIndex() {
      if (!index) index = buildIndex(doc);
      return index;
    }

    /** Where in the text the anchor's source line starts (for hints). Lines are counted from 1. */
    function hintFor(anchor) {
      const files = filesOf();
      const file = Math.max(0, anchor.file ? files.indexOf(anchor.file) : 0);
      const line = (anchor.line || 1) - 1;
      let best = null;
      for (const b of blocksOf()) {
        if ((b.file || 0) !== file) continue;
        if (b.line <= line || !best) best = b;
        if (b.line > line) break;
      }
      if (!best) return null;
      const t = getIndex().tops.get(best.el);
      return t == null ? null : t;
    }

    /** The source file and line of the block holding offset i. */
    function sourceAt(i) {
      const ix = getIndex();
      const at = toDom(ix, i);
      if (!at) return { file: filesOf()[0] || '', line: 1 };
      const blocks = blocksOf();
      const b = blocks.find((x) => x.el.contains(at.node));
      const files = filesOf();
      return b ? { file: files[b.file || 0] || '', line: b.line + 1 } : { file: files[0] || '', line: 1 };
    }

    function place() {
      placed = new Map();
      if (!list.length) return;
      const ix = getIndex();
      for (const a of list) {
        const at = locate(ix.text, a.anchor || {}, hintFor(a.anchor || {}));
        if (at) placed.set(a.id, at);
      }
    }

    function rangeOf(start, end) {
      const ix = getIndex();
      const s = toDom(ix, start);
      const e = end === start ? s : toDom(ix, end, true);
      if (!s || !e) return null;
      const r = page.createRange();
      try {
        r.setStart(s.node, s.offset);
        r.setEnd(e.node, e.offset);
      } catch (err) {
        return null;
      }
      return r;
    }

    function paintHighlights() {
      if (!highlights) return;
      for (const c of COLORS) highlights.delete('tg-hl-' + c);
      if (!study) return;
      const by = {};
      for (const a of list) {
        const at = placed.get(a.id);
        if (!a.color || !at || at.end <= at.start) continue;
        const r = rangeOf(at.start, at.end);
        if (r) (by[a.color] = by[a.color] || []).push(r);
      }
      for (const c of Object.keys(by)) highlights.set('tg-hl-' + (COLORS.includes(c) ? c : 'yellow'), new win.Highlight(...by[c]));
    }

    function flash(a) {
      if (!highlights) return;
      highlights.delete('tg-hl-focus');
      const at = a && placed.get(a.id);
      if (!at) return;
      let { start, end } = at;
      if (end <= start) {
        // A note on a point: light up the word there.
        const text = getIndex().text;
        end = start;
        while (end < text.length && end - start < 24 && !isSpace(text[end])) end++;
        while (start > 0 && at.start - start < 24 && !isSpace(text[start - 1])) start--;
      }
      const r = rangeOf(start, end);
      if (r) highlights.set('tg-hl-focus', new win.Highlight(r));
    }

    // --- cards in the margin ------------------------------------------------------------

    let cards = []; // { el, top(): number | null }

    function texCards() {
      return Array.from(doc.querySelectorAll('.mnote')).map((m) => {
        const el = page.createElement('div');
        el.className = 'tg-mcard tg-mcard-tex ' + (m.classList.contains('mnote-todo') ? 'tg-mcard-todo' : 'tg-mcard-par');
        const c = m.style.getPropertyValue('--note-c');
        if (c) el.style.setProperty('--note-c', c);
        const body = m.querySelector('.mnote-body');
        el.innerHTML = body ? body.innerHTML : '';
        return { el, src: m, top: () => rectTop(m.getClientRects()[0]) };
      });
    }

    function noteBody(a) {
      const ink = inkSvg(a.ink);
      if (ink) return ink + ((a.note || '').trim() ? `<div class="tg-ink-text">${noteText(a)}</div>` : '');
      return noteText(a);
    }
    function noteText(a) {
      const text = a.note || '';
      if (!text.trim()) return '<span class="tg-mcard-empty">Empty note</span>';
      if (noteHtml.has(text)) return noteHtml.get(text);
      if (opts.renderNote && /[$\\]/.test(text)) {
        noteHtml.set(text, plainHtml(text));
        Promise.resolve(opts.renderNote(text)).then((html) => {
          if (typeof html === 'string') {
            noteHtml.set(text, html);
            build();
          }
        }, () => {});
        return plainHtml(text);
      }
      const html = plainHtml(text);
      noteHtml.set(text, html);
      return html;
    }

    function readerCards() {
      if (!study) return [];
      const out = [];
      for (const a of list) {
        const at = placed.get(a.id);
        const hasNote = typeof a.note === 'string';
        const lost = !at || (a.anchor && a.anchor.quote && at.end <= at.start);
        if (!hasNote && !lost) continue; // a highlight alone has no card
        const el = page.createElement('div');
        el.className = 'tg-mcard tg-mcard-user' + (lost ? ' tg-mcard-lost' : '');
        el.dataset.id = a.id;
        el.style.setProperty('--note-c', `var(--tg-hl-${COLORS.includes(a.color) ? a.color : 'yellow'})`);
        el.title = 'Drag to another line';
        el.innerHTML = `${lost ? '<div class="tg-mcard-tag">Text not found</div>' : ''}<span class="tg-mcard-tools">${hasNote ? `<button type="button" class="tg-mcard-edit" aria-label="Edit note" title="Edit">${ICONS.edit}</button>` : ''}<button type="button" class="tg-mcard-del" aria-label="Delete" title="Delete">${ICONS.trash}</button></span>` +
          `<div class="tg-mcard-body">${lost && !hasNote ? `Highlight: “${escapeHtml((a.anchor.quote || '').slice(0, 80))}”` : noteBody(a)}</div>`;
        const top = () => {
          const p = placed.get(a.id);
          if (p) {
            const r = rangeOf(p.start, p.start);
            if (r) return rectTop(firstRect(r));
          }
          // Not found: by its source line.
          const h = hintFor(a.anchor || {});
          if (h == null) return null;
          const r = rangeOf(h, h);
          return r ? rectTop(firstRect(r)) : null;
        };
        out.push({ el, top, id: a.id });
      }
      return out;
    }

    function firstRect(r) {
      const rects = r.getClientRects();
      if (rects.length) return rects[0];
      const n = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
      return n && n.getClientRects().length ? n.getBoundingClientRect() : null;
    }

    function rectTop(rect) {
      if (!rect || (!rect.width && !rect.height && !rect.top && !rect.left)) return null;
      return rect.top - pane.getBoundingClientRect().top + pane.scrollTop;
    }

    /** Make the cards again (the document or the notes changed). */
    function build() {
      if (editing) return; // not under the reader's typing; done when they finish
      layer.replaceChildren();
      cards = texCards().concat(readerCards());
      for (const c of cards) layer.appendChild(c.el);
      layer.appendChild(grip);
      layer.appendChild(toggle);
      layer.appendChild(nav);
      layer.appendChild(navMenu);
      if (inkLive) layer.appendChild(inkLive.svg);
      cards.forEach((c) => ro && ro.observe(c.el));
      layout();
    }

    let frame = 0;
    function layoutSoon() {
      if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; layout(); });
    }

    let marginW = 0;
    function placeToggle() {
      if (layer.hidden) return;
      const top = Math.max(0, Math.min(pane.scrollTop + 10, doc.offsetHeight - 80));
      toggle.style.top = top + 'px';
      nav.style.top = top + 24 + 'px';
      navMenu.style.top = top + 24 + 'px';
    }

    function layout() {
      const on = cards.length > 0 || (penSeen && study) || !!inkLive;
      doc.classList.toggle('tg-with-margin', on);
      doc.classList.toggle('tg-margin-collapsed', on && collapsed);
      doc.classList.toggle('tg-margin-overlay', on && overlay);
      layer.classList.toggle('tg-margin-folded', collapsed);
      layer.classList.toggle('tg-margin-drawer', overlay && !collapsed);
      layer.classList.toggle('tg-drawer-open', overlay && !collapsed);
      layer.style.height = '';
      layer.hidden = !on;
      if (!on) return;
      const n = cards.length;
      const what = n === 1 ? '1 margin note' : n + ' margin notes';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.title = collapsed ? 'Show the margin (' + what + ')' : 'Hide the margin';
      toggle.setAttribute('aria-label', toggle.title);
      updateNav();
      toggle.innerHTML = collapsed
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="tg-margin-count">' + n + '</span>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      if (collapsed) {
        // A strip at the right of the text, for the button only.
        const cs = win.getComputedStyle(doc);
        layer.style.left = doc.offsetLeft + doc.offsetWidth - parseFloat(cs.paddingRight) + 6 + 'px';
        layer.style.width = '0px';
        placeToggle();
        return;
      }
      const zoom = (parseFloat(win.getComputedStyle(doc).fontSize) || 18) / 18;
      const w = overlay
        ? Math.round(Math.min(320, pane.clientWidth * 0.8))
        : userW != null
          ? Math.min(userW, maxW())
          : Math.round(Math.min(240 * zoom, Math.max(130, pane.clientWidth * 0.26)));
      if (w !== marginW) {
        marginW = w;
        if (!overlay) doc.style.setProperty('--tg-margin-w', w + 'px');
      }
      const cs = win.getComputedStyle(doc);
      if (overlay) {
        // over the right of the text, the whole height of the document
        layer.style.left = pane.clientWidth - w + 'px';
        layer.style.height = Math.max(doc.offsetHeight, pane.clientHeight) + 'px';
      } else {
        layer.style.left = doc.offsetLeft + doc.offsetWidth - parseFloat(cs.paddingRight) + 20 + 'px';
      }
      layer.style.width = w + 'px';
      grip.style.height = doc.offsetHeight + 'px';
      grip.setAttribute('aria-valuenow', String(w));
      placeToggle();
      const want = cards.map((c) => ({ c, y: c.top() }));
      want.sort((a, b) => (a.y == null) - (b.y == null) || a.y - b.y);
      let bottom = -Infinity;
      for (const { c, y } of want) {
        c.el.hidden = y == null;
        if (y == null) continue;
        const top = Math.max(y, bottom + GAP);
        c.el.style.top = top + 'px';
        bottom = top + c.el.offsetHeight;
      }
    }

    const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(layoutSoon) : null;
    if (ro) {
      ro.observe(doc);
      ro.observe(pane);
    } else {
      win.addEventListener('resize', layoutSoon);
    }

    // --- jumping from note to note ---------------------------------------------------------
    //
    // Two arrows under the fold button (and N, Shift+N) go to the next or the
    // previous note, in the order of the text: the author's \marginpar and \todo
    // notes and the reader's own notes and highlights. A menu (or the filter
    // button) narrows the jumps to one kind; the other cards fade meanwhile.

    const KINDS = [
      { id: 'all', label: 'All notes' },
      { id: 'par', label: 'Margin notes' },
      { id: 'todo', label: 'Todo notes' },
      { id: 'mine', label: 'My notes and highlights' },
    ];
    let filter = KINDS.some((k) => k.id === opts.filter) ? opts.filter : 'all';
    let current = null; // { key, scroll }: the note jumped to last, and where the pane was then
    let pulseTimer = 0;
    const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const nav = page.createElement('div');
    nav.className = 'tg-margin-nav';
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', 'Jump between notes');
    nav.innerHTML =
      `<button type="button" class="tg-mnav-prev">${svg('M3.5 10 8 5.5l4.5 4.5')}</button>` +
      `<button type="button" class="tg-mnav-next">${svg('M3.5 6 8 10.5 12.5 6')}</button>` +
      `<button type="button" class="tg-mnav-filter" aria-haspopup="menu" aria-expanded="false">${svg('M2.5 4h11M4.5 8h7M6.5 12h3')}</button>`;
    const navMenu = page.createElement('div');
    navMenu.className = 'tg-mnav-menu';
    navMenu.setAttribute('role', 'menu');
    navMenu.setAttribute('aria-label', 'Jump between');
    navMenu.hidden = true;
    const prevBtn = nav.querySelector('.tg-mnav-prev');
    const nextBtn = nav.querySelector('.tg-mnav-next');
    const filterBtn = nav.querySelector('.tg-mnav-filter');
    // Clicks here are not clicks on the text below.
    nav.addEventListener('pointerdown', (e) => e.stopPropagation());
    navMenu.addEventListener('pointerdown', (e) => e.stopPropagation());
    prevBtn.addEventListener('click', (e) => { e.preventDefault(); go(-1); });
    nextBtn.addEventListener('click', (e) => { e.preventDefault(); go(1); });
    filterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showMenu(navMenu.hidden);
    });
    navMenu.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-kind]');
      if (!b) return;
      setFilter(b.dataset.kind, true);
      showMenu(false);
      filterBtn.focus();
    });
    navMenu.addEventListener('keydown', (e) => {
      const items = Array.from(navMenu.querySelectorAll('[data-kind]'));
      const i = items.indexOf(page.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        showMenu(false);
        filterBtn.focus();
      } else if (e.key === 'Tab') {
        showMenu(false);
      }
    });
    page.addEventListener('pointerdown', () => { if (!navMenu.hidden) showMenu(false); });

    /** The kind of each note there is, in the order of the text: { kind, key, range, card }. */
    function targets() {
      const out = [];
      doc.querySelectorAll('.mnote').forEach((m) => {
        const r = page.createRange();
        r.setStartBefore(m);
        r.collapse(true);
        out.push({ kind: m.classList.contains('mnote-todo') ? 'todo' : 'par', key: m, mnote: m, range: r });
      });
      if (study) {
        for (const a of list) {
          const at = placed.get(a.id);
          if (!at) continue;
          const r = rangeOf(at.start, at.end);
          if (r) out.push({ kind: 'mine', key: a.id, note: a, range: r });
        }
      }
      out.sort((x, y) => x.range.compareBoundaryPoints(win.Range.START_TO_START, y.range));
      return out;
    }

    /** Where a note is, in the pane's scrolled coordinates; its block's top if it is not laid out. */
    function rectOf(t) {
      let rect = t.mnote ? t.mnote.getClientRects()[0] : firstRect(t.range);
      if (!rect || (!rect.width && !rect.height && !rect.top && !rect.left)) {
        let n = t.range.startContainer;
        if (n.nodeType !== 1) n = n.parentElement;
        while (n && n.parentElement && n.parentElement !== doc) n = n.parentElement;
        rect = n && n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      }
      return rect;
    }

    const matches = (t) => filter === 'all' || t.kind === filter;

    function counts(all) {
      const c = { all: all.length, par: 0, todo: 0, mine: 0 };
      for (const t of all) c[t.kind]++;
      return c;
    }

    function updateNav() {
      const c = counts(targets());
      if (filter !== 'all' && !c[filter]) filter = 'all';
      const kinds = KINDS.filter((k) => k.id !== 'all' && c[k.id]).length;
      layer.dataset.filter = filter;
      const what = filter === 'all' ? 'note' : { par: 'margin note', todo: 'todo note', mine: 'note of yours' }[filter];
      prevBtn.title = `Previous ${what} (Shift+N)`;
      nextBtn.title = `Next ${what} (N)`;
      prevBtn.setAttribute('aria-label', prevBtn.title);
      nextBtn.setAttribute('aria-label', nextBtn.title);
      prevBtn.disabled = nextBtn.disabled = !c[filter];
      // Only one kind of note: nothing to choose between.
      filterBtn.hidden = kinds < 2 && filter === 'all';
      const label = KINDS.find((k) => k.id === filter).label;
      filterBtn.title = `Jump between: ${label.toLowerCase()}`;
      filterBtn.setAttribute('aria-label', filterBtn.title);
      filterBtn.classList.toggle('tg-mnav-on', filter !== 'all');
      navMenu.innerHTML = KINDS.filter((k) => k.id === 'all' || c[k.id]).map((k) =>
        `<button type="button" role="menuitemradio" aria-checked="${k.id === filter}" data-kind="${k.id}"><span>${k.label}</span><span class="tg-mnav-n">${c[k.id]}</span></button>`).join('');
    }

    function showMenu(on) {
      navMenu.hidden = !on;
      filterBtn.setAttribute('aria-expanded', String(on));
      if (on) {
        updateNav();
        const sel = navMenu.querySelector('[aria-checked="true"]') || navMenu.querySelector('button');
        if (sel) sel.focus();
      }
    }

    function setFilter(kind, save) {
      if (!KINDS.some((k) => k.id === kind)) kind = 'all';
      filter = kind;
      current = null;
      updateNav();
      if (save && opts.onFilter) opts.onFilter(filter);
    }

    /** Jump to the next (dir 1) or the previous (dir -1) note of the kind chosen. Returns the note, or null. */
    function go(dir) {
      if (layer.hidden) return null;
      const all = targets().filter(matches);
      if (!all.length) return null;
      let i = -1;
      const at = current && (current.scroll == null || Math.abs(pane.scrollTop - current.scroll) < 4)
        ? all.findIndex((t) => t.key === current.key) : -1;
      if (at >= 0) {
        i = at + dir;
      } else {
        // From the middle of the pane, where a jump puts a note.
        const p = pane.getBoundingClientRect();
        const mid = p.top + pane.clientHeight / 2;
        const ys = all.map((t) => { const r = rectOf(t); return r ? r.top + r.height / 2 : null; });
        if (dir > 0) i = ys.findIndex((y) => y != null && y > mid + 8);
        else for (let k = ys.length - 1; k >= 0; k--) if (ys[k] != null && ys[k] < mid - 8) { i = k; break; }
        if (i < 0) i = dir > 0 ? all.length : -1;
      }
      // Past the last note, around to the first (and back).
      i = (i + all.length) % all.length;
      const t = all[i];
      current = { key: t.key, scroll: null };
      const done = () => { if (current && current.key === t.key) current.scroll = pane.scrollTop; };
      const target = { getBoundingClientRect: () => rectOf(t) || { top: 0, height: 0 } };
      if (win.TeXglassScroll) win.TeXglassScroll.to(pane, target, { align: 'center', smooth: true, done });
      else {
        const r = target.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        pane.scrollTop += r.top + r.height / 2 - (p.top + pane.clientHeight / 2);
        done();
      }
      pulse(t);
      return { kind: t.kind, index: i, count: all.length };
    }

    /** Light up the note jumped to: its card, and its place in the text. */
    function pulse(t) {
      win.clearTimeout(pulseTimer);
      layer.querySelectorAll('.tg-mcard-pulse').forEach((el) => el.classList.remove('tg-mcard-pulse'));
      doc.querySelectorAll('.tg-mnote-pulse').forEach((el) => el.classList.remove('tg-mnote-pulse'));
      const card = cards.find((c) => (t.mnote ? c.src === t.mnote : c.id === t.key));
      if (card) {
        void card.el.offsetWidth; // start the animation again
        card.el.classList.add('tg-mcard-pulse');
      }
      if (t.mnote) t.mnote.classList.add('tg-mnote-pulse');
      if (t.note) flash(t.note);
      pulseTimer = win.setTimeout(() => {
        layer.querySelectorAll('.tg-mcard-pulse').forEach((el) => el.classList.remove('tg-mcard-pulse'));
        doc.querySelectorAll('.tg-mnote-pulse').forEach((el) => el.classList.remove('tg-mnote-pulse'));
        if (t.note && highlights) highlights.delete('tg-hl-focus');
      }, 1600);
    }

    // N and Shift+N, outside text fields and dialogs.
    const typing = (el) => !!el && (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) ||
      (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(el.type)));
    if (opts.keys !== false) {
      page.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'n' && e.key !== 'N')) return;
        if (typing(e.target) || page.querySelector('dialog[open]') || layer.hidden) return;
        if (!go(e.shiftKey ? -1 : 1)) return;
        e.preventDefault();
      });
    }

    // --- changing annotations -----------------------------------------------------------

    function changed() {
      place();
      paintHighlights();
      build();
      if (opts.save) opts.save(list.map((a) => Object.assign({}, a)));
    }

    function anchorFor(start, end) {
      const ix = getIndex();
      const src = sourceAt(start);
      return Object.assign({ file: src.file, line: src.line }, describe(ix.text, start, end));
    }

    function add(start, end, fields) {
      const a = Object.assign({ id: newId(), anchor: anchorFor(start, end), created: new Date().toISOString() }, fields);
      list.push(a);
      return a;
    }

    const byId = (id) => list.find((a) => a.id === id);

    function remove(id) {
      list = list.filter((a) => a.id !== id);
      changed();
    }

    // --- the selection bar ----------------------------------------------------------------

    const bar = page.createElement('div');
    bar.className = 'tg-hlbar';
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Highlight');
    bar.innerHTML = COLORS.map((c) => `<button type="button" class="tg-swatch" data-color="${c}" style="--sw: var(--tg-hl-${c})" aria-label="Highlight ${c}" title="Highlight ${c}"></button>`).join('') +
      `<button type="button" class="tg-hlbar-note" aria-label="Add a note" title="Add a note">${ICONS.note}</button>` +
      `<button type="button" class="tg-hlbar-del" aria-label="Remove highlight" title="Remove highlight">${ICONS.trash}</button>`;
    pane.appendChild(bar);
    let barFor = null; // { start, end } of a selection, or { id } of a highlight

    // The system's own menu for a selection (copy, look up, share on phones and
    // tablets; Edge's mini menu on a computer) opens above the selected text, with
    // drag handles under it on a touch screen. So the bar goes below the selection,
    // past the handles on a touch screen, and above it only when there is no room
    // below, then far enough up to clear that menu.
    const BAR_GAP = 8;
    const BAR_GAP_TOUCH = 36; // under the selection handles
    const NATIVE_MENU = 56; // room the system's menu takes above a selection
    let lastPointer = 'mouse';
    const touchy = () => lastPointer === 'touch' || lastPointer === 'pen' ||
      !!(win.matchMedia && win.matchMedia('(hover: none) and (pointer: coarse)').matches);

    /** The bar's top (in the window) for a selection at `rect`: below it, else above. */
    function barTop(rect, h, viewTop, viewBottom, touch) {
      const below = rect.bottom + (touch ? BAR_GAP_TOUCH : BAR_GAP);
      if (below + h <= viewBottom - 4) return below;
      const above = rect.top - h - (touch ? NATIVE_MENU + BAR_GAP : BAR_GAP);
      if (above >= viewTop + 4) return above;
      // a selection taller than the window: the bottom edge of what is in view
      return Math.max(viewTop + 4, viewBottom - h - 4);
    }

    function showBar(rect, target) {
      barFor = target;
      bar.classList.toggle('tg-hlbar-existing', !!target.id);
      bar.hidden = false;
      const p = pane.getBoundingClientRect();
      const w = bar.offsetWidth;
      const left = Math.max(4, Math.min(rect.left + rect.width / 2 - w / 2 - p.left + pane.scrollLeft, pane.clientWidth - w - 4));
      const vv = win.visualViewport;
      const viewTop = Math.max(p.top, vv ? vv.offsetTop : 0);
      const viewBottom = Math.min(p.bottom, vv ? vv.offsetTop + vv.height : win.innerHeight);
      const top = barTop(rect, bar.offsetHeight, viewTop, viewBottom, touchy());
      bar.style.left = left + 'px';
      bar.style.top = top - p.top + pane.scrollTop + 'px';
    }
    function hideBar() {
      bar.hidden = true;
      barFor = null;
    }

    function selectionInDoc() {
      const sel = win.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!doc.contains(r.commonAncestorContainer)) return null;
      const ix = getIndex();
      let start = fromDom(ix, r.startContainer, r.startOffset);
      let end = fromDom(ix, r.endContainer, r.endOffset);
      while (start < end && isSpace(ix.text[start])) start++;
      while (end > start && isSpace(ix.text[end - 1])) end--;
      if (end <= start) return null;
      return { start, end, rect: r.getBoundingClientRect() };
    }

    function onPointerUp(e) {
      if (e.pointerType) lastPointer = e.pointerType;
      if (!study || e.button !== 0 || bar.contains(e.target)) return;
      setTimeout(() => {
        const s = selectionInDoc();
        if (s) {
          showBar(s.rect, { start: s.start, end: s.end });
          return;
        }
        if (e.target.closest && e.target.closest('a, button, .fold-toggle')) return hideBar();
        // A click on a highlight: change its colour, add a note or remove it.
        const i = offsetAtPoint(e.clientX, e.clientY, false);
        const hit = i == null ? null : list.find((a) => {
          const at = placed.get(a.id);
          return a.color && at && at.start <= i && i < at.end;
        });
        if (hit) {
          const at = placed.get(hit.id);
          const r = rangeOf(at.start, at.end);
          showBar(r ? r.getBoundingClientRect() : { left: e.clientX, top: e.clientY, width: 0, bottom: e.clientY }, { id: hit.id });
        } else {
          hideBar();
        }
      }, 0);
    }
    doc.addEventListener('pointerup', onPointerUp);
    doc.addEventListener('pointerdown', (e) => { if (e.pointerType) lastPointer = e.pointerType; });
    page.addEventListener('keyup', (e) => {
      if (!study || !e.shiftKey) return;
      const s = selectionInDoc();
      if (s) showBar(s.rect, { start: s.start, end: s.end });
    });
    // A long press selects text on a touch screen without a pointerup the page
    // sees, and the handles change it afterwards: show the bar once it settles.
    let settle = null;
    page.addEventListener('selectionchange', () => {
      const s = selectionInDoc();
      if (barFor && !barFor.id && !s) hideBar();
      clearTimeout(settle);
      if (!study || !s || !touchy()) return;
      settle = setTimeout(() => {
        const now = selectionInDoc();
        if (now) showBar(now.rect, { start: now.start, end: now.end });
      }, 350);
    });
    page.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !bar.hidden) hideBar();
    });
    // Keep the selection while the bar is clicked.
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !barFor) return;
      const target = barFor;
      let a = target.id ? byId(target.id) : null;
      if (b.dataset.color) {
        if (a) a.color = b.dataset.color;
        else a = add(target.start, target.end, { color: b.dataset.color });
        win.getSelection().removeAllRanges();
        hideBar();
        changed();
      } else if (b.classList.contains('tg-hlbar-note')) {
        if (!a) a = add(target.start, target.end, { color: 'yellow' });
        if (typeof a.note !== 'string') a.note = '';
        win.getSelection().removeAllRanges();
        hideBar();
        changed();
        edit(a.id, true);
      } else if (b.classList.contains('tg-hlbar-del') && a) {
        hideBar();
        remove(a.id);
      }
    });

    // --- where a point on screen is in the text ---------------------------------------------

    function caretAt(x, y) {
      if (page.caretPositionFromPoint) {
        const p = page.caretPositionFromPoint(x, y);
        return p ? { node: p.offsetNode, offset: p.offset } : null;
      }
      if (page.caretRangeFromPoint) {
        const r = page.caretRangeFromPoint(x, y);
        return r ? { node: r.startContainer, offset: r.startOffset } : null;
      }
      return null;
    }

    /** The start of the word at offset i (a note on a point goes before a word, not inside it). */
    function wordStart(i) {
      if (i == null) return i;
      const text = getIndex().text;
      let j = i;
      while (j > 0 && i - j < 40 && !isSpace(text[j - 1])) j--;
      return j > 0 && !isSpace(text[j - 1]) ? i : j;
    }

    /** The text offset at a point; with clamp, a point in the margin counts as the end of that line. */
    function offsetAtPoint(x, y, clamp) {
      if (clamp) {
        const r = doc.getBoundingClientRect();
        const cs = win.getComputedStyle(doc);
        const left = r.left + parseFloat(cs.paddingLeft) + 2;
        const right = r.right - parseFloat(cs.paddingRight) - 2;
        x = Math.max(left, Math.min(right, x));
      }
      const c = caretAt(x, y);
      if (!c || !doc.contains(c.node)) {
        if (!clamp) return null;
        // Between paragraphs: the block at that height.
        const el = page.elementFromPoint(x, y);
        const block = el && el.closest && el.closest('.src-block');
        if (!block || !doc.contains(block)) return null;
        const t = getIndex().tops.get(block);
        return t == null ? null : t;
      }
      return fromDom(getIndex(), c.node, c.offset);
    }

    // --- editing a note ----------------------------------------------------------------

    function edit(id, fresh) {
      const card = layer.querySelector(`.tg-mcard-user[data-id="${id}"]`);
      const a = byId(id);
      if (!card || !a) return;
      if (collapsed) setCollapsed(false, true);
      editing = id;
      const body = card.querySelector('.tg-mcard-body');
      const ta = page.createElement('textarea');
      ta.className = 'tg-mcard-input';
      ta.value = a.note || '';
      ta.placeholder = a.ink ? 'Add words to it… ($…$ for maths)' : 'Write a note… ($…$ for maths)';
      ta.rows = 2;
      body.replaceChildren(ta);
      const ink = inkSvg(a.ink);
      if (ink) ta.insertAdjacentHTML('beforebegin', ink); // writing words under a handwritten note
      card.classList.add('tg-mcard-editing');
      const grow = () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
        layoutSoon();
      };
      ta.addEventListener('input', grow);
      grow();
      ta.focus();
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        editing = null;
        const text = ta.value.replace(/\s+$/, '');
        if (keep) a.note = text;
        if (!(a.note || '').trim() && !inkSvg(a.ink) && (fresh || keep)) {
          // An empty note goes; a highlight it was on stays.
          if (a.anchor && a.anchor.quote && a.color) delete a.note;
          else list = list.filter((x) => x !== a);
        }
        changed();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
        }
      });
      ta.addEventListener('blur', () => finish(true));
    }

    layer.addEventListener('click', (e) => {
      const card = e.target.closest('.tg-mcard-user');
      if (!card) return;
      if (e.target.closest('.tg-mcard-del')) remove(card.dataset.id);
      else if (e.target.closest('.tg-mcard-edit')) edit(card.dataset.id, false);
    });
    layer.addEventListener('dblclick', (e) => {
      const card = e.target.closest('.tg-mcard-user');
      if (card && !card.classList.contains('tg-mcard-editing') && typeof (byId(card.dataset.id) || {}).note === 'string') edit(card.dataset.id, false);
    });
    layer.addEventListener('mouseover', (e) => {
      const card = e.target.closest('.tg-mcard-user');
      flash(card ? byId(card.dataset.id) : null);
    });
    layer.addEventListener('mouseleave', () => flash(null));

    // --- dragging notes: from the pad onto the page, and from line to line ----------------

    const pad = page.createElement('button');
    pad.type = 'button';
    pad.className = 'tg-note-pad';
    pad.title = 'Drag onto the page to add a note';
    pad.setAttribute('aria-label', 'Add a note: drag onto the page');
    pad.innerHTML = ICONS.note;
    // The pad sits in a dock with a handle on top: drag the handle to move the
    // pad out of the way (the pad itself drags a new note onto the page).
    const dock = page.createElement('div');
    dock.className = 'tg-note-dock';
    dock.hidden = !study;
    const padGrip = page.createElement('div');
    padGrip.className = 'tg-note-dock-grip';
    padGrip.tabIndex = 0;
    padGrip.setAttribute('role', 'button');
    padGrip.title = 'Drag to move the note pad · double-click to put it back';
    padGrip.setAttribute('aria-label', 'Move the note pad (arrow keys)');
    dock.append(padGrip, pad);
    page.body.appendChild(dock);
    let padAt = null; // { right, bottom } in px, or null: the corner the stylesheet gives
    function placePad() {
      if (!padAt) {
        dock.style.right = '';
        dock.style.bottom = '';
        return;
      }
      const w = dock.offsetWidth || 36;
      const h = dock.offsetHeight || 46;
      const right = Math.round(Math.max(2, Math.min(win.innerWidth - w - 2, padAt.right)));
      const bottom = Math.round(Math.max(2, Math.min(win.innerHeight - h - 2, padAt.bottom)));
      dock.style.right = right + 'px';
      dock.style.bottom = bottom + 'px';
    }
    function setPadAt(at, save) {
      padAt = at && isFinite(at.right) && isFinite(at.bottom) ? { right: +at.right, bottom: +at.bottom } : null;
      placePad();
      if (padAt) padAt = { right: parseFloat(dock.style.right), bottom: parseFloat(dock.style.bottom) };
      if (save && opts.onPadMove) opts.onPadMove(padAt && Object.assign({}, padAt));
    }
    const padNow = () => {
      const r = dock.getBoundingClientRect();
      return { right: win.innerWidth - r.right, bottom: win.innerHeight - r.bottom };
    };
    padGrip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      padGrip.setPointerCapture(e.pointerId);
      const sx = e.clientX;
      const sy = e.clientY;
      const from = padNow();
      let moved = false;
      dock.classList.add('tg-note-dock-moving');
      const move = (ev) => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 2) moved = true;
        setPadAt({ right: from.right - (ev.clientX - sx), bottom: from.bottom - (ev.clientY - sy) }, false);
      };
      const up = () => {
        padGrip.removeEventListener('pointermove', move);
        padGrip.removeEventListener('pointerup', up);
        padGrip.removeEventListener('pointercancel', up);
        dock.classList.remove('tg-note-dock-moving');
        if (moved) setPadAt(padAt, true);
      };
      padGrip.addEventListener('pointermove', move);
      padGrip.addEventListener('pointerup', up);
      padGrip.addEventListener('pointercancel', up);
    });
    padGrip.addEventListener('dblclick', () => setPadAt(null, true));
    padGrip.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [20, 0], ArrowRight: [-20, 0], ArrowUp: [0, 20], ArrowDown: [0, -20] }[e.key];
      if (!d) return;
      e.preventDefault();
      const at = padNow();
      setPadAt({ right: at.right + d[0], bottom: at.bottom + d[1] }, true);
    });
    win.addEventListener('resize', () => { if (padAt) placePad(); });

    function startDrag(e, from, onDrop) {
      e.preventDefault();
      flash(null);
      hideBar();
      const ghost = page.createElement('div');
      ghost.className = 'tg-mcard tg-mcard-user tg-mcard-ghost';
      ghost.style.width = (marginW || 180) + 'px';
      ghost.innerHTML = from ? from.innerHTML : '<div class="tg-mcard-body"><span class="tg-mcard-empty">New note</span></div>';
      if (from) {
        ghost.style.setProperty('--note-c', from.style.getPropertyValue('--note-c'));
        from.classList.add('tg-mcard-dragging');
      }
      page.body.appendChild(ghost);
      const line = page.createElement('div');
      line.className = 'tg-drop-line';
      pane.appendChild(line);
      let moved = false;
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev) => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) moved = true;
        ghost.style.left = ev.clientX + 8 + 'px';
        ghost.style.top = ev.clientY - 10 + 'px';
        // Show the line it would go on.
        const i = offsetAtPoint(ev.clientX, ev.clientY, true);
        const r = i == null ? null : rangeOf(i, i);
        const rect = r && firstRect(r);
        line.hidden = !rect;
        if (rect) {
          const p = pane.getBoundingClientRect();
          const dr = doc.getBoundingClientRect();
          line.style.top = rect.top - p.top + pane.scrollTop + 'px';
          line.style.height = rect.height + 'px';
          const cs = win.getComputedStyle(doc);
          line.style.left = dr.left - p.left + pane.scrollLeft + parseFloat(cs.paddingLeft) - 6 + 'px';
          line.style.width = doc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 12 + 'px';
        }
      };
      const up = (ev) => {
        page.removeEventListener('pointermove', move);
        page.removeEventListener('pointerup', up);
        page.removeEventListener('pointercancel', up);
        ghost.remove();
        line.remove();
        if (from) from.classList.remove('tg-mcard-dragging');
        const pr = pane.getBoundingClientRect();
        const inside = ev.type === 'pointerup' && ev.clientX >= pr.left && ev.clientX <= pr.right && ev.clientY >= pr.top && ev.clientY <= pr.bottom;
        onDrop(moved && inside ? offsetAtPoint(ev.clientX, ev.clientY, true) : null, moved);
      };
      page.addEventListener('pointermove', move);
      page.addEventListener('pointerup', up);
      page.addEventListener('pointercancel', up);
      move(e);
    }

    pad.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      startDrag(e, null, (i, moved) => {
        if (!moved) {
          // A click: a note on the selection, or on the line in the middle of the pane.
          const s = selectionInDoc();
          if (s) {
            i = null;
            const a = add(s.start, s.end, { color: 'yellow', note: '' });
            win.getSelection().removeAllRanges();
            changed();
            edit(a.id, true);
            return;
          }
          const p = pane.getBoundingClientRect();
          i = offsetAtPoint(p.left + p.width / 2, p.top + p.height / 2, true);
        }
        i = wordStart(i);
        if (i == null) return;
        const a = add(i, i, { note: '' });
        changed();
        edit(a.id, true);
      });
    });

    layer.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.tg-mcard-user:not(.tg-mcard-editing)');
      if (!head || e.button !== 0 || e.target.closest('button')) return;
      const card = head;
      const a = byId(card.dataset.id);
      if (!a) return;
      startDrag(e, card, (i) => {
        i = wordStart(i);
        if (i == null) return;
        if (a.anchor && a.anchor.quote && a.color) {
          // A note on a highlight leaves the highlight where it is.
          const note = a.note;
          delete a.note;
          add(i, i, { note, color: a.color });
        } else {
          a.anchor = anchorFor(i, i);
        }
        changed();
      });
    });

    // --- the margin as a drawer (a phone) ------------------------------------------------

    function setOverlay(on) {
      on = !!on;
      if (on === overlay) return;
      if (on) {
        wideCollapsed = collapsed;
        overlay = true;
        collapsed = true;
      } else {
        overlay = false;
        collapsed = wideCollapsed;
      }
      layout();
    }
    // a tap outside the open drawer closes it (a note's dot opens it: see above)
    page.addEventListener('pointerdown', (e) => {
      if (!overlay || collapsed || layer.contains(e.target) || bar.contains(e.target) || dock.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.mnote')) return;
      setCollapsed(true);
    }, true);
    page.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !collapsed && !editing) setCollapsed(true);
    });
    if (win.TeXglassTouch) {
      win.TeXglassTouch.swipeAway(layer, { edge: 'right', enabled: () => overlay && !collapsed, onSwipe: () => setCollapsed(true) });
    }

    // --- writing with a pen in the margin -------------------------------------------------
    //
    // A pen that touches the margin column draws there. Its strokes are kept in
    // margin coordinates while it writes; a pause (or a stroke far from the
    // others) makes them a note on the line beside the first stroke.

    const INK_PAUSE = 1300; // ms without the pen before the strokes become a note
    let pen = null; // the stroke being drawn: { id, points }
    let penBlocks = false; // the touch that follows this pen's pointerdown must not scroll

    function marginRect() {
      if (layer.hidden || collapsed) return null;
      const r = layer.getBoundingClientRect();
      const d = doc.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      return { left: r.left - 10, right: r.left + marginW + 10, top: Math.max(p.top, d.top), bottom: Math.min(p.bottom, d.bottom) };
    }
    function inMargin(x, y) {
      const m = marginRect();
      return !!m && x >= m.left && x <= m.right && y >= m.top && y <= m.bottom;
    }
    function toLayer(e) {
      const r = layer.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }
    function drawLive() {
      const all = inkLive.strokes.concat(pen ? [pen.points] : []);
      inkLive.path.setAttribute('d', inkPath(all));
    }
    function startInk() {
      const svg = page.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'tg-ink-live');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.height = Math.max(doc.offsetHeight, pane.clientHeight) + 'px';
      const path = page.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.7');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      layer.appendChild(svg);
      inkLive = { svg, path, strokes: [], timer: 0 };
    }
    function boxOf(strokes) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const st of strokes) {
        for (let k = 0; k < st.length; k += 2) {
          x0 = Math.min(x0, st[k]); x1 = Math.max(x1, st[k]);
          y0 = Math.min(y0, st[k + 1]); y1 = Math.max(y1, st[k + 1]);
        }
      }
      return { x0, y0, x1, y1 };
    }
    /** The strokes written so far become a note on the line beside the first of them. */
    function commitInk() {
      if (!inkLive) return;
      const live = inkLive;
      clearTimeout(live.timer);
      inkLive = null;
      live.svg.remove();
      if (!live.strokes.length) return layout();
      const b = boxOf(live.strokes);
      const pad = 3;
      const ox = Math.max(0, b.x0 - pad);
      const oy = b.y0 - pad;
      const strokes = live.strokes.map((st) => st.map((v, k) => (k % 2 ? v - oy : v - ox)));
      const ink = { w: Math.ceil(b.x1 - ox + pad), h: Math.ceil(b.y1 - oy + pad), d: inkPath(strokes) };
      // the line level with the top of the writing
      const lr = layer.getBoundingClientRect();
      const i = wordStart(offsetAtPoint(lr.left - 40, lr.top + b.y0 + 6, true));
      if (i == null) return layout();
      add(i, i, { note: '', ink });
      changed();
    }

    pane.addEventListener('pointerdown', (e) => {
      penBlocks = false;
      if (e.pointerType !== 'pen' || !study) return;
      if (!penSeen) {
        penSeen = true; // the margin opens, to write in
        layout();
      }
      if (e.target.closest && e.target.closest('button, textarea, input, a, .tg-mcard-user, .tg-margin-nav, .tg-mnav-menu')) return;
      if (!inMargin(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      penBlocks = true;
      hideBar();
      const at = toLayer(e);
      if (inkLive) {
        clearTimeout(inkLive.timer);
        // far from what is being written: that note is done, this starts another
        const b = boxOf(inkLive.strokes);
        if (inkLive.strokes.length && (at[1] < b.y0 - 60 || at[1] > b.y1 + 60)) commitInk();
      }
      if (!inkLive) startInk();
      pen = { id: e.pointerId, points: at };
      try { pane.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
      drawLive();
    }, true);
    pane.addEventListener('pointermove', (e) => {
      if (!pen || e.pointerId !== pen.id) return;
      e.preventDefault();
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of evs.length ? evs : [e]) {
        const [x, y] = toLayer(ev);
        const n = pen.points.length;
        if (Math.abs(x - pen.points[n - 2]) + Math.abs(y - pen.points[n - 1]) >= 1.5) pen.points.push(x, y);
      }
      drawLive();
    });
    const penUp = (e) => {
      if (!pen || e.pointerId !== pen.id) return;
      inkLive.strokes.push(pen.points);
      pen = null;
      drawLive();
      inkLive.timer = setTimeout(commitInk, INK_PAUSE);
    };
    pane.addEventListener('pointerup', penUp);
    pane.addEventListener('pointercancel', penUp);
    // Pointer events come first: when that pen is writing, its touch must not scroll the page.
    pane.addEventListener('touchstart', (e) => { if (penBlocks) e.preventDefault(); }, { passive: false });
    pane.addEventListener('touchmove', (e) => { if (pen) e.preventDefault(); }, { passive: false });

    // --- the host's side --------------------------------------------------------------------

    function refresh() {
      index = null;
      if (barFor) hideBar();
      place();
      paintHighlights();
      build();
    }

    function setAnnotations(next) {
      // ticks of the hypothesis checker travel with the notes but are not shown here
      list = Array.isArray(next) ? next.filter((a) => a && typeof a.id === 'string' && a.anchor && a.kind !== 'check') : [];
      editing = null;
      refresh();
    }

    function setStudy(on) {
      study = !!on;
      dock.hidden = !study;
      if (study) placePad();
      if (!study) hideBar();
      paintHighlights();
      build();
    }

    function notes() {
      return list.map((a) => Object.assign({}, a));
    }

    return {
      refresh, setAnnotations, setStudy, layout, notes,
      /** The margin's width in px (null: automatic). */
      setWidth: (w) => setUserW(w > 0 ? w : null, false),
      /** Fold the margin away (true) or bring it back. */
      setCollapsed: (on) => setCollapsed(on, false),
      collapsed: () => collapsed,
      /** Put the note pad at { right, bottom } px from the window's corner (null: the default corner). */
      setPadAt: (at) => setPadAt(at, false),
      width: () => marginW,
      /** Jump to the next or the previous note (of the kind chosen); null when there is none. */
      next: () => go(1),
      previous: () => go(-1),
      /** Which notes to jump between: 'all', 'par' (\marginpar), 'todo' or 'mine' (the reader's). */
      setFilter: (kind) => setFilter(kind, false),
      filter: () => filter,
      /** A phone: the margin becomes a drawer over the text (true), or a column beside it again. */
      setOverlay,
      overlay: () => overlay,
      /** Open (or close) the margin; in the drawer this is not remembered. */
      open: (on) => setCollapsed(on === false, true),
      /** Whether the margin has anything to show (notes, or a pen to write with). */
      shown: () => !layer.hidden,
    };
  }

  return { attach, describe, locate, buildIndex, toDom, fromDom, COLORS, inkPath, inkSvg };
});
