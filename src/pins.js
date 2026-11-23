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
 * The side panel's Pins tab lists the pin sets (fixed at the top) and under them
 * the same pin list, with its tools: TeXglassPins.panel().
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
   *      sets (insight.pinSets()), noSets (leave the sets out: the Pins tab lists them above),
   *      naming, suggest, update, editing (the key whose note is being written),
   *      clearing (asking whether to unpin everything) }
   */
  function listHtml(items, o) {
    o = o || {};
    const sets = o.sets || [];
    if (!items.length) {
      return '<div class="tg-pins-head"><strong>Nothing pinned yet</strong></div>' +
        (sets.length && !o.noSets ? setsHtml(sets, {}) : '') +
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
    // in the side panel's Pins tab the sets are listed above: here only Save as set… and Update
    html += setsHtml(o.noSets ? [] : sets, { naming: o.naming, suggest: o.suggest, update: o.update, any: true });
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
    const show = maps && o.showPinned;
    html += '<div class="tg-pins-actions">' +
      (show ? '<button type="button" data-pins-act="show" title="Hide the rest of the document: only the pinned results and equations (their proofs folded) and the paragraphs holding pinned text, in a study sheet with your order and notes; print them too">Show only these</button>' : '') +
      (o.clearing
        ? `<span class="tg-pins-clear-ask">Unpin all ${items.length}?</span><button type="button" class="tg-pins-clear-yes" data-pins-act="clear-ok">Unpin all</button><button type="button" data-pins-act="clear-cancel">Keep</button>`
        : '<button type="button" class="tg-pins-clear" data-pins-act="clear" title="Unpin everything (your pin sets and notes stay)">Clear all</button>') +
      '</div>';
    return html;
  }

  /**
   * The pin list's workings, in any element: the toolbar's list (attach) or the
   * side panel's Pins tab (panel). o: { insight, margin, jump(el), showPinned,
   * pinMore, noSets, done() (before a jump or an action: close the list),
   * placed() (after it is filled again: place the list) }.
   */
  function controller(el, o) {
    const insight = o.insight;
    const margin = o.margin || null;
    const doc = el.ownerDocument;
    let items = [];
    const done = () => { if (o.done) o.done(); };
    const has = (f) => typeof insight[f] === 'function';
    function texts() {
      try { return margin && margin.pinnedTexts ? margin.pinnedTexts() : []; } catch (e) { return []; }
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
    let clearing = false; // asking whether to unpin everything

    function fill() {
      items = allItems();
      if (editing && !items.some((x) => x.key === editing)) editing = null;
      if (!items.length) clearing = false;
      const sets = has('pinSets') ? insight.pinSets() : [];
      const act = has('activeSet') ? insight.activeSet() : null;
      el.innerHTML = listHtml(items, {
        showPinned: !!o.showPinned, pinMore: !!o.pinMore, order: inOrder(), sets, naming, noSets: !!o.noSets,
        suggest: naming && has('suggestSetName') ? insight.suggestSetName() : '',
        update: act && !insight.setIsOn(act) ? act : null, editing, clearing,
      });
      if (insight.renderSymbols) insight.renderSymbols(el);
    }
    /** Fill again, keeping the focus where it was (by what it does). */
    function refill(focusSel) {
      fill();
      if (o.placed) o.placed();
      const f = focusSel && el.querySelector(focusSel);
      if (f) { f.focus({ preventScroll: true }); if (f.select && f.tagName === 'INPUT') f.select(); }
    }
    const sel = (attr, v) => `[${attr}="${String(v).replace(/["\\]/g, '\\$&')}"]`;

    // --- notes ---
    let quiet = false; // a note is being kept: the list is filled again after
    function saveMemo(input, refillAfter) {
      const key = input.dataset.pinsMemoIn;
      editing = null;
      quiet = true;
      try { if (has('setPinNote')) insight.setPinNote(key, input.value); } finally { quiet = false; }
      if (refillAfter !== false && el.isConnected) refill(sel('data-pins-memo', key) + '.tg-pins-pen');
    }

    // --- the reading order ---
    const orderKeys = () => Array.from(el.querySelectorAll('.tg-pins-row')).map((r) => r.dataset.key);
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
    el.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('[data-pins-drag]');
      if (!h || e.button !== 0) return;
      e.preventDefault();
      const row = h.closest('.tg-pins-row');
      drag = { key: h.dataset.pinsDrag, row, id: e.pointerId, moved: false };
      row.classList.add('tg-pins-dragging');
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* moves still come to the list */ }
    });
    el.addEventListener('pointermove', (e) => {
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
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    // --- sets ---
    function saveSet() {
      const inp = el.querySelector('.tg-pins-set-name');
      if (!inp) return;
      if (insight.saveView(inp.value)) { naming = false; refill('[data-pins-act="save"]'); } else inp.focus();
    }
    /** Unpin everything: results, equations, symbols and passages (the sets and notes stay). */
    function clearAll() {
      clearing = false;
      quiet = true;
      try {
        if (margin && margin.setPinnedTexts) margin.setPinnedTexts([]);
        if (has('unpinAll')) insight.unpinAll();
      } finally { quiet = false; }
      refill('[data-pins-act="save"], button');
    }

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-pins-drag]')) return;
      const go = e.target.closest('[data-pins-go]');
      if (go) {
        const x = items.find((it) => it.key === go.dataset.pinsGo);
        if (x && x.kind === 'text') { done(); margin.goTo(x.id); } else if (x && x.el) { done(); o.jump(x.el); }
        return;
      }
      const memo = e.target.closest('[data-pins-memo]');
      if (memo) { editing = memo.dataset.pinsMemo; refill(sel('data-pins-memo-in', editing)); return; }
      const un = e.target.closest('[data-pins-unpin]');
      if (un) {
        const key = un.dataset.pinsUnpin;
        if (key.startsWith('text:')) margin.unpinText(key.slice(5)); // refreshes the list through the margin's onPins
        else insight.unpinKey(key); // refreshes the list through onPins
        const next = el.querySelector('.tg-pins-x') || el.querySelector('button');
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
        if (a === 'clear') { clearing = true; refill('[data-pins-act="clear-cancel"]'); return; }
        if (a === 'clear-cancel') { clearing = false; refill('[data-pins-act="clear"]'); return; }
        if (a === 'clear-ok') { clearAll(); return; }
        done();
        if (a === 'show' && o.showPinned) o.showPinned();
        if (a === 'more' && o.pinMore) o.pinMore();
      }
    });
    el.addEventListener('keydown', (e) => {
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
    el.addEventListener('focusout', (e) => {
      // a note being written is kept when the focus leaves it (not when the list is filled again)
      const t = e.target;
      if (!(t.matches && t.matches('.tg-pins-memo-in') && t.isConnected && editing === t.dataset.pinsMemoIn)) return;
      // onto another button of the list: its click fills the list again (filling now would lose the click)
      const inside = e.relatedTarget && el.contains(e.relatedTarget);
      saveMemo(t, !inside);
    });

    /** Fill again after a change elsewhere: a note being written keeps its text and focus. */
    function refresh() {
      if (quiet) return;
      const inp = el.querySelector('.tg-pins-memo-in');
      const keep = inp && doc.activeElement === inp ? { key: inp.dataset.pinsMemoIn, value: inp.value } : null;
      fill();
      if (o.placed) o.placed();
      if (keep) {
        const again = el.querySelector(sel('data-pins-memo-in', keep.key));
        if (again) { again.value = keep.value; again.focus({ preventScroll: true }); }
      }
    }
    return {
      fill,
      refresh,
      /** Start afresh: no set being named, no note being written, no question open. */
      reset() { naming = false; editing = null; clearing = false; },
      count: () => {
        let n = 0;
        try { n = insight.allPinCount ? insight.allPinCount() : insight.pinnedList().length; } catch (e) { n = 0; }
        return n + texts().length;
      },
    };
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

    const margin = opts.margin || null;
    const has = (f) => typeof insight[f] === 'function';
    // pin sets carry the pinned passages too
    if (margin && margin.pinnedTextIds && margin.setPinnedTexts && has('setTextPins')) {
      insight.setTextPins({ get: () => margin.pinnedTextIds(), set: (ids) => margin.setPinnedTexts(ids), el: (id) => (margin.textElOf ? margin.textElOf(id) : null) });
    }
    const list = controller(menu, {
      insight, margin, jump: opts.jump, showPinned: opts.showPinned, pinMore: opts.pinMore,
      done: () => close(), placed: () => place(),
    });

    function refreshBadge() {
      const n = list.count();
      badge.textContent = n ? String(n > 99 ? '99+' : n) : '';
      badge.hidden = !n;
      const label = n ? `Pinned: ${n} ${n === 1 ? 'thing' : 'things'}` : 'Pinned: nothing yet';
      button.setAttribute('aria-label', label);
      button.title = n ? `${label}. Click to see them all and jump to one` : 'Pinned: results, equations and symbols you pin gather here';
      button.classList.toggle('tg-pins-some', !!n);
      if (opts.hideWhenEmpty) button.hidden = !n && !(has('pinSets') && insight.pinSets().length);
    }

    function place() {
      if (menu.hidden) return;
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
      list.reset();
      list.fill();
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

    button.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); close(true); }
    }, true);
    doc.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) close();
    });
    win.addEventListener('resize', () => { if (!menu.hidden) place(); });

    function refresh() {
      refreshBadge();
      if (!menu.hidden) list.refresh();
    }
    if (insight.onPins) insight.onPins(refresh);
    refreshBadge();

    return { open, close, toggle, refresh, isOpen: () => !menu.hidden, menu };
  }

  // --- the Pins tab of the side panel: the pin sets on top, the pin list under them ----

  /** The sets at the top of the Pins tab: click one to pin it, × to delete it. sets: insight.pinSets(). */
  function panelSetsHtml(sets) {
    let html = '<div class="tg-sets-title">Saved sets</div>';
    if (!sets.length) {
      return html + '<p class="tg-sets-empty">No pin sets yet. Pin things, then <b>Save as set…</b> below keeps them, with their order and notes, under a name.</p>';
    }
    return html + '<div class="tg-sets-list" role="group" aria-label="Saved pin sets">' +
      sets.map((x) => `<span class="tg-sets-item"><button type="button" class="tg-sets-set" data-pins-set="${esc(x.name)}" aria-pressed="${x.on}" ` +
        `title="${esc(x.on ? `Pinned now: the ${x.size} of “${x.name}”` : `Pin the ${x.size} of “${x.name}” instead of the pins now`)}">` +
        `<span class="tg-sets-name">${esc(x.name)}</span>` +
        (x.on ? '<span class="tg-sets-now">pinned</span>' : '') +
        `<span class="tg-sets-size" aria-label="${x.size} ${x.size === 1 ? 'thing' : 'things'}">${x.size}</span></button>` +
        `<button type="button" class="tg-sets-del" data-pins-setdel="${esc(x.name)}" title="Delete this pin set (the pins stay)" aria-label="${esc('Delete the pin set ' + x.name)}">&times;</button></span>`).join('') +
      '</div>';
  }

  /**
   * Fill the side panel's Pins tab (TeXglassInsight.sidePanel's pinsTab): the
   * saved sets fixed at the top, and under them the pin list as the toolbar's pin
   * shows it (By kind / In order, notes, unpin, Show only these, Clear all).
   *   TeXglassPins.panel({ body, insight, margin, jump(el), showPinned(), onJump() }) → { show(), hide(), refresh() }
   */
  function panel(opts) {
    const body = opts.body;
    const insight = opts.insight;
    if (!body || !insight || !insight.pinSets || !insight.pinnedList) return null;
    const doc = body.ownerDocument;
    body.innerHTML = '<div class="tg-sets-stuck"></div><div class="tg-pins-panel"></div>';
    const top = body.firstElementChild;
    const listEl = body.lastElementChild;
    let shown = false;
    const list = controller(listEl, {
      insight, margin: opts.margin, jump: opts.jump, showPinned: opts.showPinned, noSets: true,
      done: () => { if (opts.onJump) opts.onJump(); },
    });

    function fillSets() {
      let sets = [];
      try { sets = insight.pinSets(); } catch (e) { sets = []; }
      top.innerHTML = panelSetsHtml(sets);
    }
    const sel = (attr, v) => `[${attr}="${String(v).replace(/["\\]/g, '\\$&')}"]`;
    top.addEventListener('click', (e) => {
      const set = e.target.closest('[data-pins-set]');
      if (set) {
        const name = set.dataset.pinsSet;
        insight.loadView(name); // fills both again through onPins
        const again = top.querySelector(sel('data-pins-set', name));
        if (again) again.focus({ preventScroll: true });
        return;
      }
      const del = e.target.closest('[data-pins-setdel]');
      if (del) {
        insight.deleteView(del.dataset.pinsSetdel);
        fill();
        const next = top.querySelector('[data-pins-set]');
        if (next) next.focus({ preventScroll: true });
      }
    });
    function fill() {
      if (!shown) return;
      const scroller = body.closest('.toc-pane') || body;
      const keep = scroller.scrollTop;
      fillSets();
      list.refresh();
      scroller.scrollTop = keep;
    }
    if (insight.onPins) insight.onPins(fill);

    return {
      show() { shown = true; list.reset(); fill(); },
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

  return { attach, panel, listHtml, setsHtml, sheet, shareFields, sharedSheet, ICON };
});
