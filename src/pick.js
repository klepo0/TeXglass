/*
 * Show pinned results: pin theorems, lemmas, definitions… and numbered
 * equations, then see only those, with the rest of the document hidden. The
 * proof of a picked result comes along folded to its first line; a click
 * opens it. Printing then prints what is shown: the picked results, their
 * section headings, and only the proofs that are open.
 *
 *   const pick = TeXglassPick.attach({
 *     root,               // the rendered document
 *     jump(el),           // scroll to a block
 *     proofsOf(el),       // the proofs of a result (else: the proofs right after it)
 *     print(),            // print what is shown
 *     onStart(),          // a selection starts: end other views (What does this use?)
 *     share(),            // optional: a Share button on the bar (a link to this view)
 *     canShare(),         // optional: whether there is anything to share (else no button)
 *     // optional: the host keeps the pins (TeXglassInsight does, with the map):
 *     items(),            // the elements to show (pins, with what they bring along)
 *     isOn(el),           // whether a result or equation is pinned
 *     toggle(el),         // pin it, or unpin it
 *     clear(),            // unpin everything
 *     sheet(),            // optional: the study sheet, the pins in the reader's order with
 *                         //   their notes: [{ el, name, note }]; shown at the top of the
 *                         //   view (and each note above its pin) once there is an order or a note
 *     hasOrder(),         // optional: whether the reader put the pins in an order
 *     context(el),        // optional: what a pinned result rests on, folded under it:
 *                         //   { defs: [{ el, name }], symbols: [{ tex, el, where, shown() }] }
 *                         //   (TeXglassInsight's contextOf), or null
 *     renderSymbols(box), // optional: draw the [data-sym] symbols in box (a promise)
 *     epub(),             // optional: an EPUB button on the bar: the host makes the handout an e-book
 *   });
 *   pick.start();         // pin: click results and equations to pin them
 *   pick.show();          // show only the pinned ones
 *   pick.pinsChanged();   // the host's pins changed: show (or tick) them again
 *   pick.step(1 | -1);    // in the view: go to the next or previous pin (‹ › on the bar, J / K)
 *   pick.stop();          // the whole document again
 *   pick.refresh();       // after a new render: the same selection again
 *   pick.showShared({ items, keep, onEnd, sheet, hasOrder }); // a view from a link (src/share.js),
 *                         //   shown without touching the reader's pins: Keep / Dismiss
 *   pick.showTemp(view);  // a temporary set, shown without touching the reader's pins
 *                         //   ("What does this use?", a search by use; src/insight.js):
 *                         //   view: { kind: 'uses', items(), stops(), marks(), open(), at,
 *                         //   label(n), controls(), act(name, button), editable, save(info),
 *                         //   keep(info), onEnd() }; info: { edited, els }. Done (or Esc)
 *                         //   throws it away, and the reader's own pins are as they were
 *   pick.temp();          // the temporary view showing (or being changed), or null
 *   pick.shown();         // the elements the view shows now
 *   await pick.handout({ ids });  // the view as a handout: { title, html } with the pins in the
 *                         //   reading order, each with its note, the proofs opened, and at the end
 *                         //   the definitions and notation they rest on (ids: keep the ids, for an e-book)
 *   pick.printHandout(print); // print the handout instead of the page: print() is window.print
 *
 * TeXglassPick.snapshot(root) tells which blocks are showing now (in any view,
 * "What does this use?" with "Hide the rest" too), so that a page rendered
 * again from the source (VS Code prints in the browser) can show the same;
 * see TeXglassExport.page's `view`. Null when the whole document shows.
 *
 * Works in the browser (window.TeXglassPick) and in Node (require), for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassPick = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Blocks a view is made of; TeXglassExport counts the same ones (VIEW_BLOCKS there). */
  const BLOCKS = 'h1, h2, h3, h4, h5, h6, header, .theorem, .proof, .math-display, figure, table, li, p, blockquote, pre';
  /** Not part of the document: popovers, margin notes, the margin column. */
  const OUTSIDE = '.ref-popover, .insight-popover, .insight-dialog, .mnote, .tg-margin, .tg-hlbar, .tg-note-pad, .tg-note-dock, .pick-bar, .uses-bar, .pick-sheet, .pick-memo, .pick-context, .pick-handout';
  const HEADING = /^H([1-6])$/;
  const CLASSES = ['pick-on', 'pick-hide', 'pick-proof', 'pick-open', 'pick-head', 'pick-sel', 'pick-guess', 'pick-ref'];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** The blocks of root, in document order, that belong to the document. */
  function blocksOf(root) {
    return Array.from(root.querySelectorAll(BLOCKS)).filter((el) => !el.closest(OUTSIDE));
  }

  /** A numbered display: an equation with a number (or a tag) shown beside it. */
  function isNumberedDisplay(el) {
    if (!el.classList.contains('math-display')) return false;
    if (el.querySelector('.katex .tag')) return true;
    const t = el.querySelector('.diagram-tag');
    return !!(t && t.textContent.trim());
  }

  /** What a pickable block is called: "Theorem 2.1", "(3.4)". */
  function nameOf(el) {
    if (el.classList.contains('theorem')) {
      const h = el.querySelector('.thm-name');
      return h ? h.textContent.replace(/\s+/g, ' ').trim() : 'Result';
    }
    const tags = Array.from(el.querySelectorAll('.katex .tag, .diagram-tag')).map((t) => t.textContent.trim()).filter(Boolean);
    return tags.length ? tags.join(', ') : 'Equation';
  }

  /**
   * Which blocks show now, as indices into blocksOf(root): those not hidden,
   * leaving out proofs a view shows folded. Null if every block shows.
   */
  function snapshot(root) {
    const view = root.ownerDocument && root.ownerDocument.defaultView;
    if (!view || !view.getComputedStyle) return null;
    const blocks = blocksOf(root);
    const hiddenCache = new Map();
    const hidden = (el) => {
      if (!el || el === root) return false;
      if (hiddenCache.has(el)) return hiddenCache.get(el);
      const h = view.getComputedStyle(el).display === 'none' || hidden(el.parentElement);
      hiddenCache.set(el, h);
      return h;
    };
    const folded = (el) => !!el.closest('.pick-proof:not(.pick-open)');
    const keep = [];
    let all = true;
    blocks.forEach((el, i) => {
      if (hidden(el) || folded(el)) all = false;
      else keep.push(i);
    });
    return all ? null : { n: blocks.length, keep };
  }

  function attach(opts) {
    const doc = opts.root;
    const document_ = doc.ownerDocument;
    let mode = null; // null | 'pick' | 'view'
    let picked = []; // ids, in the order they were ticked
    let marked = [];
    let bar = null;
    // A view shown without touching the reader's pins, while it shows: one someone
    // shared ({ items(), keep() }), or a temporary set ({ kind: 'uses', … }: What
    // does this use?, a search by use; see showTemp). Changing a temporary set
    // (Change) takes results away (removed: ids) or adds them (added: ids).
    let shared = null;
    let stops = []; // the pins to step through in the view (‹ › on the bar, J / K), in the reading order
    let at = -1; // the one stepped to last

    const pickables = () => blocksOf(doc).filter((el) => (el.classList.contains('theorem') && el.id) || (isNumberedDisplay(el) && el.id));
    const isTemp = () => !!(shared && shared.kind === 'uses');
    /** A temporary set's elements, with the reader's changes to it. */
    const tempEls = () => {
      let els = [];
      try { els = shared.items() || []; } catch (e) { els = []; }
      if (!shared.removed && !shared.added) return els;
      const out = els.filter((el) => !(el && el.id && shared.removed && shared.removed.has(el.id)));
      for (const id of shared.added || []) out.push(document_.getElementById(id));
      return out;
    };
    const pickedEls = () => {
      const els = shared
        ? Array.from(new Set(tempEls())).filter((el) => el && doc.contains(el))
        : opts.items
        ? Array.from(new Set(opts.items() || [])).filter((el) => el && doc.contains(el))
        : picked.map((id) => document_.getElementById(id)).filter((el) => el && doc.contains(el));
      return els.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
    };
    const isOn = (el) => (isTemp() ? pickedEls().includes(el) : opts.isOn ? !!opts.isOn(el) : picked.includes(el.id));

    function proofsOf(el) {
      const given = opts.proofsOf ? opts.proofsOf(el) : null;
      if (given && given.length) return given;
      // The proofs that follow the result, until the next result.
      const out = [];
      const blocks = blocksOf(doc).filter((b) => b.classList.contains('theorem') || b.classList.contains('proof'));
      const k = blocks.indexOf(el);
      for (let i = k + 1; k >= 0 && i < blocks.length; i++) {
        if (blocks[i].classList.contains('theorem')) break;
        if (!blocks[i].parentElement.closest('.proof')) out.push(blocks[i]);
      }
      return out;
    }

    function clearMarks() {
      for (const el of marked) el.classList.remove(...CLASSES);
      marked = [];
      for (const b of doc.querySelectorAll('.pick-box, .pick-sheet, .pick-memo, .pick-context, .pick-handout')) b.remove();
      doc.classList.remove('pick-printing');
      for (const el of doc.querySelectorAll('.pick-able')) el.classList.remove('pick-able', 'pick-on');
      doc.classList.remove('pick-mode', 'pick-view');
    }

    // --- picking -------------------------------------------------------------

    function drawBoxes() {
      const inTemp = isTemp() ? new Set(pickedEls()) : null;
      for (const el of pickables()) {
        const on = { has: () => (inTemp ? inTemp.has(el) : isOn(el)) }; // pinned (or in the temporary set)
        el.classList.add('pick-able');
        el.classList.toggle('pick-on', on.has(el.id));
        let box = el.querySelector(':scope > .pick-box');
        if (!box) {
          box = document_.createElement('span');
          box.className = 'pick-box';
          box.setAttribute('role', 'checkbox');
          el.insertBefore(box, el.firstChild);
        }
        box.setAttribute('aria-checked', String(on.has(el.id)));
        box.setAttribute('aria-label', inTemp ? `Show ${nameOf(el)} in this view` : `Pin ${nameOf(el)}`);
        box.title = inTemp ? (on.has(el.id) ? 'In this view: click to take it away' : 'Click to add it to this view') : on.has(el.id) ? 'Pinned: click to unpin' : 'Click to pin';
      }
    }

    /** Leave the view shown without the reader's pins (if any), telling it so. */
    function endTemp() {
      const was = shared;
      shared = null;
      if (was && was.onEnd) was.onEnd();
    }

    /** Pin and unpin (o.temp: add to and take away from the temporary set showing instead). */
    function start(o) {
      if (!(o && o.temp && isTemp())) endTemp();
      if (opts.onStart) opts.onStart();
      clearMarks();
      mode = 'pick';
      doc.classList.add('pick-mode');
      drawBoxes();
      showBar();
    }

    function toggle(el) {
      if (!el || !el.id) return;
      if (isTemp()) {
        // the temporary set changes; the reader's pins stay as they are
        const on = pickedEls().includes(el);
        shared.removed = shared.removed || new Set();
        shared.added = shared.added || new Set();
        if (on) { shared.removed.add(el.id); shared.added.delete(el.id); }
        else { shared.removed.delete(el.id); shared.added.add(el.id); }
        shared.edited = true;
        shared.note = '';
      } else if (opts.toggle) opts.toggle(el);
      else {
        const k = picked.indexOf(el.id);
        if (k >= 0) picked.splice(k, 1);
        else picked.push(el.id);
      }
      if (mode === 'pick') { drawBoxes(); showBar(); }
    }

    /** The host's pins changed: tick them, or show them, again (without jumping). */
    function pinsChanged() {
      if (mode === 'pick') { drawBoxes(); showBar(); }
      else if (mode === 'view') refresh(true);
    }

    // --- showing only what is picked -------------------------------------------

    function show(stay) {
      const els = pickedEls();
      if (!els.length) return;
      if (opts.onStart) opts.onStart();
      clearMarks();
      mode = 'view';
      const keep = new Map();
      for (const el of els) keep.set(el, 'pick-on');
      const inside = (x) => Array.from(keep.keys()).some((k) => k !== x && (k.contains(x) || x.contains(k)));
      for (const el of els) {
        if (!el.classList.contains('theorem')) continue;
        for (const p of proofsOf(el)) if (!keep.has(p) && doc.contains(p) && !inside(p)) keep.set(p, 'pick-proof');
      }
      // The title, and the headings of the sections something picked is in.
      const title = doc.querySelector('.title-block');
      if (title && !inside(title)) keep.set(title, 'pick-head');
      const heads = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter((h) => !h.closest(OUTSIDE) && !h.closest('.title-block, .theorem, .proof'));
      const items = heads.concat(els).sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
      const stack = [];
      for (const it of items) {
        const m = HEADING.exec(it.tagName);
        if (m && heads.includes(it)) {
          const level = +m[1];
          while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
          stack.push({ el: it, level });
        } else {
          for (const s of stack) if (!keep.has(s.el) && !inside(s.el)) keep.set(s.el, 'pick-head');
        }
      }
      // Hide every block that holds nothing kept; go inside the ones that do.
      const lit = new Set();
      for (const k of keep.keys()) for (let p = k.parentElement; p && p !== doc; p = p.parentElement) lit.add(p);
      const walk = (node) => {
        for (const c of node.children) {
          const cls = keep.get(c);
          if (cls) { c.classList.add(cls); marked.push(c); }
          else if (lit.has(c)) walk(c);
          else if (!c.matches(OUTSIDE)) { c.classList.add('pick-hide'); marked.push(c); }
        }
      };
      walk(doc);
      // a temporary set marks what it is about (the result asked about, what it refers to)
      if (shared && shared.marks) {
        let extra = null;
        try { extra = shared.marks(); } catch (e) { extra = null; }
        for (const [el, cls] of extra || []) {
          if (!el || !keep.has(el)) continue;
          el.classList.add(...cls.split(' '));
          if (!marked.includes(el)) marked.push(el);
        }
      }
      // and opens the proofs it wants open (the proof of the result asked about)
      if (shared && shared.open && !stay) {
        let open = [];
        try { open = shared.open() || []; } catch (e) { open = []; }
        for (const p of open) if (keep.get(p) === 'pick-proof') p.classList.add('pick-open');
      }
      const sheet = drawSheet();
      drawContexts(els, keep);
      doc.classList.add('pick-view');
      const was = at >= 0 ? stops[at] : null;
      stops = stepOrder(els);
      if (stay) at = stops.indexOf(was);
      else if (shared && shared.at) {
        // the temporary set starts at the result it was asked from
        at = Math.max(0, stops.indexOf(shared.at));
        shared.at = null;
      } else at = sheet ? -1 : 0;
      showBar();
      if (opts.jump && !stay) opts.jump(at >= 0 ? stops[at] : sheet || els[0]);
    }

    /** The pins to step through: in the reader's order when there is one, else the paper's. */
    function stepOrder(els) {
      const src = shared || opts;
      if (shared && shared.stops) {
        // a temporary set steps through its results (not what they refer to)
        let own = [];
        try { own = (shared.stops() || []).filter((el) => els.includes(el)); } catch (e) { own = []; }
        if (own.length) return Array.from(new Set(own));
      }
      let rows = [];
      try { rows = src.hasOrder && src.hasOrder() && src.sheet ? (src.sheet() || []) : []; } catch (e) { rows = []; }
      const out = [];
      for (const r of rows) if (r && r.el && els.includes(r.el) && !out.includes(r.el)) out.push(r.el);
      for (const el of els) if (!out.includes(el)) out.push(el);
      return out;
    }

    /** Go to the next (by 1) or the previous (by -1) pin in the view. */
    function step(by) {
      if (mode !== 'view' || !stops.length) return false;
      const k = stops.length;
      at = at < 0 ? (by > 0 ? 0 : k - 1) : (at + by + k) % k;
      if (opts.jump) opts.jump(stops[at]);
      showBar();
      return true;
    }

    // --- the study sheet: the pins in the reader's order, with their notes ---------

    function drawSheet() {
      const src = shared || opts;
      let rows = [];
      try { rows = src.sheet ? (src.sheet() || []).filter((r) => r && r.el && doc.contains(r.el)) : []; } catch (e) { rows = []; }
      const ordered = !!(src.hasOrder && src.hasOrder());
      if (!rows.length || (!ordered && !rows.some((r) => r.note))) return null;
      const sheet = document_.createElement('nav');
      sheet.className = 'pick-sheet';
      sheet.setAttribute('aria-label', 'Study sheet');
      sheet.innerHTML = `<div class="pick-sheet-head"><strong>${ordered ? 'Reading order' : 'Your notes on the pins'}</strong> <span class="insight-muted">click one to go to it</span></div><ol>` +
        rows.map((r, i) => `<li><button type="button" class="pick-sheet-go" data-sheet-go="${i}">${esc(r.name || 'Pinned')}</button>${r.note ? ` <span class="pick-sheet-note">${esc(r.note)}</span>` : ''}</li>`).join('') + '</ol>';
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('[data-sheet-go]');
        const r = b && rows[+b.dataset.sheetGo];
        if (r && opts.jump) { e.preventDefault(); opts.jump(r.el); }
      });
      // under the title, or at the top
      const title = doc.querySelector('.title-block.pick-head');
      if (title && title.parentNode) title.parentNode.insertBefore(sheet, title.nextSibling);
      else {
        const first = Array.from(doc.children).find((c) => !c.matches(OUTSIDE) && !c.classList.contains('pick-hide')) || doc.firstChild;
        doc.insertBefore(sheet, first || null);
      }
      // each pin: its number in the order and its note, just above it
      const done = new Set();
      rows.forEach((r, i) => {
        if (done.has(r.el) || (!ordered && !r.note)) return;
        done.add(r.el);
        const memo = document_.createElement('div');
        memo.className = 'pick-memo';
        memo.innerHTML = (ordered ? `<span class="pick-memo-n">${i + 1}</span>` : '') + (r.note ? `<span class="pick-memo-t">${esc(r.note)}</span>` : '');
        if (r.el.parentNode) r.el.parentNode.insertBefore(memo, r.el);
      });
      return sheet;
    }

    // --- what a pinned result rests on: definitions and notation, folded under it ---

    const contextOf = (el) => {
      const src = shared || opts;
      if (!(src.context || opts.context)) return null;
      try { return (src.context || opts.context)(el); } catch (e) { return null; }
    };
    const symHtml = (s) => `<span class="pick-ctx-sym" data-sym="${esc(s.tex)}"><code>${esc(s.tex)}</code></span>`;
    /** "Definition 2.1, Definition 3 · 𝓕, μ_t" (the first few symbols). */
    function contextSummary(c) {
      const parts = [];
      if (c.defs.length) parts.push(c.defs.map((d) => esc(d.name)).join(', '));
      if (c.symbols.length) {
        const few = c.symbols.slice(0, 6).map(symHtml).join(', ');
        parts.push(`<span class="pick-ctx-k2">notation</span> ${few}${c.symbols.length > 6 ? `, <span class="insight-muted">+${c.symbols.length - 6}</span>` : ''}`);
      }
      return parts.join(' · ');
    }

    /** A copy of a block to show elsewhere: no ids (o.ids keeps them), none of the viewer's buttons and marks. */
    function copyBlock(el, o) {
      const c = el.cloneNode(true);
      const strip = (x) => {
        x.classList.remove(...CLASSES, 'pick-able', 'folded', 'tg-pinned', 'uses-lit', 'uses-dim', 'uses-self');
        if (!(o && o.ids)) x.removeAttribute('id');
      };
      strip(c);
      for (const x of c.querySelectorAll('*')) strip(x);
      for (const x of c.querySelectorAll('.pick-box, .pick-memo, .pick-context, button, .fold-toggle, .uses-btn, .rp-marks, .tg-pin-btn, ' + OUTSIDE)) x.remove();
      return c;
    }

    function drawContexts(els, keep) {
      if (!opts.context) return;
      for (const el of els) {
        if (!el.classList.contains('theorem') && !isNumberedDisplay(el)) continue;
        const c = contextOf(el);
        if (!c) continue;
        const box = document_.createElement('details');
        box.className = 'pick-context';
        box.innerHTML = `<summary title="What ${esc(nameOf(el))} rests on: the definitions it refers to and the notation its formulas use. Click to see them"><span class="pick-ctx-k">Rests on</span> ${contextSummary(c)}</summary><div class="pick-ctx-body"></div>`;
        box.addEventListener('toggle', () => { if (box.open && !box._filled) fillContext(box, c, keep); });
        box.addEventListener('click', (e) => {
          const go = e.target.closest('[data-ctx-go]');
          if (!go) return;
          e.preventDefault();
          const k = go.dataset.ctxGo.split(':');
          const target = k[0] === 'd' ? c.defs[+k[1]].el : c.symbols[+k[1]].el;
          if (target && opts.jump) opts.jump(target);
        });
        // after the result (before its proof); after the equation
        el.parentNode.insertBefore(box, el.nextSibling);
        if (opts.renderSymbols) opts.renderSymbols(box);
      }
    }

    function fillContext(box, c, keep) {
      box._filled = true;
      const body = box.querySelector('.pick-ctx-body');
      c.defs.forEach((d, i) => {
        const shown = keep && keep.has(d.el);
        const item = document_.createElement('div');
        item.className = 'pick-ctx-def';
        item.innerHTML = `<div class="pick-ctx-src"><a href="#" data-ctx-go="d:${i}">${esc(d.name)}</a>${shown ? ' <span class="insight-muted">pinned: shown in this view</span>' : ''}</div>`;
        if (!shown) item.appendChild(copyBlock(d.el));
        body.appendChild(item);
      });
      if (c.symbols.length) {
        const ul = document_.createElement('ul');
        ul.className = 'pick-ctx-syms';
        c.symbols.forEach((s, i) => {
          const li = document_.createElement('li');
          li.innerHTML = `<span class="pick-ctx-what">${symHtml(s)}</span> <span class="pick-ctx-shown"></span>` +
            (s.where ? ` <a href="#" class="pick-ctx-where" data-ctx-go="s:${i}">${esc(s.where)}</a>` : '');
          let shown = null;
          try { shown = s.shown ? s.shown() : null; } catch (e) { shown = null; }
          if (shown) li.querySelector('.pick-ctx-shown').appendChild(shown);
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      if (opts.renderSymbols) opts.renderSymbols(body);
    }

    // --- the handout: the view in the reading order, to print or read as an e-book ---

    /** The heading of the section el is in: "2 Preliminaries", or ''. */
    function sectionOf(el) {
      let found = null;
      for (const h of doc.querySelectorAll('h1, h2, h3, h4')) {
        if (h.closest(OUTSIDE) || h.closest('.title-block, .theorem, .proof')) continue;
        if (h.compareDocumentPosition(el) & 4) found = h; else break;
      }
      if (!found) return '';
      const t = found.textContent.replace(/\s+/g, ' ').trim();
      const num = found.querySelector('.secnum');
      const n = num ? num.textContent.trim() : '';
      return n && t.startsWith(n) ? `§${n} ${t.slice(n.length).trim()}` : t;
    }

    /**
     * The view as a handout: { title, html }. The pins come in the reading
     * order (else in the document's), each with its number and note, the
     * section it is from, and its proofs that are open; then what the view
     * brought along; then, once, the definitions and notation they rest on.
     * o.ids keeps the blocks' ids, so that links work in an e-book.
     */
    async function handout(o) {
      o = o || {};
      const els = pickedEls();
      const src = shared || opts;
      let rows = [];
      try { rows = src.sheet ? (src.sheet() || []).filter((r) => r && r.el && doc.contains(r.el)) : []; } catch (e) { rows = []; }
      const ordered = !!(src.hasOrder && src.hasOrder());
      const used = [];
      const covered = (el) => used.some((u) => u === el || u.contains(el));
      const items = [];
      for (const r of rows) {
        if (covered(r.el)) continue;
        // a passage over several paragraphs brings them all
        const more = (r.more || []).filter((m) => m && doc.contains(m) && !covered(m) && !r.el.contains(m));
        used.push(r.el, ...more);
        items.push({ el: r.el, more, name: r.name || nameOf(r.el), note: r.note || '', pin: true });
      }
      const extra = [];
      for (const el of els) if (!covered(el)) { used.push(el); extra.push({ el, name: el.classList.contains('theorem') || isNumberedDisplay(el) ? nameOf(el) : '', note: '' }); }
      // no study sheet (VS Code without one, a plain list): everything in the document's order
      if (!items.length) { items.push(...extra.map((x) => Object.assign(x, { pin: true }))); extra.length = 0; }
      const openProofs = new Set(marked.filter((m) => m.classList.contains('pick-proof') && m.classList.contains('pick-open')));
      const box = document_.createElement('div');
      const titleEl = doc.querySelector('.title-block');
      const title = (titleEl && (titleEl.querySelector('.title, h1') || titleEl).textContent.replace(/\s+/g, ' ').trim()) || '';
      if (titleEl) {
        const t = copyBlock(titleEl, o);
        for (const x of t.querySelectorAll('.abstract, .keywords, .msc, .date')) x.remove();
        box.appendChild(t);
      }
      const showOrder = ordered || items.some((x) => x.note);
      const idOf = (el) => (o.ids && el.id ? el.id : '');
      if (showOrder) {
        const nav = document_.createElement('section');
        nav.className = 'pick-handout-order';
        nav.innerHTML = `<h2>${ordered ? 'Reading order' : 'Contents'}</h2><ol>` + items.map((x) =>
          `<li>${idOf(x.el) ? `<a href="#${esc(idOf(x.el))}">${esc(x.name || 'Passage')}</a>` : esc(x.name || 'Passage')}${x.note ? ` <span class="pick-sheet-note">${esc(x.note)}</span>` : ''}</li>`).join('') + '</ol>';
        box.appendChild(nav);
      }
      const ctxDefs = new Map(); // el → name
      const ctxSyms = new Map(); // key → symbol
      const put = (x, i, parent) => {
        const item = document_.createElement('section');
        item.className = 'pick-handout-item';
        if (x.pin && (ordered || x.note)) {
          const memo = document_.createElement('div');
          memo.className = 'pick-memo';
          memo.innerHTML = (ordered ? `<span class="pick-memo-n">${i + 1}</span>` : '') + (x.note ? `<span class="pick-memo-t">${esc(x.note)}</span>` : '');
          item.appendChild(memo);
        }
        const from = sectionOf(x.el);
        if (from) {
          const p = document_.createElement('p');
          p.className = 'pick-handout-from';
          p.textContent = 'From ' + from;
          item.appendChild(p);
        }
        item.appendChild(copyBlock(x.el, o));
        for (const m of x.more || []) item.appendChild(copyBlock(m, o));
        if (x.el.classList.contains('theorem')) for (const p of proofsOf(x.el)) if (openProofs.has(p)) item.appendChild(copyBlock(p, o));
        const c = x.el.classList.contains('theorem') || isNumberedDisplay(x.el) ? contextOf(x.el) : null;
        if (c) {
          const line = document_.createElement('p');
          line.className = 'pick-handout-rests';
          line.innerHTML = `<span class="pick-ctx-k">Rests on</span> ${contextSummary(c)}`;
          item.appendChild(line);
          for (const d of c.defs) if (!used.includes(d.el) && !used.some((u) => u.contains(d.el))) ctxDefs.set(d.el, d.name);
          for (const s of c.symbols) if (!ctxSyms.has(s.key)) ctxSyms.set(s.key, s);
        }
        parent.appendChild(item);
      };
      items.forEach((x, i) => put(x, i, box));
      if (extra.length) {
        const sec = document_.createElement('section');
        sec.className = 'pick-handout-extra';
        sec.innerHTML = '<h2>Also in this view</h2>';
        extra.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1)).forEach((x, i) => put(x, i, sec));
        box.appendChild(sec);
      }
      if (ctxDefs.size || ctxSyms.size) {
        const sec = document_.createElement('section');
        sec.className = 'pick-handout-context';
        sec.innerHTML = '<h2>Definitions and notation used</h2>';
        const defEls = Array.from(ctxDefs.keys()).sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
        for (const d of defEls) {
          const item = document_.createElement('section');
          item.className = 'pick-handout-item';
          const from = sectionOf(d);
          if (from) item.innerHTML = `<p class="pick-handout-from">From ${esc(from)}</p>`;
          item.appendChild(copyBlock(d, o));
          sec.appendChild(item);
        }
        if (ctxSyms.size) {
          const ul = document_.createElement('ul');
          ul.className = 'pick-ctx-syms';
          for (const s of ctxSyms.values()) {
            const li = document_.createElement('li');
            li.innerHTML = `<span class="pick-ctx-what">${symHtml(s)}</span> <span class="pick-ctx-shown"></span>${s.where ? ` <span class="pick-ctx-where">(${esc(s.where)})</span>` : ''}`;
            let shown = null;
            try { shown = s.shown ? s.shown() : null; } catch (e) { shown = null; }
            if (shown) {
              const c = copyBlock(shown, o);
              c.querySelectorAll('[id]').forEach((x) => { if (!o.ids || document_.getElementById(x.id) !== x) x.removeAttribute('id'); });
              li.querySelector('.pick-ctx-shown').appendChild(c);
            }
            ul.appendChild(li);
          }
          sec.appendChild(ul);
        }
        box.appendChild(sec);
      }
      if (opts.renderSymbols) { try { await opts.renderSymbols(box); } catch (e) { /* the TeX stays */ } }
      // symbols that could not be drawn keep their TeX
      for (const x of box.querySelectorAll('[data-sym]')) x.removeAttribute('data-sym');
      return { title, html: box.innerHTML };
    }

    /** Print the handout instead of the page: it goes into the page, alone on paper, until printing ends. */
    async function printHandout(print) {
      const h = await handout({});
      for (const b of doc.querySelectorAll('.pick-handout')) b.remove();
      const box = document_.createElement('div');
      box.className = 'pick-handout';
      box.innerHTML = h.html;
      doc.appendChild(box);
      doc.classList.add('pick-printing');
      const win = document_.defaultView;
      const done = () => { box.remove(); doc.classList.remove('pick-printing'); };
      if (win) win.addEventListener('afterprint', done, { once: true });
      (print || (() => win && win.print()))();
    }

    function stop() {
      if (!mode) return;
      const was = shared;
      shared = null;
      clearMarks();
      mode = null;
      stops = [];
      at = -1;
      if (bar) bar.hidden = true;
      if (was && was.onEnd) was.onEnd();
    }

    /** After a new render: tick the same results again, or show them again. */
    function refresh(stay) {
      if (!mode) return;
      if (mode === 'pick') {
        drawBoxes();
        showBar();
      } else {
        const open = new Set(marked.filter((el) => el.classList.contains('pick-open')));
        const openIdx = new Set(blocksOf(doc).map((b, i) => (open.has(b) ? i : -1)).filter((i) => i >= 0));
        if (!pickedEls().length) return stop();
        show(stay);
        // keep open the proofs that were open, where they still are
        blocksOf(doc).forEach((b, i) => { if (openIdx.has(i) && b.classList.contains('pick-proof')) b.classList.add('pick-open'); });
      }
    }

    // --- the bar ---------------------------------------------------------------

    function showBar() {
      if (!bar) {
        bar = document_.createElement('div');
        bar.className = 'uses-bar pick-bar';
        bar.setAttribute('role', 'status');
        // the bar's menus (Print or share, Keep): a button with data-menu opens the menu after it
        const closeMenus = (except) => {
          let closed = null;
          for (const m of bar.querySelectorAll('.pick-out-menu')) {
            if (m === except || m.hidden) continue;
            m.hidden = true;
            const ob = m.parentElement.querySelector('[data-menu]');
            if (ob) ob.setAttribute('aria-expanded', 'false');
            closed = ob || closed;
          }
          return closed;
        };
        bar.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          const act = b.dataset.act;
          if (b.dataset.menu != null) {
            const menu = b.parentElement.querySelector('.pick-out-menu');
            closeMenus(menu);
            if (menu) { menu.hidden = !menu.hidden; b.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) { const f = menu.querySelector('button'); if (f) f.focus(); } }
            return;
          }
          closeMenus();
          if (act === 'show') show();
          else if (act === 'keep') { if (isTemp()) keepTemp(); else keepShared(); }
          else if (act === 'save') saveTemp();
          else if (act === 'share') { if (opts.share) opts.share(); }
          else if (act === 'clear') { if (opts.clear) opts.clear(); else picked = []; drawBoxes(); showBar(); }
          else if (act === 'edit') start({ temp: true });
          else if (act === 'print') { if (opts.print) opts.print(); }
          else if (act === 'epub') { if (opts.epub) opts.epub(); }
          else if (act === 'next') step(1);
          else if (act === 'prev') step(-1);
          else if (act === 'done') stop();
          else if (act && isTemp() && shared.act) shared.act(act, b); // the temporary set's own buttons
        });
        document_.body.appendChild(bar);
        // a menu closes on a click elsewhere, or Escape (before Escape leaves the view)
        const closeOut = () => {
          const ob = closeMenus();
          if (!ob) return false;
          ob.focus();
          return true;
        };
        document_.addEventListener('pointerdown', (e) => { if (!bar.contains(e.target)) closeOut(); });
        document_.addEventListener('keydown', (e) => { if (e.key === 'Escape' && closeOut()) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
      }
      const n = pickedEls().length;
      const what = (k) => `${k} item${k === 1 ? '' : 's'}`;
      // a button with a small menu opening upwards (Escape or a click elsewhere closes it)
      const menu = (act, label, title, items) => (items.length
        ? '<span class="pick-out">' +
          `<button type="button" data-act="${act}" data-menu="" aria-haspopup="menu" aria-expanded="false" title="${title}">${label} ▾</button>` +
          `<span class="pick-out-menu" role="menu" hidden>${items.join('')}</span></span>`
        : '');
      // Print, EPUB and Share in one button
      const outMenu = (share) => {
        const items = [
          opts.print ? '<button type="button" role="menuitem" data-act="print" title="Print a handout of this view, or save it as a PDF: the pins in your reading order with their notes, open proofs, and the definitions and notation they rest on">Print or save as PDF</button>' : '',
          opts.epub ? '<button type="button" role="menuitem" data-act="epub" title="Download a handout of this view as an EPUB e-book, for an e-reader or a tablet">EPUB e-book</button>' : '',
          share && opts.share && (!opts.canShare || opts.canShare()) ? '<button type="button" role="menuitem" data-act="share" title="Share a link that opens the paper with this view">Share a link</button>' : '',
        ].filter(Boolean);
        return menu('out', share ? 'Print or share' : 'Print', share ? 'Print this view, download it as an EPUB, or share a link to it' : 'Print this view, or download it as an EPUB', items);
      };
      // ‹ 2/5 ›: step through the pins shown (J / K too), as the "What does this use?" bar does
      const stepper = stops.length > 1
        ? '<span class="pick-step" role="group" aria-label="Go through the pins">' +
          '<button type="button" data-act="prev" aria-label="Previous pinned item" title="Previous pinned item (K)">‹</button>' +
          `<span class="uses-step">${at < 0 ? '–' : at + 1}/${stops.length}</span>` +
          '<button type="button" data-act="next" aria-label="Next pinned item" title="Next pinned item (J)">›</button></span>'
        : '';
      const blockName = (el) => (el.classList.contains('theorem') || isNumberedDisplay(el) ? nameOf(el) : null);
      const label = () => { try { return shared.label(n); } catch (e) { return `<strong>${what(n)}</strong>`; } };
      if (mode === 'pick' && isTemp()) {
        // changing a temporary set: the reader's own pins stay as they are
        bar.innerHTML =
          `<span class="uses-what">${label()} <span class="insight-muted">click results and equations to add or take them away</span></span>` +
          `<button type="button" data-act="show" class="uses-done"${n ? '' : ' disabled'} title="Show only these">Show only these</button>` +
          '<button type="button" data-act="done" title="Back to the whole document and your own pins (Esc)">Done</button>';
      } else if (mode === 'pick') {
        const names = pickedEls().map(blockName).filter(Boolean);
        const list = names.length ? ` <span class="pick-names" title="${esc(names.join(', '))}">${esc(names.slice(0, 4).join(', '))}${names.length > 4 ? ', …' : ''}</span>` : '';
        bar.innerHTML =
          `<span class="uses-what">${n ? `<strong>${what(n)} pinned</strong>${list}` : 'Click the results and numbered equations to pin'}</span>` +
          `<button type="button" data-act="show" class="uses-done"${n ? '' : ' disabled'} title="Show only the pinned results and equations">Show only these</button>` +
          (n ? '<button type="button" data-act="clear" title="Take every pin away">Clear all</button>' : '') +
          '<button type="button" data-act="done" title="Back to the whole document (Esc)">Done</button>';
      } else if (isTemp()) {
        // What does this use? (or a search by use): a temporary set, thrown away on Done
        const keepItems = [
          shared.save ? '<button type="button" role="menuitem" data-act="save" title="Keep these as a pin set of their own (Pins tab), to open again later. Your pins now stay as they are">Save as pin set</button>' : '',
          shared.keep ? '<button type="button" role="menuitem" data-act="keep" title="Pin these too, with the pins you have">Add to my pins</button>' : '',
        ].filter(Boolean);
        let controls = '';
        try { controls = shared.controls ? shared.controls() : ''; } catch (e) { controls = ''; }
        bar.innerHTML =
          `<span class="uses-what">${label()}${shared.note ? ` <span class="pick-saved">${esc(shared.note)}</span>` : ''}</span>` +
          controls +
          stepper +
          (shared.editable ? '<button type="button" data-act="edit" title="Take results away from this view, or add others (your own pins stay as they are)">Change</button>' : '') +
          menu('keep-menu', 'Keep', 'Keep these: save them as a pin set, or add them to your pins. Otherwise Done throws them away', keepItems) +
          outMenu(true) +
          '<button type="button" data-act="done" class="uses-done" title="Back to the whole document; your own pins are as they were (Esc)">Done</button>';
      } else if (shared) {
        bar.innerHTML =
          `<span class="uses-what"><strong>Shared view: ${what(n)}</strong> <span class="insight-muted">your own pins stay as they are; proofs fold: click one to open it</span></span>` +
          stepper +
          (shared.keep ? '<button type="button" data-act="keep" title="Add these to your own pins, keeping the ones you have">Keep these pins</button>' : '') +
          outMenu(false) +
          '<button type="button" data-act="done" class="uses-done" title="Leave the shared view: back to the whole document and your own pins (Esc)">Dismiss</button>';
      } else {
        bar.innerHTML =
          `<span class="uses-what"><strong>Showing ${what(n)} pinned</strong> <span class="insight-muted">proofs fold: click one to open it</span></span>` +
          stepper +
          '<button type="button" data-act="edit" title="Pin or unpin results and equations">Change</button>' +
          outMenu(true) +
          '<button type="button" data-act="done" class="uses-done" title="Show the whole document again (Esc)">Done</button>';
      }
      bar.hidden = false;
    }

    // --- a view someone shared ---------------------------------------------------

    /**
     * Show a view that came in a link, leaving the reader's own pins alone.
     * view: { items() (the elements to show), keep() (add them to the reader's
     * pins), onEnd() (the view was left) }. False if nothing in it is here.
     */
    function showShared(view) {
      if (shared && shared !== view) endTemp();
      shared = view;
      if (!pickedEls().length) { shared = null; return false; }
      show();
      return true;
    }

    /**
     * A temporary set: shown like the reader's pins, but without touching them.
     * Done throws it away; Keep saves it as a pin set or adds it to the pins.
     * False (and nothing shown) when it holds nothing here.
     */
    function showTemp(view) {
      return showShared(Object.assign(view, { kind: 'uses' }));
    }

    /** What the Keep buttons hand the temporary set: whether the reader changed it, and what it shows. */
    const tempInfo = () => ({ edited: !!shared.edited, els: pickedEls() });

    function saveTemp() {
      if (!isTemp() || !shared.save) return;
      let name = null;
      try { name = shared.save(tempInfo()); } catch (e) { name = null; }
      shared.note = name ? `Saved as “${name}”` : 'Nothing here to save';
      showBar();
    }

    function keepTemp() {
      if (!isTemp() || !shared.keep) return;
      let msg = '';
      try { msg = shared.keep(tempInfo()); } catch (e) { msg = ''; }
      shared.note = msg || '';
      showBar();
    }

    function keepShared() {
      const v = shared;
      if (!v || !v.keep) return;
      shared = null;
      v.keep();
      // now the reader's own pins, with these among them
      if (pickedEls().length) show(true);
      else stop();
    }

    // --- clicks and keys -------------------------------------------------------

    doc.addEventListener('click', (e) => {
      if (!mode || e.ctrlKey || e.metaKey || !e.target.closest) return;
      if (mode === 'pick') {
        const el = e.target.closest('.pick-able');
        if (!el || !doc.contains(el)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        toggle(el);
        return;
      }
      // A folded proof opens on a click; its fold arrow folds it again.
      const proof = e.target.closest('.pick-proof');
      if (!proof || !doc.contains(proof)) return;
      const arrow = e.target.closest('.fold-toggle');
      if (proof.classList.contains('pick-open')) {
        if (!arrow || arrow.closest('.proof') !== proof || proof.classList.contains('folded')) return;
        proof.classList.remove('pick-open');
      } else {
        if (!arrow && e.target.closest('a, .math-copyable .math[data-tex]')) return;
        proof.classList.add('pick-open');
        if (proof.classList.contains('folded')) return; // the host unfolds its own fold too
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    document_.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mode && !e.defaultPrevented && !document_.querySelector('dialog[open]')) stop();
    });
    // J / K in the view step through what it shows (before the pin's own J / K, src/pins.js)
    document_.addEventListener('keydown', (e) => {
      if (mode !== 'view' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document_.querySelector('dialog[open]')) return;
      if (step(k === 'j' ? 1 : -1)) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    return {
      start,
      show: () => { endTemp(); show(); },
      stop,
      refresh: () => refresh(),
      toggle,
      step,
      pinsChanged,
      /** null, 'pick' or 'view' */
      mode: () => mode,
      showShared,
      showTemp,
      /** Whether the view showing is one that came in a link. */
      isShared: () => !!shared && !isTemp(),
      /** The temporary set showing (What does this use?, a search by use), or null. */
      temp: () => (isTemp() ? shared : null),
      /** The elements the view shows now. */
      shown: () => pickedEls(),
      /** The proofs a click opened (in the view of pinned items). */
      openProofs: () => marked.filter((el) => el.classList.contains('pick-proof') && el.classList.contains('pick-open')),
      picked: () => picked.slice(),
      /** Tick these (ids or elements) and show them. */
      select(list) {
        picked = (list || []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
        if (picked.length) show();
      },
      snapshot: () => snapshot(doc),
      handout,
      printHandout,
    };
  }

  return { attach, snapshot, blocksOf, isNumberedDisplay, nameOf, BLOCKS };
});
