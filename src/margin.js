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
 *    note pad at the bottom right can be dragged onto any line. Notes in the
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
 *   });
 *   margin.refresh();                  // after the document was rendered again
 *   margin.setAnnotations(list); margin.setStudy(on);
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
    grip.title = 'Drag to resize the margin · double-click to reset';
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
      page.body.classList.add('tg-margin-resizing');
      const move = (ev) => setUserW(width + start - ev.clientX, false);
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        page.body.classList.remove('tg-margin-resizing');
        setUserW(marginW, true);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => setUserW(null, true));
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setUserW(marginW + (e.key === 'ArrowLeft' ? 20 : -20), true);
    });

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
        return { el, top: () => rectTop(m.getClientRects()[0]) };
      });
    }

    function noteBody(a) {
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
      cards.forEach((c) => ro && ro.observe(c.el));
      layout();
    }

    let frame = 0;
    function layoutSoon() {
      if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; layout(); });
    }

    let marginW = 0;
    function layout() {
      const on = cards.length > 0;
      doc.classList.toggle('tg-with-margin', on);
      layer.hidden = !on;
      if (!on) return;
      const zoom = (parseFloat(win.getComputedStyle(doc).fontSize) || 18) / 18;
      const w = userW != null
        ? Math.min(userW, maxW())
        : Math.round(Math.min(240 * zoom, Math.max(130, pane.clientWidth * 0.26)));
      if (w !== marginW) {
        marginW = w;
        doc.style.setProperty('--tg-margin-w', w + 'px');
      }
      const cs = win.getComputedStyle(doc);
      layer.style.left = doc.offsetLeft + doc.offsetWidth - parseFloat(cs.paddingRight) + 20 + 'px';
      layer.style.width = w + 'px';
      grip.style.height = doc.offsetHeight + 'px';
      grip.setAttribute('aria-valuenow', String(w));
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

    function showBar(rect, target) {
      barFor = target;
      bar.classList.toggle('tg-hlbar-existing', !!target.id);
      bar.hidden = false;
      const p = pane.getBoundingClientRect();
      const w = bar.offsetWidth;
      const left = Math.max(4, Math.min(rect.left + rect.width / 2 - w / 2 - p.left + pane.scrollLeft, pane.clientWidth - w - 4));
      const above = rect.top - p.top - bar.offsetHeight - 8;
      bar.style.left = left + 'px';
      bar.style.top = (above > 0 ? above : rect.bottom - p.top + 8) + pane.scrollTop + 'px';
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
    page.addEventListener('keyup', (e) => {
      if (!study || !e.shiftKey) return;
      const s = selectionInDoc();
      if (s) showBar(s.rect, { start: s.start, end: s.end });
    });
    page.addEventListener('selectionchange', () => {
      if (barFor && !barFor.id && !selectionInDoc()) hideBar();
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
      editing = id;
      const body = card.querySelector('.tg-mcard-body');
      const ta = page.createElement('textarea');
      ta.className = 'tg-mcard-input';
      ta.value = a.note || '';
      ta.placeholder = 'Write a note… ($…$ for maths)';
      ta.rows = 2;
      body.replaceChildren(ta);
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
        if (!(a.note || '').trim() && (fresh || keep)) {
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
    pad.hidden = !study;
    pad.title = 'Drag onto the page to add a note';
    pad.setAttribute('aria-label', 'Add a note: drag onto the page');
    pad.innerHTML = ICONS.note;
    page.body.appendChild(pad);

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

    // --- the host's side --------------------------------------------------------------------

    function refresh() {
      index = null;
      if (barFor) hideBar();
      place();
      paintHighlights();
      build();
    }

    function setAnnotations(next) {
      list = Array.isArray(next) ? next.filter((a) => a && typeof a.id === 'string' && a.anchor) : [];
      editing = null;
      refresh();
    }

    function setStudy(on) {
      study = !!on;
      pad.hidden = !study;
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
      width: () => marginW,
    };
  }

  return { attach, describe, locate, buildIndex, toDom, fromDom, COLORS };
});
