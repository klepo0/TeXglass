/* Scrolling the preview to an element, in the web viewer and the VS Code preview.
 *
 * Off-screen blocks of the document are only estimated (content-visibility:
 * auto in styles.css), so a position measured before scrolling is wrong by the
 * time the scroll gets there: the blocks it passes get their real height on
 * the way. This keeps aiming at the element while the scroll runs and puts it
 * in place once it stops, until the page holds still or the reader scrolls.
 *
 *   TeXglassScroll.to(pane, el, { align: 'start' | 'center', offset: 16, smooth: true, done() {} });
 *
 * `done` runs once the scroll has finished, or the reader has taken over.
 *
 * A smooth scroll to something far away would sweep through the whole
 * document on the way, which is slow and hard to watch. So a far target is
 * reached by jumping (instantly) to just short of it, then gliding the last
 * stretch, which keeps a sense of direction without the long ride.
 *
 * Every such jump (a reference, an entry in Contents or the map, Go to, the
 * next note…) remembers where the reader was, so they can go back there and
 * forward again, as in a browser:
 *
 *   const h = TeXglassScroll.history(pane, { keys: window });  // a Back button over the pane, Alt+Left / Alt+Right
 *   h.back(); h.forward(); h.clear();
 *   TeXglassScroll.remember(pane);  // for a jump made without to()
 *
 * Pass { history: false } to to() for a scroll that is not a jump (following
 * the editor, say). A place is kept as the block at the top of the pane and how
 * far into it, not as a scroll offset, since blocks off screen have estimated
 * heights and offsets drift as they are shown.
 */
