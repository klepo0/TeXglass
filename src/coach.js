/*
 * The first-run tour ("Show me around"): a few cards that point at TeXglass's
 * own controls, one at a time, with the rest of the page dimmed. It runs once,
 * the first time someone opens the web viewer, the browser extension's viewer
 * or a VS Code preview, and again from Settings or the "…" menu.
 *
 *   const tour = TeXglassCoach.start({
 *     steps: [{
 *       target: () => element or null,  // what the card points at; null: a card in the middle
 *       title: 'Open a paper',
 *       body: 'html',                    // short: one or two sentences
 *       before: () => {},                // optional: get the target ready (open a panel…)
 *       after: () => {},                 // optional: undo that when the step is left
 *       hot: true,                       // optional: the target's own buttons show (.tg-coach-hot)
 *       optional: true,                  // optional: skip this card when nothing to point at is on screen
 *     }, ...],
 *     onEnd: (finished) => {},           // finished: the last card's Done; false: skipped or closed
 *     finish: { label, action },         // optional: a second button on the last card
 *   });
 *   tour.stop(); tour.go(i);
 *
 * Keys: → or Enter next, ← back, Esc ends the tour. On a phone (or any narrow
 * window) the card sits at the bottom of the screen, or at the top when what it
 * points at is down there.
 *
 * Works in the browser (window.TeXglassCoach) and in Node (require), for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassCoach = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const PAD = 6; // room around the lit-up control
  const GAP = 12; // between it and the card
  const EDGE = 10; // the card keeps this far from the window's edges

  /** Is el on screen and drawn (not hidden, not in a closed menu)? */
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  /**
   * Where the card goes (pure, for tests): below the target if it fits, else above,
   * else beside it; on a narrow window, a sheet at the bottom (or top).
   * t: the target's rectangle or null; card: { w, h }; win: { w, h }.
   * Returns { left, top, sheet: 'bottom' | 'top' | '' }.
   */
  function place(t, card, win, narrow) {
    if (narrow) {
      const low = t && t.top + t.height / 2 > win.h * 0.55;
      return { left: 0, top: low ? 0 : win.h - card.h, sheet: low ? 'top' : 'bottom' };
    }
    const clampX = (x) => Math.max(EDGE, Math.min(win.w - card.w - EDGE, x));
    const clampY = (y) => Math.max(EDGE, Math.min(win.h - card.h - EDGE, y));
    if (!t) return { left: clampX((win.w - card.w) / 2), top: clampY((win.h - card.h) / 2), sheet: '' };
    const cx = clampX(t.left + t.width / 2 - card.w / 2);
    if (t.bottom + PAD + GAP + card.h <= win.h - EDGE) return { left: cx, top: t.bottom + PAD + GAP, sheet: '' };
    if (t.top - PAD - GAP - card.h >= EDGE) return { left: cx, top: t.top - PAD - GAP - card.h, sheet: '' };
    const cy = clampY(t.top + t.height / 2 - card.h / 2);
    if (t.right + PAD + GAP + card.w <= win.w - EDGE) return { left: t.right + PAD + GAP, top: cy, sheet: '' };
    if (t.left - PAD - GAP - card.w >= EDGE) return { left: t.left - PAD - GAP - card.w, top: cy, sheet: '' };
    return { left: clampX((win.w - card.w) / 2), top: clampY(win.h - card.h - EDGE), sheet: '' };
  }

  let running = null;

  function start(o) {
    if (running) running.stop();
    const doc = o.document || document;
    const win = doc.defaultView;
    const steps = (o.steps || []).filter(Boolean);
    if (!steps.length) return null;
    const narrowQuery = win.matchMedia ? win.matchMedia('(max-width: 760px)') : null;

    const veil = doc.createElement('div');
    veil.className = 'tg-coach-veil';
    const spot = doc.createElement('div');
    spot.className = 'tg-coach-spot';
    spot.setAttribute('aria-hidden', 'true');
    const card = doc.createElement('div');
    card.className = 'tg-coach-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'tg-coach-title');
    card.setAttribute('aria-describedby', 'tg-coach-body');
    doc.body.append(veil, spot, card);
    doc.documentElement.classList.add('tg-coach-on');

    let i = -1;
    let target = null;
    let hot = null;
    let ended = false;
    let frame = 0;

    function leave() {
      const s = steps[i];
      if (hot) { hot.classList.remove('tg-coach-hot'); hot = null; }
      if (s && s.after) { try { s.after(); } catch (e) { /* the page moved on */ } }
    }

    function go(n) {
      if (ended) return;
      if (n < 0) n = 0;
      if (n >= steps.length) return end(true);
      const dir = n < i ? -1 : 1;
      leave();
      i = n;
      const s = steps[i];
      if (s.before) { try { s.before(); } catch (e) { /* show the card anyway */ } }
      // the target may appear a moment after before() (a panel opening)
      win.requestAnimationFrame(() => {
        if (ended || steps[i] !== s) return;
        let el = null;
        try { el = s.target ? s.target() : null; } catch (e) { el = null; }
        target = visible(el) ? el : null;
        if (!target && s.optional) {
          // nothing to point at: on to the next card (or back, past it); the first card always shows
          const to = i + dir;
          if (to >= 0) { i = to - dir; return go(to); }
        }
        if (target && s.hot) {
          hot = target;
          hot.classList.add('tg-coach-hot');
          // buttons a result only grows when the pointer first comes by (its pin, What does this use?)
          target.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
        }
        if (target && target.scrollIntoView) {
          const r = target.getBoundingClientRect();
          if (r.top < 60 || r.bottom > win.innerHeight - 60) target.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
        draw(s);
        layout();
        const next = card.querySelector('[data-coach="next"]');
        if (next) next.focus({ preventScroll: true });
      });
    }

    function draw(s) {
      const last = i === steps.length - 1;
      const dots = steps.map((_, k) => `<span class="tg-coach-dot${k === i ? ' on' : ''}"></span>`).join('');
      card.innerHTML =
        `<div class="tg-coach-count" aria-label="Step ${i + 1} of ${steps.length}">${dots}</div>` +
        `<h2 id="tg-coach-title" class="tg-coach-title">${esc(s.title)}</h2>` +
        `<div id="tg-coach-body" class="tg-coach-body">${s.body || ''}</div>` +
        '<div class="tg-coach-actions">' +
        (last ? '' : '<button type="button" class="tg-coach-skip link-button" data-coach="skip">Skip the tour</button>') +
        '<span class="tg-coach-grow"></span>' +
        (i > 0 ? '<button type="button" data-coach="back">Back</button>' : '') +
        (last && o.finish ? `<button type="button" data-coach="extra">${esc(o.finish.label)}</button>` : '') +
        `<button type="button" class="primary" data-coach="next">${last ? 'Done' : 'Next'}</button>` +
        '</div>';
    }

    function layout() {
      frame = 0;
      if (ended) return;
      const W = win.innerWidth;
      const H = win.innerHeight;
      const narrow = narrowQuery ? narrowQuery.matches : W <= 760;
      const t = target && target.isConnected ? target.getBoundingClientRect() : null;
      if (t) {
        spot.hidden = false;
        spot.style.left = t.left - PAD + 'px';
        spot.style.top = t.top - PAD + 'px';
        spot.style.width = t.width + 2 * PAD + 'px';
        spot.style.height = t.height + 2 * PAD + 'px';
      } else {
        spot.hidden = true;
      }
      veil.classList.toggle('tg-coach-dim', !t);
      card.classList.toggle('tg-coach-sheet', narrow);
      card.style.left = card.style.top = '';
      const at = place(t, { w: card.offsetWidth, h: card.offsetHeight }, { w: W, h: H }, narrow);
      card.dataset.sheet = at.sheet;
      if (!narrow) {
        card.style.left = Math.round(at.left) + 'px';
        card.style.top = Math.round(at.top) + 'px';
      }
    }
    const relayout = () => { if (!frame) frame = win.requestAnimationFrame(layout); };

    function end(finished) {
      if (ended) return;
      leave();
      ended = true;
      running = null;
      veil.remove(); spot.remove(); card.remove();
      doc.documentElement.classList.remove('tg-coach-on');
      win.removeEventListener('resize', relayout);
      win.removeEventListener('scroll', relayout, true);
      doc.removeEventListener('keydown', onKey, true);
      if (o.onEnd) o.onEnd(!!finished);
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); return; }
      const inCard = card.contains(e.target);
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && !inCard)) { e.preventDefault(); e.stopPropagation(); go(i + 1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(i - 1); return; }
      // the tour keeps the page's own shortcuts (P, J, K, Ctrl+K…) from firing underneath it;
      // the card's buttons still work (Enter and Space act on them by default)
      if (e.key !== 'Tab') e.stopPropagation();
    }

    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-coach]');
      if (!b) return;
      const what = b.dataset.coach;
      if (what === 'next') go(i + 1);
      else if (what === 'back') go(i - 1);
      else if (what === 'skip') end(false);
      else if (what === 'extra') { end(true); o.finish.action(); }
    });
    // a click on the dimmed page does nothing: the tour is ended with its own buttons or Esc
    veil.addEventListener('pointerdown', (e) => e.preventDefault());
    win.addEventListener('resize', relayout);
    win.addEventListener('scroll', relayout, true);
    doc.addEventListener('keydown', onKey, true);

    const api = { stop: () => end(false), go, step: () => i };
    running = api;
    go(0);
    return api;
  }

  return { start, place, visible, running: () => running };
});
