/* TeXglass: the reader's own width for the text column.
 *
 * Grips on both edges of the text: dragging one widens or narrows the column (it stays
 * centred, so it changes by twice the drag), double-click goes back to the usual width,
 * the arrow keys move a focused grip, and dragging to the pane's edge lets the text fill
 * the pane. The width is kept in px at 100% zoom, so zooming scales it.
 *
 * Shared by the web viewer (app.js), the VS Code preview (vscode/media/preview.js) and the
 * Overleaf panel (browser/src/overleaf-panel.js). The page's stylesheet does the layout:
 * it reads --tg-text-width (on `root`) and the class tg-text-full (on `root`).
 */
(function (global) {
  'use strict';

  const GRIP = 10; // px

  /** A stored value ('', 'full' or a number of px) as a width: a number, 'full' or null. */
  function parse(v) {
    if (v === 'full') return 'full';
    const n = parseFloat(v);
    return n > 0 && isFinite(n) ? n : null;
  }

  /** The room styles.css gives src/margin.js's column beside the text (#preview.tg-with-margin). */
  function marginExtra(doc) {
    const c = doc.classList;
    if (!c.contains('tg-with-margin') || c.contains('tg-margin-overlay')) return 0;
    if (c.contains('tg-margin-collapsed')) return 28;
    return (parseFloat(doc.style.getPropertyValue('--tg-margin-w')) || 200) + 28;
  }

  /**
   * opts: {
   *   doc: the text column (#preview), pane: the scrolling pane that holds it,
   *   root: where the CSS variable and class go (default: <html>),
   *   store: { get() -> string|null, set(string) }, the remembered width ('', 'full', '860'),
   *   usual: the usual width in px (760), min: the narrowest on screen (240),
   *   extra: () -> px of the column's box that is not text (default: the margin-notes
   *          column of src/margin.js, as styles.css lays it out),
   *   avoid: elements that can be drawn over the pane (a side panel drawer): no grip under them,
   * }
   * Returns { set(width, save), get(), place() }.
   */
  function attach(opts) {
    const doc = opts.doc;
    const pane = opts.pane;
    const root = opts.root || document.documentElement;
    const store = opts.store || { get: () => null, set: () => {} };
    const usual = opts.usual || 760;
    const MIN = opts.min || 240;
    const extra = opts.extra || (() => marginExtra(doc));
    const avoid = opts.avoid || [];
    let current = null;

    const zoomNow = () => parseFloat(getComputedStyle(doc).getPropertyValue('--zoom')) || 1;

    const grips = ['left', 'right'].map((side) => {
      const g = document.createElement('div');
      g.className = 'text-resizer text-resizer-' + side;
      g.dataset.side = side;
      g.setAttribute('role', 'separator');
      g.setAttribute('aria-orientation', 'vertical');
      g.setAttribute('aria-label', 'Text width');
      g.tabIndex = 0;
      g.title = 'Drag to change the text width · double-click for the usual width';
      g.hidden = true;
      pane.appendChild(g);
      return g;
    });

    /** Apply a width: a number (px at 100% zoom), 'full', or null for the usual width. */
    function set(w, save) {
      const full = w === 'full';
      current = full ? 'full' : typeof w === 'number' && isFinite(w) ? Math.round(w) : null;
      if (typeof current === 'number') root.style.setProperty('--tg-text-width', current + 'px');
      else root.style.removeProperty('--tg-text-width');
      root.classList.toggle('tg-text-full', full);
      if (save) store.set(full ? 'full' : current == null ? '' : String(current));
      place();
    }

    /** The text's width on screen: the column's box without the margin-notes column. */
    const textPx = () => doc.getBoundingClientRect().width - extra();

    /** The width the text would get for a drag to `px` on screen: a number, or 'full'. */
    function widthFor(px) {
      const room = pane.clientWidth - extra();
      if (px >= room - 24) return 'full'; // close to the pane's edges: fill it
      return Math.max(Math.min(MIN, room), px) / zoomNow();
    }

    function covered(x, top, bottom) {
      return avoid.some((el) => {
        if (!el || el.hidden || !el.getClientRects().length) return false;
        const o = el.getBoundingClientRect();
        return o.width > 0 && x < o.right && x + GRIP > o.left && top < o.bottom && bottom > o.top;
      });
    }

    function place() {
      const r = doc.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      const right = p.left + pane.clientLeft + pane.clientWidth; // the scrollbar is not text
      const show = r.width > 0 && !doc.hidden;
      grips.forEach((g) => {
        // Inside the column's padding, so a grip never covers the scrollbar.
        const x = g.dataset.side === 'left' ? Math.max(r.left, p.left) : Math.min(r.right, right) - GRIP;
        g.hidden = !show || covered(x, p.top, p.bottom);
        if (g.hidden) return;
        g.style.left = Math.round(x) + 'px';
        g.style.top = Math.round(p.top) + 'px';
        g.style.height = Math.round(p.height) + 'px';
        g.setAttribute('aria-valuenow', String(Math.round(r.width - extra())));
      });
    }

    grips.forEach((g) => {
      const sign = g.dataset.side === 'left' ? -1 : 1;
      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (g.setPointerCapture) g.setPointerCapture(e.pointerId);
        const start = e.clientX;
        const width = textPx();
        document.body.classList.add('text-resizing');
        const move = (ev) => set(widthFor(width + 2 * sign * (ev.clientX - start)), false);
        const up = () => {
          g.removeEventListener('pointermove', move);
          g.removeEventListener('pointerup', up);
          g.removeEventListener('pointercancel', up);
          document.body.classList.remove('text-resizing');
          set(current === 'full' ? 'full' : textPx() / zoomNow(), true);
        };
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerup', up);
        g.addEventListener('pointercancel', up);
      });
      g.addEventListener('dblclick', () => set(null, true));
      g.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const grow = (e.key === 'ArrowRight') === (sign > 0);
        set(widthFor(textPx() + (grow ? 40 : -40)), true);
      });
    });

    set(parse(store.get()), false);
    if (global.ResizeObserver) {
      const ro = new ResizeObserver(() => place());
      ro.observe(pane);
      ro.observe(doc);
      avoid.forEach((el) => el && ro.observe(el)); // a drawer opening or closing
    }
    // ...and once it has slid into place
    avoid.forEach((el) => el && ['animationend', 'transitionend'].forEach((t) => el.addEventListener(t, place)));
    global.addEventListener('resize', place);

    return { set, get: () => current, place };
  }

  global.TeXglassTextWidth = { attach, parse };
})(typeof window !== 'undefined' ? window : globalThis);
