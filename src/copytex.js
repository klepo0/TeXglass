/* Click a formula to copy its LaTeX, in the web viewer and the VS Code preview.
 *
 * The converter puts each formula's source, as written, in a data-tex
 * attribute on its .math element. A plain click on one copies that source and
 * shows "Copied" beside the pointer. Clicks that mean something else are left
 * alone: on a link, with a modifier key held (Ctrl/Cmd+click jumps to the
 * source in VS Code), at the end of a drag that selects text, and the clicks of a double-click
 * (which jumps to the source in VS Code). With `delay` set, the copy waits
 * that long so a double-click can cancel it.
 *
 *   const copier = TeXglassCopyTex.attach({
 *     roots: [preview, popover],          // where formulas can be clicked
 *     write(text) { ... },                // optional; defaults to the clipboard
 *     delay: 0,                           // ms to wait for a second click
 *   });
 *   copier.setEnabled(false);             // e.g. while clicks edit the page
 */
(function (root) {
  'use strict';

  /** The formula a click on `target` should copy, or null. */
  function formulaAt(target) {
    if (!target || !target.closest) return null;
    if (target.closest('a, button, input, textarea, .fold-toggle')) return null;
    const el = target.closest('.math[data-tex]');
    return el && el.dataset.tex ? el : null;
  }

  /** Copy text with the async clipboard API, or with a hidden textarea where that is missing or refused. */
  function writeClipboard(text) {
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      const sel = document.getSelection();
      const saved = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (saved && sel) { sel.removeAllRanges(); sel.addRange(saved); }
      return ok ? Promise.resolve() : Promise.reject(new Error('copy refused'));
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(legacy);
    }
    return legacy();
  }

  function attach(opts) {
    const roots = (opts.roots || [opts.root]).filter(Boolean);
    const write = opts.write || writeClipboard;
    const delay = opts.delay || 0;
    let enabled = opts.enabled !== false;
    let pending = null;
    let toast = null;
    let toastTimer = 0;

    const setClass = () => roots.forEach((r) => r.classList.toggle('math-copyable', enabled));
    setClass();

    function showToast(x, y, text, failed) {
      if (!toast) {
        toast = document.createElement('div');
        toast.className = 'copy-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        document.body.appendChild(toast);
      }
      toast.textContent = text;
      toast.classList.toggle('failed', !!failed);
      toast.hidden = false;
      const w = toast.offsetWidth;
      const h = toast.offsetHeight;
      toast.style.left = Math.max(4, Math.min(x - w / 2, window.innerWidth - w - 4)) + 'px';
      toast.style.top = (y - h - 12 > 4 ? y - h - 12 : y + 16) + 'px';
      toast.classList.remove('show');
      void toast.offsetWidth;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.classList.remove('show'); toast.hidden = true; }, 1200);
    }

    function copy(el, x, y) {
      el.classList.remove('copied');
      void el.offsetWidth;
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 700);
      Promise.resolve()
        .then(() => write(el.dataset.tex))
        .then(
          () => showToast(x, y, 'Copied LaTeX'),
          () => showToast(x, y, 'Could not copy', true)
        );
    }

    function onClick(e) {
      if (!enabled || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.detail > 1) { // part of a double-click
        clearTimeout(pending);
        pending = null;
        return;
      }
      const el = formulaAt(e.target);
      if (!el) return;
      // A press here and a release elsewhere is the reader selecting text.
      if (!down || Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4) return;
      const { clientX: x, clientY: y } = e;
      clearTimeout(pending);
      if (delay) pending = setTimeout(() => { pending = null; copy(el, x, y); }, delay);
      else copy(el, x, y);
    }
    let down = null;
    const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
    roots.forEach((r) => {
      r.addEventListener('mousedown', onDown);
      r.addEventListener('click', onClick);
    });

    return {
      setEnabled(on) {
        enabled = !!on;
        if (!enabled) { clearTimeout(pending); pending = null; }
        setClass();
      },
      get enabled() { return enabled; },
      detach() {
        roots.forEach((r) => {
          r.removeEventListener('mousedown', onDown);
          r.removeEventListener('click', onClick);
          r.classList.remove('math-copyable');
        });
        clearTimeout(pending);
        if (toast) toast.remove();
      },
    };
  }

  const api = { attach, formulaAt, writeClipboard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TeXglassCopyTex = api;
})(typeof window !== 'undefined' ? window : this);
