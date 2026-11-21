/* Placing a hover popover so all of it stays inside the window, in the web viewer,
 * the browser extension (its viewer and the Overleaf panel) and the VS Code preview.
 *
 *   TeXglassPopover.place(pop, anchor, { gap: 8, margin: 8 });
 *
 * `pop` is a position: fixed box whose first child is the card that scrolls
 * (.ref-popover-body); the caller has already set its width. `anchor` is the
 * element hovered (or a DOMRect). The popover goes below the anchor when it fits
 * there, else above; when it fits on neither side it takes the side with more
 * room and the card is capped to that room, so it scrolls instead of running
 * off the window. Left and right, it is kept inside the window too.
 *
 * A bar across the top of the window (the viewer's toolbar, the Overleaf
 * panel's toolbar) is drawn over the document, so it is not room: the popover
 * stays below it. Bars are found with `opts.bars` (a selector; default
 * BARS below), or `opts.top` gives that edge in pixels.
 *
 * The popover's own vertical padding is the gap between the anchor and the card,
 * so the pointer can cross it into the card (to scroll it) without the popover
 * closing. That padding is counted in, so the bridge stays on the anchor's side.
 *
 * On a touch screen (no hover: phones, tablets) the popover is a sheet at the
 * bottom of the window instead, as wide as the window, opened by a tap. A tap
 * outside it, a swipe down on it, or Escape closes it: the popover is hidden and
 * gets a 'tg-sheet-close' event, so its owner can forget what it was showing.
 *
 *   TeXglassPopover.sheet(win)   // true where previews open as bottom sheets
 */
