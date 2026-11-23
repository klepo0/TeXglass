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
 * The side panel's Pins tab lists the pin sets (fixed at the top) and the one
 * chosen in its reading order, like the table of contents: TeXglassPins.panel().
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
  const GROUPS = [['result', 'Results'], ['proof', 'Proofs'], ['equation', 'Equations'], ['figure', 'Figures'], ['notation', 'Notation'], ['text', 'Text']];

  /** The row of pin sets: switch, save as, update, delete. sets: insight.pinSets(). */
  function setsHtml(sets, o) {
    o = o || {};
    let html = '<div class="tg-pins-sets" role="group" aria-label="Pin sets">';
    if (sets.length) {
      html += '<span class="tg-pins-sets-k">Sets</span>' + sets.map((x) =>
        `<span class="tg-pins-set${x.on ? ' tg-pins-set-on' : ''}"><button type="button" data-pins-set="${esc(x.name)}" aria-pressed="${x.on}" title="${esc(x.on ? `Pinned now: the ${x.size} of “${x.name}”` : `Pin the ${x.size} of “${x.name}” instead of the pins now`)}">${esc(x.name)}</button>` +
        `<button type="button" class="tg-pins-set-del" data-pins-setdel="${esc(x.name)}" title="Delete this pin set (the pins stay)" aria-label="${esc('Delete the pin set ' + x.name)}">&times;</button></span>`).join('');
    }
    if (o.naming) {
      html += `<span class="tg-pins-set-new"><input type="text" class="tg-pins-set-name" maxlength="80" placeholder="Name this pin set" aria-label="Name for the pin set" value="${esc(o.suggest || '')}">` +
        '<button type="button" data-pins-act="save-ok">Save</button><button type="button" data-pins-act="save-cancel">Cancel</button></span>';
    } else if (o.any) {
      if (o.update) html += `<button type="button" class="tg-pins-set-update" data-pins-act="update" title="${esc(`Keep the pins now under “${o.update}”, instead of what it held`)}">Update “${esc(o.update)}”</button>`;
      html += '<button type="button" data-pins-act="save" title="Keep everything pinned now, with its order, under a name: a pin set to switch back to later (saved with your notes)">Save as set…</button>';
    }
    return html + '</div>';
  }

  /** One row's label. */
  function labelHtml(x) {
    const kind = x.kind;
    if (kind === 'text') return `<span class="tg-pins-quote">“${esc(x.name.length > 90 ? x.name.slice(0, 88) + '…' : x.name)}”</span>`;
    if (kind === 'notation') {
      return (x.tex ? `<span class="tg-pins-sym" data-sym="${esc(x.tex)}"><code>${esc(x.tex)}</code></span>` : '') +
        (x.code ? ` <code class="tg-pins-code">${esc(x.code)}</code>` : x.tex ? '' : `<code>${esc(x.name)}</code>`);
    }
    return `<span class="tg-pins-name">${esc(x.name)}</span>` + (x.note ? ` <span class="tg-pins-note">(${esc(x.note)})</span>` : '') +
      (ALONG[x.d] ? ` <span class="tg-pins-along">${ALONG[x.d]}</span>` : '');
  }

  const DRAG = '<svg viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></g></svg>';
  const PEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.6L10.8 3.2a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7L5.6 12.4z M9.8 4.2l2 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';

  /** One row: (drag handle), the item (a click jumps to it), its note, ✎ and ×. */
  function rowHtml(x, o) {
    const what = x.kind === 'notation' ? (x.code || x.tex || x.name) : x.kind === 'text' ? 'the passage' : x.name;
    const memo = x.memo || '';
    const editing = o.editing === x.key;
    return `<div class="tg-pins-row${o.order ? ' tg-pins-ordered' : ''}" data-key="${esc(x.key)}">` +
      (o.order ? `<button type="button" class="tg-pins-drag" data-pins-drag="${esc(x.key)}" title="Drag to change the reading order (or ↑ ↓ on the keyboard)" aria-label="${esc(`Move ${what} in the reading order: arrow keys up or down`)}">${DRAG}</button>` : '') +
      '<div class="tg-pins-main">' +
      `<button type="button" class="tg-pins-go" data-pins-go="${esc(x.key)}"${x.el || x.placed ? '' : ' disabled'} title="${x.el || x.placed ? 'Go to it' : 'Not in this version of the document'}">${labelHtml(x)}</button>` +
      (editing
        ? `<input type="text" class="tg-pins-memo-in" data-pins-memo-in="${esc(x.key)}" maxlength="200" placeholder="A one-line note" aria-label="${esc('Note on ' + what)}" value="${esc(memo)}">`
        : memo ? `<button type="button" class="tg-pins-memo" data-pins-memo="${esc(x.key)}" title="Your note: click to change it">${esc(memo)}</button>` : '') +
      '</div>' +
      `<button type="button" class="tg-pins-pen" data-pins-memo="${esc(x.key)}" title="${memo ? 'Change the note' : 'Add a one-line note'}" aria-label="${esc((memo ? 'Change the note on ' : 'Add a note on ') + what)}">${PEN}</button>` +
      `<button type="button" class="tg-pins-x" data-pins-unpin="${esc(x.key)}" title="Unpin" aria-label="Unpin ${esc(what)}">&times;</button></div>`;
  }

  /**
   * The list's HTML for items from insight.pinnedList() (each with memo, its note).
   * o: { showPinned, pinMore, order (one list in the reading order, else grouped by kind),
   *      sets (insight.pinSets()), naming, suggest, update, editing (the key whose note is being written) }
   */
  function listHtml(items, o) {
    o = o || {};
    const sets = o.sets || [];
    if (!items.length) {
      return '<div class="tg-pins-head"><strong>Nothing pinned yet</strong></div>' +
        (sets.length ? setsHtml(sets, {}) : '') +
        '<p class="tg-pins-empty">Pin a result or a numbered equation with the pin by its corner on the <b>Map</b> (or the pin at an equation’s left, or a figure’s top right), ' +
        'a symbol with the pin on its row in the <b>Notation</b> tab, or anything with the pin on its preview. ' +
        'Select some text to pin it too. Pinned things gather here.</p>' +
        (o.pinMore ? '<div class="tg-pins-actions"><button type="button" data-pins-act="more">Pin results…</button></div>' : '');
    }
    const maps = items.filter((x) => x.kind !== 'notation').length;
    let html = `<div class="tg-pins-head"><strong>Pinned</strong> <span class="tg-pins-count">${items.length}</span>` +
      '<span class="tg-pins-views" role="group" aria-label="List the pins">' +
      `<button type="button" data-pins-view="kind" aria-pressed="${!o.order}" title="Grouped: results, equations, symbols…">By kind</button>` +
      `<button type="button" data-pins-view="order" aria-pressed="${!!o.order}" title="One list in your reading order: drag to reorder">In order</button></span></div>`;
    html += setsHtml(sets, { naming: o.naming, suggest: o.suggest, update: o.update, any: true });
    html += `<div class="tg-pins-list"${o.order ? ' role="list" aria-label="Reading order"' : ''}>`;
    if (o.order) {
      for (const x of items) html += rowHtml(x, o);
    } else {
      for (const [kind, title] of GROUPS) {
        const rows = items.filter((x) => x.kind === kind);
        if (!rows.length) continue;
        html += `<div class="tg-pins-group" role="group" aria-label="${title}"><div class="tg-pins-title">${title}</div>`;
        for (const x of rows) html += rowHtml(x, o);
        html += '</div>';
      }
    }
    html += '</div>';
    if (maps && o.showPinned) {
      html += '<div class="tg-pins-actions"><button type="button" data-pins-act="show" title="Hide the rest of the document: only the pinned results and equations (their proofs folded) and the paragraphs holding pinned text, in a study sheet with your order and notes; print them too">Show only these</button></div>';
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
    const has = (f) => typeof insight[f] === 'function';
    // pin sets carry the pinned passages too
    if (margin && margin.pinnedTextIds && margin.setPinnedTexts && has('setTextPins')) {
      insight.setTextPins({ get: () => margin.pinnedTextIds(), set: (ids) => margin.setPinnedTexts(ids), el: (id) => (margin.textElOf ? margin.textElOf(id) : null) });
    }
    /** Everything pinned, in the reading order (by kind where there is none), each with its note. */
    function allItems() {
      let out = [];
      try { out = insight.pinnedList(); } catch (e) { out = []; }
      for (const t of texts()) out.push({ key: 'text:' + t.id, kind: 'text', id: t.id, name: t.quote.replace(/\s+/g, ' ').trim(), placed: t.placed, el: null });
      const rank = (k) => GROUPS.findIndex((g) => g[0] === k);
      out = out.map((x, i) => [x, i]).sort((a, b) => rank(a[0].kind) - rank(b[0].kind) || a[1] - b[1]).map((p) => p[0]);
      if (has('inReadingOrder')) {
        const byKey = new Map(out.map((x) => [x.key, x]));
        out = insight.inReadingOrder(out.map((x) => x.key)).map((k) => byKey.get(k));
      }
      for (const x of out) x.memo = has('pinNote') ? insight.pinNote(x.key) : '';
      return out;
    }

    // how the list shows: grouped by kind, or one list in the reading order (once there is one)
    let listView = null; // null: by the order's presence
    const inOrder = () => (listView ? listView === 'order' : !!(has('hasPinOrder') && insight.hasPinOrder()));
    let naming = false; // the name of a new pin set is being typed
    let editing = null; // the key whose note is being written

    function refreshBadge() {
      const n = count();
      badge.textContent = n ? String(n > 99 ? '99+' : n) : '';
      badge.hidden = !n;
      const label = n ? `Pinned: ${n} ${n === 1 ? 'thing' : 'things'}` : 'Pinned: nothing yet';
      button.setAttribute('aria-label', label);
      button.title = n ? `${label}. Click to see them all and jump to one` : 'Pinned: results, equations and symbols you pin gather here';
      button.classList.toggle('tg-pins-some', !!n);
      if (opts.hideWhenEmpty) button.hidden = !n && !(has('pinSets') && insight.pinSets().length);
    }

    function fill() {
      items = allItems();
      if (editing && !items.some((x) => x.key === editing)) editing = null;
      const sets = has('pinSets') ? insight.pinSets() : [];
      const act = has('activeSet') ? insight.activeSet() : null;
      menu.innerHTML = listHtml(items, {
        showPinned: !!opts.showPinned, pinMore: !!opts.pinMore, order: inOrder(), sets, naming,
        suggest: naming && has('suggestSetName') ? insight.suggestSetName() : '',
        update: act && !insight.setIsOn(act) ? act : null, editing,
      });
      if (insight.renderSymbols) insight.renderSymbols(menu);
    }
    /** Fill again, keeping the focus where it was (by what it does). */
    function refill(focusSel) {
      fill();
      place();
      const f = focusSel && menu.querySelector(focusSel);
      if (f) { f.focus({ preventScroll: true }); if (f.select && f.tagName === 'INPUT') f.select(); }
    }
    const sel = (attr, v) => `[${attr}="${String(v).replace(/["\\]/g, '\\$&')}"]`;

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
      naming = false;
      editing = null;
      fill();
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
      const first = menu.querySelector('.tg-pins-list button:not(:disabled)') || menu.querySelector('button:not(:disabled)');
      if (first) first.focus({ preventScroll: true });
    }
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (refocus && !button.hidden && button.offsetParent) button.focus({ preventScroll: true });
    }
    const toggle = () => (menu.hidden ? open() : close());

    // --- notes ---
    let quiet = false; // a note is being kept: the list is filled again after
    function saveMemo(input, refillAfter) {
      const key = input.dataset.pinsMemoIn;
      editing = null;
      quiet = true;
      try { if (has('setPinNote')) insight.setPinNote(key, input.value); } finally { quiet = false; }
      if (refillAfter !== false && !menu.hidden) refill(sel('data-pins-memo', key) + '.tg-pins-pen');
    }

    // --- the reading order ---
    const orderKeys = () => Array.from(menu.querySelectorAll('.tg-pins-row')).map((r) => r.dataset.key);
    function moveBy(key, by) {
      const keys = orderKeys();
      const i = keys.indexOf(key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= keys.length) return;
      keys.splice(i, 1);
      keys.splice(j, 0, key);
      insight.setPinOrder(keys);
      refill(sel('data-pins-drag', key));
    }
    let drag = null; // { key, row, pointerId }
    menu.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('[data-pins-drag]');
      if (!h || e.button !== 0) return;
      e.preventDefault();
      const row = h.closest('.tg-pins-row');
      drag = { key: h.dataset.pinsDrag, row, id: e.pointerId, moved: false };
      row.classList.add('tg-pins-dragging');
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* moves still come to the menu */ }
    });
    menu.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const list = drag.row.parentElement;
      for (const r of list.querySelectorAll('.tg-pins-row')) {
        if (r === drag.row) continue;
        const b = r.getBoundingClientRect();
        if (e.clientY > b.top && e.clientY < b.bottom) {
          const after = e.clientY > b.top + b.height / 2;
          if (after && r.nextSibling !== drag.row) { list.insertBefore(drag.row, r.nextSibling); drag.moved = true; }
          else if (!after && r.previousSibling !== drag.row) { list.insertBefore(drag.row, r); drag.moved = true; }
          break;
        }
      }
    });
    const endDrag = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const d = drag;
      drag = null;
      d.row.classList.remove('tg-pins-dragging');
      if (d.moved) { insight.setPinOrder(orderKeys()); refill(sel('data-pins-drag', d.key)); }
    };
    menu.addEventListener('pointerup', endDrag);
    menu.addEventListener('pointercancel', endDrag);

    // --- sets ---
    function saveSet() {
      const inp = menu.querySelector('.tg-pins-set-name');
      if (!inp) return;
      if (insight.saveView(inp.value)) { naming = false; refill('[data-pins-act="save"]'); } else inp.focus();
    }

    button.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    menu.addEventListener('click', (e) => {
      if (e.target.closest('[data-pins-drag]')) return;
      const go = e.target.closest('[data-pins-go]');
      if (go) {
        const x = items.find((it) => it.key === go.dataset.pinsGo);
        if (x && x.kind === 'text') { close(); margin.goTo(x.id); } else if (x && x.el) { close(); opts.jump(x.el); }
        return;
      }
      const memo = e.target.closest('[data-pins-memo]');
      if (memo) { editing = memo.dataset.pinsMemo; refill(sel('data-pins-memo-in', editing)); return; }
      const un = e.target.closest('[data-pins-unpin]');
      if (un) {
        const key = un.dataset.pinsUnpin;
        if (key.startsWith('text:')) margin.unpinText(key.slice(5)); // refreshes the list through the margin's onPins
        else insight.unpinKey(key); // refreshes the list through onPins
        const next = menu.querySelector('.tg-pins-x') || menu.querySelector('button');
        if (next) next.focus({ preventScroll: true });
        return;
      }
      const v = e.target.closest('[data-pins-view]');
      if (v) { listView = v.dataset.pinsView; refill(sel('data-pins-view', listView)); return; }
      const set = e.target.closest('[data-pins-set]');
      if (set) { insight.loadView(set.dataset.pinsSet); refill(sel('data-pins-set', set.dataset.pinsSet)); return; }
      const del = e.target.closest('[data-pins-setdel]');
      if (del) { insight.deleteView(del.dataset.pinsSetdel); refill('[data-pins-act="save"]'); return; }
      const act = e.target.closest('[data-pins-act]');
      if (act) {
        const a = act.dataset.pinsAct;
        if (a === 'save') { naming = true; refill('.tg-pins-set-name'); return; }
        if (a === 'save-cancel') { naming = false; refill('[data-pins-act="save"]'); return; }
        if (a === 'save-ok') { saveSet(); return; }
        if (a === 'update') { const name = insight.activeSet(); if (name) insight.saveView(name); refill(sel('data-pins-set', name)); return; }
        close();
        if (a === 'show' && opts.showPinned) opts.showPinned();
        if (a === 'more' && opts.pinMore) opts.pinMore();
      }
    });
    menu.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.matches('.tg-pins-memo-in')) {
        if (e.key === 'Enter') { e.preventDefault(); saveMemo(t); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const k = editing; editing = null; refill(sel('data-pins-memo', k) + '.tg-pins-pen'); }
        return;
      }
      if (t.matches('.tg-pins-set-name')) {
        if (e.key === 'Enter') { e.preventDefault(); saveSet(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); naming = false; refill('[data-pins-act="save"]'); }
        return;
      }
      if (t.matches('[data-pins-drag]') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveBy(t.dataset.pinsDrag, e.key === 'ArrowUp' ? -1 : 1);
      }
    });
    menu.addEventListener('focusout', (e) => {
      // a note being written is kept when the focus leaves it (not when the list is filled again)
      const t = e.target;
      if (!(t.matches && t.matches('.tg-pins-memo-in') && t.isConnected && editing === t.dataset.pinsMemoIn)) return;
      // onto another button of the list: its click fills the list again (filling now would lose the click)
      const inside = e.relatedTarget && menu.contains(e.relatedTarget);
      saveMemo(t, !inside);
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
      if (menu.hidden || quiet) return;
      // a note being written keeps its text and focus
      const inp = menu.querySelector('.tg-pins-memo-in');
      const keep = inp && doc.activeElement === inp ? { key: inp.dataset.pinsMemoIn, value: inp.value } : null;
      fill();
      place();
      if (keep) {
        const again = menu.querySelector(sel('data-pins-memo-in', keep.key));
        if (again) { again.value = keep.value; again.focus({ preventScroll: true }); }
      }
    }
    if (insight.onPins) insight.onPins(refresh);
    refreshBadge();

    return { open, close, toggle, refresh, isOpen: () => !menu.hidden, menu };
  }

  // --- the Pins tab of the side panel: the pin sets, and one in its reading order ----

  /**
   * The Pins tab's HTML. sets: insight.pinSets(); chosen: the name of the set shown;
   * items: its things in the reading order (insight.setItems, passages named);
   * extra: things pinned now that the set does not hold (to add to it).
   */
  function panelHtml(sets, chosen, items, extra) {
    extra = extra || [];
    if (!sets.length) {
      return '<div class="tg-sets-stuck"><div class="tg-sets-title">Saved sets</div></div>' +
        '<p class="tg-sets-empty">No pin sets yet. Pin results, equations, symbols or text, put them in order in the <b>Pinned</b> list ' +
        '(the pin in the toolbar), and choose <b>Save as set…</b> there. Your sets gather here, each with its reading order.</p>';
    }
    let html = '<div class="tg-sets-stuck"><div class="tg-sets-title">Saved sets</div>' +
      '<div class="tg-sets-list" role="listbox" aria-label="Saved pin sets">' +
      sets.map((x) => `<button type="button" role="option" class="tg-sets-set" data-sets-pick="${esc(x.name)}" aria-selected="${x.name === chosen}">` +
        `<span class="tg-sets-name">${esc(x.name)}</span>` +
        (x.on ? '<span class="tg-sets-now" title="These are the pins now">pinned</span>' : '') +
        `<span class="tg-sets-size" aria-label="${x.size} ${x.size === 1 ? 'thing' : 'things'}">${x.size}</span></button>`).join('') +
      '</div></div>';
    const set = sets.find((x) => x.name === chosen);
    if (!set) return html;
    html += '<div class="tg-sets-order"><div class="tg-sets-head"><span class="tg-sets-title">Reading order</span>' +
      (set.on
        ? '<span class="tg-sets-on">Pinned now</span>'
        : `<button type="button" class="tg-sets-pin" data-sets-act="pin" title="${esc(`Pin the ${set.size} of “${set.name}” instead of the pins now`)}">Pin these</button>`) +
      '</div>';
    const what = (x) => (x.kind === 'notation' ? (x.code || x.tex || x.name) : x.kind === 'text' ? 'the passage' : x.name);
    if (!items || !items.length) html += '<p class="tg-sets-empty">Nothing of this set is in this version of the document.</p>';
    else {
      const out = set.on ? 'Take it out of this set (and unpin it)' : 'Take it out of this set';
      html += `<ol class="toc-list tg-sets-steps" aria-label="${esc(`Reading order of “${set.name}”`)}">` + items.map((x, i) => {
        const there = !!(x.el || x.placed);
        return `<li class="tg-sets-row"><a href="#" class="tg-sets-step${there ? '' : ' tg-sets-gone'}" data-sets-go="${i}"${there ? '' : ' aria-disabled="true" title="Not in this version of the document"'}>` +
          `<span class="toc-num">${i + 1}</span><span class="toc-title">${labelHtml(x)}` +
          (x.memo ? `<span class="tg-sets-memo">${esc(x.memo)}</span>` : '') + '</span></a>' +
          `<button type="button" class="tg-sets-x" data-sets-out="${esc(x.key)}" title="${out}" aria-label="${esc(`Take ${what(x)} out of “${set.name}”`)}">&times;</button></li>`;
      }).join('') + '</ol>';
    }
    // what is pinned now and not in the set: add it
    if (extra.length) {
      html += '<div class="tg-sets-add"><div class="tg-sets-head"><span class="tg-sets-title">Pinned, not in this set</span>' +
        (extra.length > 1 ? `<button type="button" class="tg-sets-pin" data-sets-act="add-all" title="${esc(`Add all ${extra.length} to “${set.name}”`)}">Add all</button>` : '') + '</div>' +
        '<ul class="toc-list tg-sets-extra">' + extra.map((x) =>
          `<li class="tg-sets-row"><button type="button" class="tg-sets-plus" data-sets-add="${esc(x.key)}" title="${esc(`Add to “${set.name}” (at the end of its order)`)}" aria-label="${esc(`Add ${what(x)} to “${set.name}”`)}">+</button>` +
          `<span class="toc-title">${labelHtml(x)}</span></li>`).join('') + '</ul></div>';
    } else {
      html += '<p class="tg-sets-hint">To add to this set, pin something (on the map, the text or a preview): it shows here with a <b>+</b>.</p>';
    }
    return html + '</div>';
  }

  /**
   * Fill the side panel's Pins tab (TeXglassInsight.sidePanel's pinsTab).
   *   TeXglassPins.panel({ body, insight, margin, jump(el), onJump() }) → { show(), hide(), refresh() }
   */
  function panel(opts) {
    const body = opts.body;
    const insight = opts.insight;
    if (!body || !insight || !insight.pinSets || !insight.setItems) return null;
    const margin = opts.margin || null;
    let shown = false;
    let chosen = null; // the set shown (the one opened or saved last, at first)
    let items = [];
    let extra = []; // pinned now, not in the chosen set

    function nameText(x) {
      if (x.kind !== 'text') return x;
      const t = margin && margin.textOf ? margin.textOf(x.id) : null;
      return Object.assign(x, { name: t ? t.quote.replace(/\s+/g, ' ').trim() : 'A passage no longer in your notes', placed: !!(t && t.placed) });
    }
    function fill() {
      if (!shown) return;
      let sets = [];
      try { sets = insight.pinSets(); } catch (e) { sets = []; }
      if (!sets.some((x) => x.name === chosen)) {
        const act = sets.find((x) => x.active) || sets.find((x) => x.on) || sets[0];
        chosen = act ? act.name : null;
      }
      try { items = chosen ? (insight.setItems(chosen) || []).map(nameText) : []; } catch (e) { items = []; }
      extra = [];
      if (chosen) {
        const inSet = new Set(items.map((x) => x.key));
        let now = [];
        try { now = insight.pinnedList(); } catch (e) { now = []; }
        try { for (const t of margin && margin.pinnedTexts ? margin.pinnedTexts() : []) now.push({ key: 'text:' + t.id, kind: 'text', id: t.id, name: t.quote.replace(/\s+/g, ' ').trim(), placed: t.placed }); } catch (e) { /* no passages */ }
        const keys = insight.inReadingOrder ? insight.inReadingOrder(now.map((x) => x.key)) : now.map((x) => x.key);
        const byKey = new Map(now.map((x) => [x.key, x]));
        extra = keys.map((k) => byKey.get(k)).filter((x) => x && !inSet.has(x.key));
      }
      const top = body.closest('.toc-pane') || body;
      const keep = top.scrollTop;
      body.innerHTML = panelHtml(sets, chosen, items, extra);
      top.scrollTop = keep;
      if (insight.renderSymbols) insight.renderSymbols(body);
    }

    body.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-sets-pick]');
      if (pick) {
        chosen = pick.dataset.setsPick;
        fill();
        const again = body.querySelector(`[data-sets-pick="${chosen.replace(/["\\]/g, '\\$&')}"]`);
        if (again) again.focus({ preventScroll: true });
        return;
      }
      const go = e.target.closest('[data-sets-go]');
      if (go) {
        e.preventDefault();
        const x = items[Number(go.dataset.setsGo)];
        if (!x) return;
        if (x.kind === 'text') { if (!margin || !margin.goTo || !margin.goTo(x.id)) return; } else if (x.el) opts.jump(x.el); else return;
        body.querySelectorAll('.tg-sets-step.active').forEach((a) => a.classList.remove('active'));
        go.classList.add('active');
        if (opts.onJump) opts.onJump();
        return;
      }
      const out = e.target.closest('[data-sets-out]');
      if (out && chosen && insight.editSet) {
        const i = items.findIndex((x) => x.key === out.dataset.setsOut);
        insight.editSet(chosen, { remove: [out.dataset.setsOut] });
        fill();
        // the focus goes to the next row's × (or the previous one's)
        const xs = body.querySelectorAll('[data-sets-out]');
        const next = xs[Math.min(i, xs.length - 1)] || body.querySelector('[data-sets-pick]');
        if (next) next.focus({ preventScroll: true });
        return;
      }
      const add = e.target.closest('[data-sets-add]');
      if (add && chosen && insight.editSet) {
        insight.editSet(chosen, { add: [add.dataset.setsAdd] });
        fill();
        const next = body.querySelector('[data-sets-add]') || body.querySelector('[data-sets-out]');
        if (next) next.focus({ preventScroll: true });
        return;
      }
      const act = e.target.closest('[data-sets-act]');
      if (act && chosen && act.dataset.setsAct === 'pin') { insight.loadView(chosen); fill(); }
      if (act && chosen && act.dataset.setsAct === 'add-all' && insight.editSet) { insight.editSet(chosen, { add: extra.map((x) => x.key) }); fill(); }
    });
    // ↑ ↓ move between the sets (a listbox)
    body.addEventListener('keydown', (e) => {
      const b = e.target.closest && e.target.closest('[data-sets-pick]');
      if (!b || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      const all = Array.from(body.querySelectorAll('[data-sets-pick]'));
      const next = all[all.indexOf(b) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      next.click();
    });
    if (insight.onPins) insight.onPins(fill);

    return {
      show() { shown = true; fill(); },
      hide() { shown = false; },
      refresh: fill,
    };
  }

  // --- the study sheet (Show only these) and Share links ---------------------------

  /** The pins as Show only these lists them: [{ el, name, note }] in the reading order (not Notation rows). */
  function sheet(insight, margin) {
    if (!insight || !insight.pinnedList) return [];
    let items = [];
    try { items = insight.pinnedList().filter((x) => x.kind !== 'notation'); } catch (e) { items = []; }
    const texts = margin && margin.pinnedTexts ? margin.pinnedTexts() : [];
    for (const t of texts) {
      // a passage over several paragraphs: the first is where it goes, the rest come with it
      const els = margin.textElsOf ? margin.textElsOf(t.id) : [margin.textElOf ? margin.textElOf(t.id) : null];
      items.push({ key: 'text:' + t.id, kind: 'text', name: '“' + clip(t.quote) + '”', el: els[0] || null, more: els.slice(1) });
    }
    const byKey = new Map(items.map((x) => [x.key, x]));
    const keys = insight.inReadingOrder ? insight.inReadingOrder(items.map((x) => x.key)) : items.map((x) => x.key);
    return keys.map((k) => byKey.get(k)).filter((x) => x && x.el).map((x) => ({ el: x.el, more: x.more || [], name: x.name, note: insight.pinNote ? insight.pinNote(x.key) : '', key: x.key }));
  }
  const clip = (q) => { const t = String(q).replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 68) + '…' : t; };

  /**
   * What a Share link adds to Show only these (src/share.js): r the reading order,
   * n the notes, s the pin set showing. texts: margin.sharedTexts() as they go in
   * the link (their place there names them: 't<i>').
   */
  function shareFields(insight, texts) {
    const ref = new Map((texts || []).map((t, i) => ['text:' + t.id, 't' + i]));
    const keys = (insight.pinEntries ? insight.pinEntries().map((e) => e[0]) : []).concat(Array.from(ref.keys()));
    const out = { r: [], n: {} };
    if (insight.hasPinOrder && insight.hasPinOrder()) out.r = insight.inReadingOrder(keys).map((k) => ref.get(k) || k);
    for (const k of keys) { const n = insight.pinNote ? insight.pinNote(k) : ''; if (n) out.n[ref.get(k) || k] = n; }
    const set = insight.activeSet && insight.activeSet();
    if (set && insight.setIsOn(set)) out.s = set;
    return out;
  }

  /**
   * The study sheet of a view that came in a link: [{ el, name, note }].
   * how: { elOf(key), textEl(t) or textEls(t) (every block it runs through), nameOf(key) }.
   */
  function sharedSheet(v, how) {
    const refs = v.p.map((e) => e[0]).concat(v.t.map((t, i) => 't' + i));
    const order = (v.r || []).concat(refs.filter((r) => !(v.r || []).includes(r)));
    const out = [];
    for (const r of order) {
      const m = /^t(\d+)$/.exec(r);
      const t = m ? v.t[+m[1]] : null;
      const els = t ? (how.textEls ? how.textEls(t) : [how.textEl(t)]) : [how.elOf(r)];
      const el = els[0];
      if (el) out.push({ el, more: els.slice(1).filter(Boolean), name: t ? '“' + clip(t.q) + '”' : how.nameOf(r), note: (v.n || {})[r] || '' });
    }
    return out;
  }

  return { attach, panel, panelHtml, listHtml, setsHtml, sheet, shareFields, sharedSheet, ICON };
});
