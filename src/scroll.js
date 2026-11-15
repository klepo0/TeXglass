/* Scrolling the preview to an element, in the web viewer and the VS Code preview.
 *
 * Off-screen blocks of the document are only estimated (content-visibility:
 * auto in styles.css), so a position measured before scrolling is wrong by the
 * time the scroll gets there: the blocks it passes get their real height on
 * the way. This keeps aiming at the element while the scroll runs and puts it
 * in place once it stops, until the page holds still or the reader scrolls.
 *
 *   TeXglassScroll.to(pane, el, { align: 'start' | 'center', offset: 16, smooth: true });
 */
(function (root) {
  'use strict';

  const running = new WeakMap(); // pane -> stop() of the scroll under way

  function to(pane, el, opts) {
    const o = Object.assign({ align: 'start', offset: 16, smooth: true }, opts);
    if (running.has(pane)) running.get(pane)();
    const max = () => Math.max(0, pane.scrollHeight - pane.clientHeight);
    // Where the pane should be scrolled to, as it is laid out now.
    const dest = () => {
      const p = pane.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const d = o.align === 'center' ? r.top + r.height / 2 - (p.top + pane.clientHeight / 2) : r.top - p.top - o.offset;
      return Math.round(Math.min(max(), Math.max(0, pane.scrollTop + d)));
    };

    let aim = dest();
    pane.scrollTo({ top: aim, behavior: o.smooth ? 'smooth' : 'auto' });

    const start = Date.now();
    let lastMove = start;
    let lastTop = pane.scrollTop;
    let still = 0;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((t) => pane.removeEventListener(t, stop));
      if (running.get(pane) === stop) running.delete(pane);
    };
    // The reader takes over as soon as they scroll themselves.
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((t) => pane.addEventListener(t, stop, { passive: true }));
    running.set(pane, stop);

    const tick = () => {
      const now = Date.now();
      if (pane.scrollTop !== lastTop) { lastTop = pane.scrollTop; lastMove = now; }
      const want = dest();
      if (now - lastMove > 120) {
        // The scroll has stopped: snap the rest of the way.
        if (Math.abs(want - pane.scrollTop) > 1) { pane.scrollTop = want; lastTop = pane.scrollTop; still = 0; }
        else still++;
      } else if (Math.abs(want - aim) > 1) {
        // Still moving, but the target moved: aim again.
        pane.scrollTo({ top: want, behavior: o.smooth ? 'smooth' : 'auto' });
      }
      aim = want;
      if (still >= 10 || now - start > 4000) return stop();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return stop;
  }

  const api = { to };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassScroll = api;
})(typeof self !== 'undefined' ? self : this);