(function (root) {
  'use strict';

  const MIN_HEIGHT = 80; // never squash the card below this, even on a tiny window
  // bars across the top of the window that a popover must not slide under
  const BARS = '.toolbar, .ol-toolbar, [data-popover-bar]';

  /** The bottom of the bars across the top of the window (0 when there are none). */
  function barsBottom(doc, selector, vh) {
    let bottom = 0;
    if (!doc || !selector) return 0;
    for (const bar of doc.querySelectorAll(selector)) {
      const r = bar.getBoundingClientRect();
      // only a visible bar that starts at the top of the window and is not most of it
      if (!r.height || r.top > 4 || r.bottom > vh / 2) continue;
      bottom = Math.max(bottom, r.bottom);
    }
    return bottom;
  }

  function viewport(pop) {
    const win = (pop.ownerDocument && pop.ownerDocument.defaultView) || root;
    const de = win.document.documentElement;
    // clientWidth/Height leave out the window's own scroll bars
    return { w: de.clientWidth || win.innerWidth, h: de.clientHeight || win.innerHeight };
  }

  function rectOf(anchor) {
    if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return anchor;
    // A link that wraps onto two lines: use the line the pointer is most likely on
    // (the first), not the box around both lines, which can span the whole column.
    const rects = anchor.getClientRects ? anchor.getClientRects() : [];
    return rects.length > 1 ? rects[0] : anchor.getBoundingClientRect();
  }

  /**
   * The vertical place for a popover of natural height `h` (padding included),
   * in a window `vh` high whose top `top` pixels are covered by bars.
   */
  function layout(r, h, vh, margin, top) {
    const minTop = Math.max(margin, top || 0);
    const below = vh - margin - r.bottom; // room under the anchor
    const above = r.top - minTop; // room over it, below the bars
    if (h <= below) return { top: r.bottom, cap: null };
    if (h <= above) return { top: r.top - h, cap: null };
    const down = below >= above;
    const room = Math.max(MIN_HEIGHT, down ? below : above);
    return { down, room, cap: room };
  }

  /** Previews open as bottom sheets where the main pointer cannot hover (a finger). */
  function sheet(win) {
    const w = win || root;
    return !!(w && w.matchMedia && w.matchMedia('(hover: none) and (pointer: coarse)').matches);
  }

  const wired = new WeakSet();
  function closeSheet(pop) {
    if (pop.hidden) return;
    pop.hidden = true;
    pop.dispatchEvent(new (pop.ownerDocument.defaultView.Event)('tg-sheet-close'));
  }
  /** Close on a tap outside and on a swipe down; wired once per popover. */
  function wireSheet(pop) {
    if (wired.has(pop)) return;
    wired.add(pop);
    const page = pop.ownerDocument;
    page.addEventListener('pointerdown', (e) => {
      if (pop.classList.contains('tg-sheet') && !pop.hidden && !pop.contains(e.target)) closeSheet(pop);
    }, true);
    let start = null;
    pop.addEventListener('pointerdown', (e) => {
      // a swipe down from the handle at the top (the card itself scrolls)
      start = e.isPrimary && e.target.classList.contains('tg-sheet-grip') ? { y: e.clientY, x: e.clientX } : null;
      if (start && e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
    });
    pop.addEventListener('pointermove', (e) => {
      if (!start || !pop.classList.contains('tg-sheet')) return;
      const dy = e.clientY - start.y;
      pop.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    });
    const end = (e) => {
      if (!start) return;
      const dy = e.clientY - start.y;
      const dx = Math.abs(e.clientX - start.x);
      start = null;
      pop.style.transform = '';
      // a tap on the handle closes too
      if (pop.classList.contains('tg-sheet') && e.type === 'pointerup' && ((dy > 60 && dy > dx) || (Math.abs(dy) < 6 && dx < 6))) closeSheet(pop);
    };
    pop.addEventListener('pointerup', end);
    pop.addEventListener('pointercancel', end);
    page.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pop.classList.contains('tg-sheet')) closeSheet(pop);
    });
  }

  function place(pop, anchor, opts) {
    const o = Object.assign({ margin: 8 }, opts);
    const win = (pop.ownerDocument && pop.ownerDocument.defaultView) || root;
    const asSheet = o.sheet != null ? !!o.sheet : sheet(win);
    pop.classList.toggle('tg-sheet', asSheet);
    const oldGrip = pop.querySelector(':scope > .tg-sheet-grip');
    if (oldGrip && !asSheet) oldGrip.remove();
    if (asSheet) {
      wireSheet(pop);
      const card = pop.firstElementChild;
      if (card) card.style.maxHeight = '';
      if (!pop.querySelector(':scope > .tg-sheet-grip')) {
        const grip = pop.ownerDocument.createElement('div');
        grip.className = 'tg-sheet-grip';
        grip.setAttribute('aria-hidden', 'true');
        pop.appendChild(grip);
      }
      pop.style.left = '';
      pop.style.top = '';
      return;
    }
    const card = pop.firstElementChild;
    const v = viewport(pop);
    const barTop = o.top != null ? o.top : barsBottom(pop.ownerDocument, o.bars === undefined ? BARS : o.bars, v.h);
    const a = rectOf(anchor);
    // an anchor scrolled up under a bar counts as just below it
    const r = { left: a.left, top: Math.max(a.top, barTop), bottom: Math.max(a.bottom, barTop) };
    if (card) card.style.maxHeight = '';
    const width = pop.offsetWidth;
    const left = Math.max(o.margin, Math.min(r.left, v.w - width - o.margin));
    pop.style.left = Math.max(0, left) + 'px';
    let h = pop.offsetHeight;
    const at = layout(r, h, v.h, o.margin, barTop);
    let top = at.top;
    if (at.cap !== null) {
      const pad = h - (card ? card.offsetHeight : h); // the popover's own padding (the bridge)
      // the card's own max-height (60vh or so) still applies when it is smaller
      if (card) card.style.maxHeight = Math.max(MIN_HEIGHT - pad, at.cap - pad) + 'px';
      h = pop.offsetHeight;
      top = at.down ? r.bottom : r.top - h;
    }
    // An anchor partly off the window (scrolled to an edge, or under the toolbar):
    // keep the card on screen, below the bars.
    top = Math.max(barTop, Math.min(top, v.h - h));
    pop.style.top = top + 'px';
  }

  const api = { place, layout, sheet };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassPopover = api;
})(typeof window !== 'undefined' ? window : this);
