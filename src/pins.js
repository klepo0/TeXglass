/*
 * The pin button: one place for everything pinned. A pin icon (in the toolbar of
 * the web viewer and the Overleaf panel; floating at the top of the VS Code
 * preview) shows how many things are pinned; a click lists them, results and
 * numbered equations pinned on the map (or from their previews), rows pinned in
 * the Notation tab (or from a notation preview), and text pinned from the bar
 * that appears on a selection.
 * A click on an item jumps to it; × unpins it. "Show only these" shows only the
 * pinned results and equations (src/pick.js).
 *
 *   const pins = TeXglassPins.attach({
 *     button,             // the pin button (a badge with the count is added to it)
 *     insight,            // TeXglassInsight.attach(...): it keeps the pins
 *     margin,             // optional: TeXglassMargin.attach(...), for text pinned from the
 *                         //   selection bar (call pins.refresh() from its onPins)
 *     jump(el),           // scroll to a block
 *     showPinned(),       // optional: show only the pinned results ("Show only these")
 *     pinMore(),          // optional: start pinning results (with nothing pinned yet)
 *     hideWhenEmpty,      // optional: hide the button while nothing is pinned (VS Code)
 *     onOpen(),           // optional: before the list opens (close other menus)
 *   });
 *   pins.open(); pins.close(); pins.toggle(); pins.refresh();
 *
 * Works in the browser (window.TeXglassPins) and in Node (require), for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassPins = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** The pin, drawn like the Notation tab's and the map's. */
  const ICON = '<svg class="tb-icon tg-pin-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-.9 6.3L18 13.2V15H6v-1.8l3.9-3.9z M12 15v6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/></svg>';

  const ALONG = { uses: 'with what it uses', usedBy: 'with what uses it', both: 'with what it uses and what uses it' };
  const GROUPS = [['result', 'Results'], ['equation', 'Equations'], ['figure', 'Figures'], ['notation', 'Notation'], ['text', 'Text']];

  /** The list's HTML for items from insight.pinnedList(). */
  function listHtml(items, o) {
    o = o || {};
    if (!items.length) {
      return '<div class="tg-pins-head"><strong>Nothing pinned yet</strong></div>' +
        '<p class="tg-pins-empty">Pin a result or a numbered equation with the pin by its corner on the <b>Map</b> (or the pin at an equation’s left, or a figure’s top right), ' +
        'a symbol with the pin on its row in the <b>Notation</b> tab, or anything with the pin on its preview. ' +
        'Select some text to pin it too. Pinned things gather here.</p>' +
        (o.pinMore ? '<div class="tg-pins-actions"><button type="button" data-pins-act="more">Pin results…</button></div>' : '');
    }
    const maps = items.filter((x) => x.kind !== 'notation').length;
    let html = `<div class="tg-pins-head"><strong>Pinned</strong> <span class="tg-pins-count">${items.length}</span></div><div class="tg-pins-list">`;
    for (const [kind, title] of GROUPS) {
      const rows = items.filter((x) => x.kind === kind);
      if (!rows.length) continue;
      html += `<div class="tg-pins-group" role="group" aria-label="${title}"><div class="tg-pins-title">${title}</div>`;
      for (const x of rows) {
        const label = kind === 'text' ? `<span class="tg-pins-quote">“${esc(x.name.length > 90 ? x.name.slice(0, 88) + '…' : x.name)}”</span>`
          : kind === 'notation'
          ? (x.tex ? `<span class="tg-pins-sym" data-sym="${esc(x.tex)}"><code>${esc(x.tex)}</code></span>` : '') +
            (x.code ? ` <code class="tg-pins-code">${esc(x.code)}</code>` : x.tex ? '' : `<code>${esc(x.name)}</code>`)
          : `<span class="tg-pins-name">${esc(x.name)}</span>` + (x.note ? ` <span class="tg-pins-note">(${esc(x.note)})</span>` : '') +
            (ALONG[x.d] ? ` <span class="tg-pins-along">${ALONG[x.d]}</span>` : '');
        const what = kind === 'notation' ? (x.code || x.tex || x.name) : x.name;
        html += `<div class="tg-pins-row" data-key="${esc(x.key)}">` +
          `<button type="button" class="tg-pins-go" data-pins-go="${esc(x.key)}"${x.el || x.placed ? '' : ' disabled'} title="${x.el || x.placed ? 'Go to it' : 'Not in this version of the document'}">${label}</button>` +
          `<button type="button" class="tg-pins-x" data-pins-unpin="${esc(x.key)}" title="Unpin" aria-label="Unpin ${esc(what)}">&times;</button></div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    if (maps && o.showPinned) {
      html += '<div class="tg-pins-actions"><button type="button" data-pins-act="show" title="Hide the rest of the document: only the pinned results and equations (their proofs folded) and the paragraphs holding pinned text; print them too">Show only these</button></div>';
    }
    return html;
  }

  function attach(opts) {
    const button = opts.button;
    const insight = opts.insight;
    if (!button || !insight || !insight.pinnedList) return null;
    const doc = button.ownerDocument;
    const win = doc.defaultView;

    if (!button.querySelector('.tg-pin-icon')) button.insertAdjacentHTML('afterbegin', ICON);
    const badge = doc.createElement('span');
    badge.className = 'tg-pins-badge';
    badge.setAttribute('aria-hidden', 'true');
    button.appendChild(badge);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');

    const menu = doc.createElement('div');
    menu.className = 'tg-pins-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Pinned');
    menu.hidden = true;
    doc.body.appendChild(menu);
    let items = [];

    const margin = opts.margin || null;
    function texts() {
      try { return margin && margin.pinnedTexts ? margin.pinnedTexts() : []; } catch (e) { return []; }
    }
    function count() {
      let n = 0;
      try { n = insight.allPinCount ? insight.allPinCount() : insight.pinnedList().length; } catch (e) { n = 0; }
      return n + texts().length;
    }
    function allItems() {
      let out = [];
      try { out = insight.pinnedList(); } catch (e) { out = []; }
      for (const t of texts()) out.push({ key: 'text:' + t.id, kind: 'text', id: t.id, name: t.quote.replace(/\s+/g, ' ').trim(), placed: t.placed, el: null });
      return out;
    }

    function refreshBadge() {
      const n = count();
      badge.textContent = n ? String(n > 99 ? '99+' : n) : '';
      badge.hidden = !n;
      const label = n ? `Pinned: ${n} ${n === 1 ? 'thing' : 'things'}` : 'Pinned: nothing yet';
      button.setAttribute('aria-label', label);
      button.title = n ? `${label}. Click to see them all and jump to one` : 'Pinned: results, equations and symbols you pin gather here';
      button.classList.toggle('tg-pins-some', !!n);
      if (opts.hideWhenEmpty) button.hidden = !n;
    }

    function fill() {
      items = allItems();
      menu.innerHTML = listHtml(items, { showPinned: !!opts.showPinned, pinMore: !!opts.pinMore });
      if (insight.renderSymbols) insight.renderSymbols(menu);
    }

    function place() {
      // a sheet at the bottom on a phone, or when the button is out of sight (in the "…" menu, now closed)
      const narrow = win.matchMedia && win.matchMedia('(max-width: 480px)').matches;
      const sheet = !!narrow || button.hidden || !button.getClientRects().length;
      menu.classList.toggle('tg-pins-sheet', sheet);
      if (sheet) { menu.style.left = ''; menu.style.top = ''; menu.style.right = ''; return; }
      const r = button.getBoundingClientRect();
      const w = menu.offsetWidth;
      const vw = doc.documentElement.clientWidth;
      menu.style.top = Math.round(r.bottom + 6) + 'px';
      menu.style.left = Math.round(Math.max(8, Math.min(r.right - w, vw - w - 8))) + 'px';
    }

    function open() {
      if (opts.onOpen) opts.onOpen();
      fill();
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
      const first = menu.querySelector('button:not(:disabled)');
      if (first) first.focus({ preventScroll: true });
    }
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (refocus && !button.hidden && button.offsetParent) button.focus({ preventScroll: true });
    }
    const toggle = () => (menu.hidden ? open() : close());

    button.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    menu.addEventListener('click', (e) => {
      const go = e.target.closest('[data-pins-go]');
      if (go) {
        const x = items.find((it) => it.key === go.dataset.pinsGo);
        if (x && x.kind === 'text') { close(); margin.goTo(x.id); } else if (x && x.el) { close(); opts.jump(x.el); }
        return;
      }
      const un = e.target.closest('[data-pins-unpin]');
      if (un) {
        const key = un.dataset.pinsUnpin;
        if (key.startsWith('text:')) margin.unpinText(key.slice(5)); // refreshes the list through the margin's onPins
        else insight.unpinKey(key); // refreshes the list through onPins
        const next = menu.querySelector('.tg-pins-x') || menu.querySelector('button');
        if (next) next.focus({ preventScroll: true });
        return;
      }
      const act = e.target.closest('[data-pins-act]');
      if (act) {
        close();
        if (act.dataset.pinsAct === 'show' && opts.showPinned) opts.showPinned();
        if (act.dataset.pinsAct === 'more' && opts.pinMore) opts.pinMore();
      }
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); close(true); }
    }, true);
    doc.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) close();
    });
    win.addEventListener('resize', () => { if (!menu.hidden) place(); });

    function refresh() {
      refreshBadge();
      if (!menu.hidden) { fill(); place(); }
    }
    if (insight.onPins) insight.onPins(refresh);
    refreshBadge();

    return { open, close, toggle, refresh, isOpen: () => !menu.hidden, menu };
  }

  return { attach, listHtml, ICON };
});
