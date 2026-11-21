/* Swipes on a touch screen, for the drawers of the phone layout in the web viewer:
 * a swipe in from the left or right edge of the window opens the side panel or
 * the margin notes, and a swipe on an open drawer back toward its edge closes it.
 *
 *   TeXglassTouch.edgeSwipe(window, { zone: 24, onSwipe(edge) {} });  // edge: 'left' or 'right'
 *   TeXglassTouch.swipeAway(drawer, { edge: () => 'left', onSwipe() {} });
 *
 * Touch events, passive, are used rather than pointer events: they keep coming
 * while the page scrolls, and nothing here stops the page scrolling. A swipe is
 * mostly sideways (twice as far across as up or down) and at least 56px long, so
 * scrolling up and down, or a formula scrolled sideways, never counts as one.
 */
(function (root) {
  'use strict';

  const MIN = 56; // px across before a swipe counts

  /** Follow one finger from touchstart; `decide(dx, dy, start)` once it has gone far enough sideways. */
  function track(target, accept, decide) {
    let start = null;
    target.addEventListener('touchstart', (e) => {
      start = null;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.touchType === 'stylus') return; // a pen writes (src/margin.js), it never swipes
      if (accept(t, e)) start = { x: t.clientX, y: t.clientY, target: e.target };
    }, { passive: true });
    target.addEventListener('touchmove', (e) => {
      if (!start || e.touches.length !== 1) { start = null; return; }
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) { start = null; return; } // a scroll
      if (Math.abs(dx) >= MIN && Math.abs(dx) >= 2 * Math.abs(dy)) {
        const s = start;
        start = null;
        decide(dx, dy, s);
      }
    }, { passive: true });
    const stop = () => { start = null; };
    target.addEventListener('touchend', stop, { passive: true });
    target.addEventListener('touchcancel', stop, { passive: true });
  }

  function edgeSwipe(win, opts) {
    const zone = opts.zone || 24;
    const doc = win.document;
    track(doc, (t, e) => {
      if (opts.enabled && !opts.enabled()) return false;
      // not from inside a dialog, a menu or an open drawer
      if (e.target.closest && e.target.closest('dialog, [role="menu"], .tg-drawer-open')) return false;
      const w = doc.documentElement.clientWidth || win.innerWidth;
      return t.clientX <= zone || t.clientX >= w - zone;
    }, (dx, dy, s) => {
      const w = doc.documentElement.clientWidth || win.innerWidth;
      const fromLeft = s.x <= zone;
      if (fromLeft && dx > 0) opts.onSwipe('left');
      else if (!fromLeft && s.x >= w - zone && dx < 0) opts.onSwipe('right');
    });
  }

  function swipeAway(el, opts) {
    track(el, () => !opts.enabled || opts.enabled(), (dx, dy, s) => {
      // a formula or a table that scrolls sideways keeps the swipe for itself
      for (let n = s.target; n && n !== el && n.nodeType === 1; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return;
      }
      const edge = typeof opts.edge === 'function' ? opts.edge() : opts.edge;
      if ((edge === 'left' && dx < 0) || (edge === 'right' && dx > 0)) opts.onSwipe();
    });
  }

  const api = { edgeSwipe, swipeAway, MIN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassTouch = api;
})(typeof window !== 'undefined' ? window : this);