(function (root) {
  'use strict';

  const running = new WeakMap(); // pane -> stop() of the scroll under way

  function to(pane, el, opts) {
    const o = Object.assign({ align: 'start', offset: 16, smooth: true, history: true }, opts);
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
    const gap = aim - pane.scrollTop;
    // A jump to something already on screen is not worth going back from.
    if (o.history && Math.abs(gap) > pane.clientHeight / 2) remember(pane);
    const near = pane.clientHeight * 0.75; // how much of the way to glide
    if (o.smooth && Math.abs(gap) > near * 2) {
      pane.scrollTop = Math.round(aim - Math.sign(gap) * near);
      aim = dest(); // blocks around the new spot now have their real heights
    }
    pane.scrollTo({ top: aim, behavior: o.smooth ? 'smooth' : 'auto' });

    const start = Date.now();
    let lastMove = start;
    let lastTop = pane.scrollTop;
    let still = 0;
    let frame = 0;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((t) => pane.removeEventListener(t, stop));
      if (running.get(pane) === stop) running.delete(pane);
      if (o.done) o.done();
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

  // --- going back and forward ------------------------------------------------

  const LIMIT = 100;
  const trails = new WeakMap(); // pane -> { back: [places], fwd: [places], watchers: [fn] }
  function trail(pane) {
    let t = trails.get(pane);
    if (!t) trails.set(pane, (t = { back: [], fwd: [], watchers: [] }));
    return t;
  }
  const changed = (t) => t.watchers.forEach((f) => f());

  const shown = (el) => !!(el && el.isConnected && (!el.getClientRects || el.getClientRects().length));

  /** Where the reader is: the first block reaching below the top of the pane, and how far into it. */
  function placeOf(pane) {
    const place = { top: pane.scrollTop, el: null, off: 0 };
    if (!pane.querySelectorAll) return place;
    const blocks = pane.querySelectorAll('.src-block');
    const top = pane.getBoundingClientRect().top;
    // the first block whose bottom is below the top; blocks folded away (no
    // box) are skipped over, looking at the next one that shows
    const rectAt = (i) => {
      for (let j = i; j < blocks.length; j++) {
        const r = blocks[j].getBoundingClientRect();
        if (r.height) return { j, r };
      }
      return null;
    };
    let lo = 0;
    let hi = blocks.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = rectAt(mid);
      if (!at) hi = mid - 1;
      else if (at.r.bottom > top) { k = at.j; hi = mid - 1; } else lo = at.j + 1;
    }
    if (k >= 0) {
      place.el = blocks[k];
      place.off = Math.round(blocks[k].getBoundingClientRect().top - top);
    }
    return place;
  }
  const near = (pane, a, b) => (a.el && a.el === b.el ? Math.abs(a.off - b.off) : Math.abs(a.top - b.top)) < pane.clientHeight / 3;

  /** Remember where the reader is now, before a jump; forgets the way forward. */
  function remember(pane) {
    const t = trail(pane);
    const here = placeOf(pane);
    const last = t.back[t.back.length - 1];
    if (!last || !near(pane, last, here)) t.back.push(here);
    if (t.back.length > LIMIT) t.back.shift();
    t.fwd = [];
    changed(t);
  }

  function goTo(pane, place) {
    if (shown(place.el)) to(pane, place.el, { align: 'start', offset: place.off, history: false });
    else {
      if (running.has(pane)) running.get(pane)();
      pane.scrollTo({ top: place.top, behavior: 'auto' });
    }
  }
  /** Back (dir -1) or forward (dir 1) along the trail; false when there is nowhere to go. */
  function step(pane, dir) {
    const t = trail(pane);
    const from = dir < 0 ? t.back : t.fwd;
    const into = dir < 0 ? t.fwd : t.back;
    const here = placeOf(pane);
    let place = from.pop();
    // skip a place the reader has scrolled back to by hand
    while (place && near(pane, place, here) && from.length) place = from.pop();
    if (!place || near(pane, place, here)) { changed(t); return false; }
    into.push(here);
    goTo(pane, place);
    changed(t);
    return true;
  }

  const ARROW_BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ARROW_FWD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /**
   * Back and forward for a pane: a small Back (and Forward) button over its top
   * left corner once a jump has happened, and, with { keys: window }, Alt+Left
   * and Alt+Right (not while typing in a text box).
   */
  function history(pane, opts) {
    const o = opts || {};
    const t = trail(pane);
    const doc = pane.ownerDocument;
    const win = doc.defaultView;
    const api = {
      back: () => step(pane, -1),
      forward: () => step(pane, 1),
      canBack: () => t.back.length > 0,
      canForward: () => t.fwd.length > 0,
      clear() { t.back = []; t.fwd = []; changed(t); },
    };

    const bar = doc.createElement('div');
    bar.className = 'tg-history';
    bar.hidden = true;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Back and forward');
    bar.innerHTML =
      `<button type="button" class="tg-history-back" title="Back to where you were before the jump (Alt+Left)" aria-keyshortcuts="Alt+ArrowLeft">${ARROW_BACK}<span>Back</span></button>` +
      `<button type="button" class="tg-history-fwd" title="Forward again (Alt+Right)" aria-label="Forward" aria-keyshortcuts="Alt+ArrowRight">${ARROW_FWD}</button>`;
    const backBtn = bar.querySelector('.tg-history-back');
    const fwdBtn = bar.querySelector('.tg-history-fwd');
    backBtn.addEventListener('click', api.back);
    fwdBtn.addEventListener('click', api.forward);
    bar.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus where it is
    doc.body.appendChild(bar);

    // Over the pane's top left corner, wherever the pane is.
    const placeBar = () => {
      if (bar.hidden) return;
      const r = pane.getBoundingClientRect();
      bar.style.left = Math.round(r.left + 10) + 'px';
      bar.style.top = Math.round(r.top + 10) + 'px';
    };
    let fade = 0;
    const update = () => {
      const show = t.back.length > 0 || t.fwd.length > 0;
      backBtn.disabled = !t.back.length;
      fwdBtn.hidden = !t.fwd.length;
      bar.hidden = !show;
      placeBar();
      // bright for a moment after a jump, then out of the way until pointed at
      bar.classList.add('tg-history-fresh');
      clearTimeout(fade);
      fade = setTimeout(() => bar.classList.remove('tg-history-fresh'), 4000);
    };
    t.watchers.push(update);
    if (win.ResizeObserver) new win.ResizeObserver(placeBar).observe(pane);
    win.addEventListener('resize', placeBar);

    if (o.keys) {
      o.keys.addEventListener('keydown', (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const el = e.target;
        if (el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
        e.preventDefault(); // not the browser's own Back, which would leave the page
        if (e.key === 'ArrowLeft') api.back();
        else api.forward();
      });
    }
    return api;
  }

  const api = { to, remember, history };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassScroll = api;
})(typeof self !== 'undefined' ? self : this);
