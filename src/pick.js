/*
 * Show selected results: pick theorems, lemmas, definitions… and numbered
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
 *   });
 *   pick.start();         // pick: click results and equations to tick them
 *   pick.show();          // show only the ticked ones
 *   pick.stop();          // the whole document again
 *   pick.refresh();       // after a new render: the same selection again
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
  const OUTSIDE = '.ref-popover, .insight-popover, .insight-dialog, .mnote, .tg-margin, .tg-hlbar, .tg-note-pad, .tg-note-dock, .pick-bar, .uses-bar';
  const HEADING = /^H([1-6])$/;
  const CLASSES = ['pick-on', 'pick-hide', 'pick-proof', 'pick-open', 'pick-head'];

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
    const collapse = root.classList.contains('uses-focus') && root.classList.contains('uses-collapse');
    const folded = (el) => !!(el.closest('.pick-proof:not(.pick-open)') || (collapse && el.closest('.uses-proof:not(.uses-open)')));
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

    const pickables = () => blocksOf(doc).filter((el) => (el.classList.contains('theorem') && el.id) || (isNumberedDisplay(el) && el.id));
    const pickedEls = () => {
      const els = picked.map((id) => document_.getElementById(id)).filter((el) => el && doc.contains(el));
      return els.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
    };

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
      for (const b of doc.querySelectorAll('.pick-box')) b.remove();
      for (const el of doc.querySelectorAll('.pick-able')) el.classList.remove('pick-able', 'pick-on');
      doc.classList.remove('pick-mode', 'pick-view');
    }

    // --- picking -------------------------------------------------------------

    function drawBoxes() {
      const on = new Set(picked);
      for (const el of pickables()) {
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
        box.setAttribute('aria-label', `Select ${nameOf(el)}`);
        box.title = on.has(el.id) ? 'Selected: click to leave it out' : 'Click to select';
      }
    }

    function start() {
      if (opts.onStart) opts.onStart();
      clearMarks();
      mode = 'pick';
      doc.classList.add('pick-mode');
      drawBoxes();
      showBar();
    }

    function toggle(el) {
      if (!el || !el.id) return;
      const k = picked.indexOf(el.id);
      if (k >= 0) picked.splice(k, 1);
      else picked.push(el.id);
      if (mode === 'pick') { drawBoxes(); showBar(); }
    }

    // --- showing only what is picked -------------------------------------------

    function show() {
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
      doc.classList.add('pick-view');
      showBar();
      if (opts.jump) opts.jump(els[0]);
    }

    function stop() {
      if (!mode) return;
      clearMarks();
      mode = null;
      if (bar) bar.hidden = true;
    }

    /** After a new render: tick the same results again, or show them again. */
    function refresh() {
      if (!mode) return;
      if (mode === 'pick') {
        drawBoxes();
        showBar();
      } else {
        const open = new Set(marked.filter((el) => el.classList.contains('pick-open')));
        const openIdx = new Set(blocksOf(doc).map((b, i) => (open.has(b) ? i : -1)).filter((i) => i >= 0));
        if (!pickedEls().length) return stop();
        show();
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
        bar.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          const act = b.dataset.act;
          if (act === 'show') show();
          else if (act === 'clear') { picked = []; drawBoxes(); showBar(); }
          else if (act === 'edit') start();
          else if (act === 'print') { if (opts.print) opts.print(); }
          else if (act === 'done') stop();
        });
        document_.body.appendChild(bar);
      }
      const n = pickedEls().length;
      const what = (k) => `${k} item${k === 1 ? '' : 's'}`;
      if (mode === 'pick') {
        const names = pickedEls().map(nameOf);
        const list = names.length ? ` <span class="pick-names" title="${esc(names.join(', '))}">${esc(names.slice(0, 4).join(', '))}${names.length > 4 ? ', …' : ''}</span>` : '';
        bar.innerHTML =
          `<span class="uses-what">${n ? `<strong>${what(n)} selected</strong>${list}` : 'Click the results and numbered equations to show'}</span>` +
          `<button type="button" data-act="show" class="uses-done"${n ? '' : ' disabled'} title="Show only the selected results and equations">Show selected</button>` +
          (n ? '<button type="button" data-act="clear" title="Untick everything">Clear</button>' : '') +
          '<button type="button" data-act="done" title="Back to the whole document (Esc)">Cancel</button>';
      } else {
        bar.innerHTML =
          `<span class="uses-what"><strong>Showing ${what(n)}</strong> <span class="insight-muted">proofs fold: click one to open it</span></span>` +
          '<button type="button" data-act="edit" title="Add or remove results and equations">Change</button>' +
          (opts.print ? '<button type="button" data-act="print" title="Print what is shown, or save it as a PDF; folded proofs are left out">Print</button>' : '') +
          '<button type="button" data-act="done" class="uses-done" title="Show the whole document again (Esc)">Done</button>';
      }
      bar.hidden = false;
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

    return {
      start,
      show,
      stop,
      refresh,
      toggle,
      /** null, 'pick' or 'view' */
      mode: () => mode,
      picked: () => picked.slice(),
      /** Tick these (ids or elements) and show them. */
      select(list) {
        picked = (list || []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
        if (picked.length) show();
      },
      snapshot: () => snapshot(doc),
    };
  }

  return { attach, snapshot, blocksOf, isNumberedDisplay, nameOf, BLOCKS };
});
