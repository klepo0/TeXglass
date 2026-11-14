/* Zooming the document (not the toolbar) in the web viewer and the VS Code preview.
 *
 * The zoom is a factor in the CSS variable --zoom, which styles.css multiplies
 * into the document's font size and text width. Everything in the document is
 * sized in em (headings, KaTeX formulas, TikZ pictures), so it all grows
 * together; diagrams are laid out again for the new size. Printing ignores it.
 *
 *   const zoom = TeXglassZoom.create({ pane, onChange(level) {...} });
 *   zoom.set(1.25); zoom.step(1); zoom.step(-1); zoom.reset();
 */
(function (root) {
  'use strict';

  const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const MIN = LEVELS[0];
  const MAX = LEVELS[LEVELS.length - 1];

  const clamp = (z) => Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100));

  /** The next level up (dir 1) or down (dir -1) from z. */
  function next(z, dir) {
    if (dir > 0) return LEVELS.find((l) => l > z + 0.001) || MAX;
    for (let k = LEVELS.length - 1; k >= 0; k--) if (LEVELS[k] < z - 0.001) return LEVELS[k];
    return MIN;
  }

  /** Parse a stored level, or 1 if it is not one. */
  function parse(v) {
    const z = parseFloat(v);
    return isFinite(z) && z > 0 ? clamp(z) : 1;
  }

  const label = (z) => `${Math.round(z * 100)}%`;

  function create(opts) {
    const pane = opts.pane; // the element that scrolls the document
    const style = (opts.root || document.documentElement).style;
    let level = 1;
    let redraw = 0;

    // The block at the top of the pane, and how far into it the pane is
    // scrolled (as a fraction), so the same text is at the top after zooming.
    function anchor() {
      const top = pane.getBoundingClientRect().top;
      const doc = opts.document || pane.querySelector('.document') || pane;
      // The blocks are in order down the page: find the first one whose
      // bottom is below the top of the pane by halving (documents have tens of
      // thousands of blocks).
      const kids = doc.children;
      let lo = 0;
      let hi = kids.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (kids[mid].getBoundingClientRect().bottom > top) hi = mid;
        else lo = mid + 1;
      }
      for (let k = lo; k < kids.length; k++) {
        const r = kids[k].getBoundingClientRect();
        if (r.height > 0) return { el: kids[k], at: (top - r.top) / r.height };
      }
      return null;
    }

    function apply(z, keep) {
      const a = keep !== false && pane ? anchor() : null;
      const frac = pane && pane.scrollHeight > pane.clientHeight ? pane.scrollTop / (pane.scrollHeight - pane.clientHeight) : 0;
      level = z;
      if (z === 1) style.removeProperty('--zoom');
      else style.setProperty('--zoom', String(z));
      if (pane && keep !== false) {
        if (a && a.el.isConnected) {
          const r = a.el.getBoundingClientRect();
          pane.scrollTop += r.top + a.at * r.height - pane.getBoundingClientRect().top;
        } else if (frac) {
          pane.scrollTop = frac * (pane.scrollHeight - pane.clientHeight);
        }
      }
      // Commutative diagrams and TikZ pictures are drawn in pixels: draw them
      // again once the new size has settled.
      clearTimeout(redraw);
      redraw = setTimeout(() => { if (root.TeXglassDiagrams) root.TeXglassDiagrams.refresh(); }, 60);
    }

    const api = {
      get level() { return level; },
      label: () => label(level),
      /** Set the zoom; quiet: do not report it (when restoring a saved level). */
      set(z, quiet) {
        z = clamp(z);
        if (z === level) return level;
        apply(z, !quiet);
        if (!quiet && opts.onChange) opts.onChange(level);
        return level;
      },
      step(dir) { return api.set(next(level, dir)); },
      reset() { return api.set(1); },
    };
    return api;
  }

  /** Ctrl/Cmd with + (or =), - and 0, as in browsers: 1, -1, 0, or null. */
  function keyStep(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 1;
    if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return -1;
    if (e.key === '0' || e.code === 'Numpad0') return 0;
    return null;
  }

  const api = { create, next, parse, label, keyStep, LEVELS, MIN, MAX };
  root.TeXglassZoom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
