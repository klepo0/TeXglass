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
 * The popover's own vertical padding is the gap between the anchor and the card,
 * so the pointer can cross it into the card (to scroll it) without the popover
 * closing. That padding is counted in, so the bridge stays on the anchor's side.
 */
(function (root) {
  'use strict';

  const MIN_HEIGHT = 80; // never squash the card below this, even on a tiny window

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

  /** The vertical place for a popover of natural height `h` (padding included). */
  function layout(r, h, vh, margin) {
    const below = vh - margin - r.bottom; // room under the anchor
    const above = r.top - margin; // room over it
    if (h <= below) return { top: r.bottom, cap: null };
    if (h <= above) return { top: r.top - h, cap: null };
    const down = below >= above;
    const room = Math.max(MIN_HEIGHT, down ? below : above);
    return { down, room, cap: room };
  }

  function place(pop, anchor, opts) {
    const o = Object.assign({ margin: 8 }, opts);
    const card = pop.firstElementChild;
    const r = rectOf(anchor);
    const v = viewport(pop);
    if (card) card.style.maxHeight = '';
    const width = pop.offsetWidth;
    const left = Math.max(o.margin, Math.min(r.left, v.w - width - o.margin));
    pop.style.left = Math.max(0, left) + 'px';
    let h = pop.offsetHeight;
    const at = layout(r, h, v.h, o.margin);
    let top = at.top;
    if (at.cap !== null) {
      const pad = h - (card ? card.offsetHeight : h); // the popover's own padding (the bridge)
      // the card's own max-height (60vh or so) still applies when it is smaller
      if (card) card.style.maxHeight = Math.max(MIN_HEIGHT - pad, at.cap - pad) + 'px';
      h = pop.offsetHeight;
      top = at.down ? r.bottom : r.top - h;
    }
    // An anchor partly off the window (scrolled to an edge): keep the card on screen.
    top = Math.max(0, Math.min(top, v.h - h));
    pop.style.top = top + 'px';
  }

  const api = { place, layout };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassPopover = api;
})(typeof window !== 'undefined' ? window : this);
