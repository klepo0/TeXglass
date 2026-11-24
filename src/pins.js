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
 *     root,               // optional: the document, for P (pin what is under the pointer)
 *     toc,                // optional: the contents list, to show how many pins each section holds
 *     keys,               // false: no P / J / K
 *     view(),             // optional: the view on screen when it is not the pins (What does
 *                         //   this use?, a shared view): { kind, title, note, items: [{ name, el }],
 *                         //   save, keep }, or null; the list then shows it (refresh() when it changes)
 *     viewAct(a, el),     // optional: its buttons: 'save', 'keep', 'done', 'away' (take el out)
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
    if (sets.length || o.working) {
      if (o.working) html += `<button type="button" data-pins-working aria-pressed="${!!o.myPins}">My pins</button>`;
      html += '<span class="tg-pins-sets-k">Sets</span>' + sets.map((x) =>
        `<span class="tg-pins-set${x.active || x.on ? ' tg-pins-set-on' : ''}"><button type="button" data-pins-set="${esc(x.name)}" aria-pressed="${x.on}"${x.active ? ' aria-current="true"' : ''}>${esc(x.name)}${x.draft ? ' · Draft' : ''}</button>` +
        `<button type="button" class="tg-pins-set-del" data-pins-setdel="${esc(x.name)}" title="Delete this pin set (the pins stay)" aria-label="${esc('Delete the pin set ' + x.name)}">&times;</button></span>`).join('');
    }
    if (o.naming) {
      html += `<span class="tg-pins-set-new"><input type="text" class="tg-pins-set-name" maxlength="80" placeholder="Name this pin set" aria-label="Name for the pin set" value="${esc(o.suggest || '')}">` +
        '<button type="button" data-pins-act="save-ok">Save</button><button type="button" data-pins-act="save-cancel">Cancel</button></span>';
    } else {
      if (o.update) html += `<button type="button" class="tg-pins-set-update" data-pins-act="update" title="${esc(`Save the draft of “${o.update}”`)}">Update “${esc(o.update)}”</button>` +
        '<button type="button" data-pins-act="revert">Revert draft</button>';
      if (o.any) html += '<button type="button" data-pins-act="save" title="Keep everything pinned now, with its order, under a name: a pin set to switch back to later (saved with your notes)">Save as set…</button>';
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
      (o.tools ? `<input type="checkbox" class="tg-pins-check" data-pins-check aria-label="${esc('Select ' + what)}">` : '') +
      (o.order ? `<button type="button" class="tg-pins-drag" data-pins-drag="${esc(x.key)}" title="Drag to change the reading order (or ↑ ↓ on the keyboard)" aria-label="${esc(`Move ${what} in the reading order: arrow keys up or down`)}">${DRAG}</button>` : '') +
      '<div class="tg-pins-main">' +
      `<button type="button" class="tg-pins-go" data-pins-go="${esc(x.key)}"${x.el || x.placed ? '' : ' disabled'} title="${x.el || x.placed ? 'Go to it' : 'Not in this version of the document'}">${labelHtml(x)}</button>` +
      (editing
        ? `<input type="text" class="tg-pins-memo-in" data-pins-memo-in="${esc(x.key)}" maxlength="200" placeholder="A one-line note" aria-label="${esc('Note on ' + what)}" value="${esc(memo)}">`
        : memo ? `<button type="button" class="tg-pins-memo" data-pins-memo="${esc(x.key)}" title="Your note: click to change it">${esc(memo)}</button>` : '') +
      '</div>' +
      (o.destination ? '<span data-pins-destination></span>' : '') +
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
    const setOptions = { naming: o.naming, suggest: o.suggest, update: o.update, any: !!items.length, working: !o.noSets && o.working, myPins: o.myPins };
    if (!items.length) {
      return '<div class="tg-pins-head"><strong>Nothing pinned yet</strong></div>' +
        setsHtml(o.noSets ? [] : sets, setOptions) +
        '<p class="tg-pins-empty">Pin a result or a numbered equation with the pin by its corner on the <b>Map</b> (or the pin at an equation’s left, or a figure’s top right), ' +
        'a symbol with the pin on its row in the <b>Notation</b> tab, or anything with the pin on its preview. ' +
        'Select some text to pin it too. Pinned things gather here.</p>' +
        (o.pinMore ? '<div class="tg-pins-actions"><button type="button" data-pins-act="more">Pin results…</button></div>' : '');
    }
    const maps = items.filter((x) => x.kind !== 'notation').length;
    let html = `<div class="tg-pins-head"><strong>Pinned</strong> <span class="tg-pins-count">${items.length}</span>` +
      (o.setName ? `<span class="tg-pins-setname" title="${esc(o.setName.title)}">${esc(o.setName.text)}</span>` : '') +
      '<span class="tg-pins-views" role="group" aria-label="List the pins">' +
      `<button type="button" data-pins-view="kind" aria-pressed="${!o.order}" title="Grouped: results, equations, symbols…">By kind</button>` +
      `<button type="button" data-pins-view="order" aria-pressed="${!!o.order}" title="One list in your reading order: drag to reorder">In order</button></span></div>`;
    // in the side panel's Pins tab the sets are listed above: here only Save as set… and Update
    html += setsHtml(o.noSets ? [] : sets, setOptions);
    if (o.tools) html += '<div class="tg-pins-tools"><input type="search" data-pins-search aria-label="Search pins" placeholder="Search pins"><div class="tg-pins-selection" data-pins-selection></div></div>' +
      '<p class="tg-pins-empty" data-pins-no-matches role="status" hidden>No pins match this search.</p>';
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
   * The list's HTML while a view is on screen that is not the reader's pins
   * (What does this use?, a search by use, a shared view): what it shows, and
   * its Keep buttons. v: { kind, title, note, items: [{ name, el }], save, keep, pins }.
   */
  function viewHtml(v) {
    const temp = v.kind === 'uses';
    let html = `<div class="tg-pins-head tg-pins-head-view"><strong>Showing</strong> <span class="tg-pins-count">${v.items.length}</span>` +
      `<span class="tg-pins-setname" title="${esc(v.title)}">${esc(v.title)}</span></div>`;
    html += `<p class="tg-pins-viewnote">${v.note ? `<b>${esc(v.note)}.</b> ` : ''}${temp ? 'A temporary set' : 'A view from a link'}: ` +
      `${v.pins ? `your ${v.pins} pin${v.pins === 1 ? '' : 's'} come${v.pins === 1 ? 's' : ''} back` : 'your pins are as they were'} when you leave it.</p>`;
    html += '<div class="tg-pins-list" role="list" aria-label="Shown now">';
    v.items.forEach((x, i) => {
      html += `<div class="tg-pins-row" role="listitem"><div class="tg-pins-main"><button type="button" class="tg-pins-go" data-pins-vgo="${i}" title="Go to it">${esc(x.name)}</button></div>` +
        (x.key ? `<span data-pins-destination="${esc(x.key)}"></span>` : '') +
        (temp ? `<button type="button" class="tg-pins-x" data-pins-vx="${i}" title="Take it out of this view (your pins stay as they are)" aria-label="Take ${esc(x.name)} out of this view">&times;</button>` : '') + '</div>';
    });
    html += '</div><div class="tg-pins-actions">' +
      (v.save ? '<button type="button" data-pins-act="view-save" title="Keep these as a pin set of their own, to open later; your pins now stay as they are">Save as pin set</button>' : '') +
      (v.keep ? `<button type="button" data-pins-act="view-keep" title="Pin these too, with the pins you have">${temp ? 'Add to my pins' : 'Keep these pins'}</button>` : '') +
      `<button type="button" data-pins-act="view-done" title="Leave this view: back to the whole document and your own pins">${temp ? 'Done' : 'Dismiss'}</button></div>`;
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
    let query = '';
    let shownSet;
    const selected = new Set();
    const selectedItems = () => items.filter((x) => selected.has(x.key));
    const normalize = (str) => str.normalize('NFKC').toLowerCase();
    function fillSelection() {
      const tools = el.querySelector('[data-pins-selection]');
      if (!tools) return;
      const visible = el.querySelectorAll('.tg-pins-row:not([hidden])');
      const allSelected = visible.length && Array.from(visible).every((row) => selected.has(row.dataset.key));
      const picked = selectedItems();
      tools.innerHTML = (visible.length ? `<button type="button" data-pins-act="select-matching">${allSelected ? 'Deselect' : 'Select'} ${query.trim() ? 'matches' : 'all'}</button>` : '') +
        (picked.length ? `<span role="status">${picked.length} selected</span><button type="button" data-pins-act="unpin-selected">Unpin selected</button>` : '') +
        (o.canCollect && o.canCollect(picked) ? '<button type="button" data-pins-act="collect-selected">Add to collection…</button>' : '');
      if (picked.length && has('setDestination')) tools.appendChild(insight.setDestination(picked.map((x) => x.key)));
    }
    function filterRows() {
      const rows = el.querySelectorAll('.tg-pins-row');
      const terms = normalize(query.trim()).split(/\s+/);
      const matching = new Set(items.filter((x) => {
        const fields = normalize([x.name, x.key, x.tex, x.code, x.note, x.memo].filter(Boolean).join(' '));
        return terms.every((term) => fields.includes(term));
      }).map((x) => x.key));
      rows.forEach((row) => {
        row.hidden = !matching.has(row.dataset.key);
        const check = row.querySelector('[data-pins-check]');
        if (check) check.checked = selected.has(row.dataset.key);
      });
      for (const group of el.querySelectorAll('.tg-pins-group')) group.hidden = !group.querySelector('.tg-pins-row:not([hidden])');
      const empty = el.querySelector('[data-pins-no-matches]');
      if (empty) empty.hidden = !!el.querySelector('.tg-pins-row:not([hidden])');
      el.classList.toggle('tg-pins-filtering', !!query.trim());
      fillSelection();
    }

    /** The view on screen when it is not the reader's pins (o.view(): the host's picker), or null. */
    let view = null;
    function viewNow() {
      let v = null;
      try { v = o.view ? o.view() : null; } catch (e) { v = null; }
      return v && v.items ? v : null;
    }
    /** The name of the pin set the pins are now: { text, title }, or null. */
    function setNameOf(sets) {
      const on = sets.find((x) => x.on && x.active) || sets.find((x) => x.on);
      const act = has('activeSet') ? insight.activeSet() : null;
      if (act && !insight.setIsOn(act)) return { text: `${act} (draft)`, title: `Update “${act}” saves this draft` };
      return on ? { text: on.name, title: `Your pins now are the pin set “${on.name}”` } : null;
    }

    function fill() {
      view = viewNow();
      if (view) {
        items = [];
        const rows = has('setDestination') && has('keyOfEl')
          ? view.items.map((x) => ({ ...x, key: insight.keyOfEl(x.el) }))
          : view.items;
        el.innerHTML = viewHtml({ ...view, pins: count(), items: rows });
        fillDestinations();
        return;
      }
      items = allItems();
      if (editing && !items.some((x) => x.key === editing)) editing = null;
      if (!items.length) clearing = false;
      const sets = has('pinSets') ? insight.pinSets() : [];
      const act = has('activeSet') ? insight.activeSet() : null;
      if (shownSet !== act) { shownSet = act; query = ''; selected.clear(); }
      const keys = new Set(items.map((x) => x.key));
      for (const k of selected) if (!keys.has(k)) selected.delete(k);
      el.innerHTML = listHtml(items, {
        showPinned: !!o.showPinned, pinMore: !!o.pinMore, order: inOrder(), sets, naming, noSets: !!o.noSets,
        suggest: naming && has('suggestSetName') ? insight.suggestSetName() : '',
        update: act && !insight.setIsOn(act) ? act : null, editing, clearing, setName: setNameOf(sets),
        working: has('hasWorkingPins') && insight.hasWorkingPins(), myPins: !act,
        tools: true, destination: has('setDestination'),
      });
      fillDestinations();
      const search = el.querySelector('[data-pins-search]');
      if (search) { search.value = query; filterRows(); }
      if (insight.renderSymbols) insight.renderSymbols(el);
    }
    function fillDestinations() {
      for (const dest of el.querySelectorAll('[data-pins-destination]')) {
        const k = dest.dataset.pinsDestination || dest.parentElement.dataset.key;
        dest.replaceWith(insight.setDestination([k], true));
      }
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
    function unpin(keys) {
      quiet = true;
      try {
        const text = keys.filter((k) => k.startsWith('text:')).map((k) => k.slice(5));
        if (text.length && margin) {
          const removed = new Set(text);
          if (margin.setPinnedTexts) margin.setPinnedTexts(texts().map((x) => x.id).filter((id) => !removed.has(id)));
          else for (const id of text) margin.unpinText(id);
        }
        const other = keys.filter((k) => !k.startsWith('text:'));
        if (has('unpinKeys')) insight.unpinKeys(other);
        else for (const k of other) insight.unpinKey(k);
      } finally { quiet = false; }
      refill('[data-pins-search], .tg-pins-x, button');
    }
    el.addEventListener('input', (e) => {
      if (!e.target.matches('[data-pins-search]')) return;
      query = e.target.value;
      filterRows();
    });
    el.addEventListener('change', (e) => {
      if (!e.target.matches('[data-pins-check]')) return;
      const key = e.target.closest('.tg-pins-row').dataset.key;
      if (e.target.checked) selected.add(key);
      else selected.delete(key);
      fillSelection();
    });

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-pins-drag]')) return;
      // the view on screen (not the reader's pins)
      const vgo = e.target.closest('[data-pins-vgo]');
      if (vgo) { const x = view && view.items[+vgo.dataset.pinsVgo]; if (x && x.el) { done(); o.jump(x.el); } return; }
      const vx = e.target.closest('[data-pins-vx]');
      if (vx) {
        const x = view && view.items[+vx.dataset.pinsVx];
        if (x && o.viewAct) o.viewAct('away', x.el); // the host's onView fills the list again
        const next = el.querySelector('.tg-pins-x') || el.querySelector('button');
        if (next) next.focus({ preventScroll: true });
        return;
      }
      const va = e.target.closest('[data-pins-act^="view-"]');
      if (va) { if (o.viewAct) o.viewAct(va.dataset.pinsAct.slice(5)); return; }
      const go = e.target.closest('[data-pins-go]');
      if (go) {
        const x = items.find((it) => it.key === go.dataset.pinsGo);
        if (x && has('visitPin')) insight.visitPin(x.key);
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
      if (e.target.closest('[data-pins-working]')) { insight.loadView(null); refill('[data-pins-working]'); return; }
      const del = e.target.closest('[data-pins-setdel]');
      if (del) { insight.deleteView(del.dataset.pinsSetdel); refill('[data-pins-act="save"]'); return; }
      const act = e.target.closest('[data-pins-act]');
      if (act) {
        const a = act.dataset.pinsAct;
        if (a === 'select-matching') {
          const keys = Array.from(el.querySelectorAll('.tg-pins-row:not([hidden])')).map((row) => row.dataset.key);
          const allSelected = keys.every((k) => selected.has(k));
          for (const k of keys) { if (allSelected) selected.delete(k); else selected.add(k); }
          filterRows();
          el.querySelector('[data-pins-act="select-matching"]').focus({ preventScroll: true });
          return;
        }
        if (a === 'unpin-selected') { unpin(Array.from(selected)); return; }
        if (a === 'collect-selected') { o.collect(selectedItems()); return; }
        if (a === 'save') { naming = true; refill('.tg-pins-set-name'); return; }
        if (a === 'save-cancel') { naming = false; refill('[data-pins-act="save"]'); return; }
        if (a === 'save-ok') { saveSet(); return; }
        if (a === 'update') { const name = insight.activeSet(); if (name) insight.saveView(name); refill(sel('data-pins-set', name)); return; }
        if (a === 'revert') { insight.revertView(); refill('[data-pins-act="save"], button'); return; }
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

    /** How many things the reader has pinned. */
    function count() {
      let n = 0;
      try { n = insight.allPinCount ? insight.allPinCount() : insight.pinnedList().length; } catch (e) { n = 0; }
      return n + texts().length;
    }

    /** Fill again after a change elsewhere: a note being written keeps its text and focus. */
    function refresh() {
      if (quiet) return;
      const inp = el.querySelector('.tg-pins-memo-in');
      const keep = inp && doc.activeElement === inp ? { key: inp.dataset.pinsMemoIn, value: inp.value } : null;
      const search = doc.activeElement && doc.activeElement.matches('[data-pins-search]') ? doc.activeElement : null;
      fill();
      if (o.placed) o.placed();
      if (keep) {
        const again = el.querySelector(sel('data-pins-memo-in', keep.key));
        if (again) { again.value = keep.value; again.focus({ preventScroll: true }); }
      }
      if (search) {
        const again = el.querySelector('[data-pins-search]');
        if (again) {
          again.focus({ preventScroll: true });
          again.setSelectionRange(search.selectionStart, search.selectionEnd);
        }
      }
    }
    return {
      fill,
      refresh,
      /** Start afresh: no set being named, no note being written, no question open. */
      reset() { naming = false; editing = null; clearing = false; },
      /** Everything pinned, in the reading order. */
      items: () => allItems(),
      count,
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
      insight.setTextPins({ get: () => margin.pinnedTextIds(), set: (ids) => margin.setPinnedTexts(ids), el: (id) => (margin.textElOf ? margin.textElOf(id) : null), go: (id) => margin.goTo(id) });
    }
    const list = controller(menu, {
      insight, margin, jump: opts.jump, showPinned: opts.showPinned, pinMore: opts.pinMore,
      view: opts.view, viewAct: opts.viewAct,
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

    // With a side panel, the pin opens its Pins tab (the same list, with the pin sets);
    // the list under the button is for hosts without one, or when the panel cannot show.
    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (opts.openTab && menu.hidden && opts.openTab()) return;
      toggle();
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); close(true); }
    }, true);
    doc.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) close();
    });
    win.addEventListener('resize', () => { if (!menu.hidden) place(); });

    // --- the keyboard: P pins what is under the pointer (or selected), J / K step through the pins ---
    const root = opts.root || null;
    let hovered = null; // the block under the pointer, to pin with P
    const PINNABLE = '.theorem[id], .math-display, figure.float, .proof';
    if (root) {
      root.addEventListener('mouseover', (e) => { const t = e.target.closest && e.target.closest(PINNABLE); if (t) hovered = t; });
      root.addEventListener('mouseleave', () => { hovered = null; });
    }
    const typing = (el) => !!el && (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) ||
      (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(el.type)));
    let atKey = null; // fallback for hosts without pin set navigation
    function step(by) {
      const all = list.items().filter((x) => x.el || x.kind === 'text');
      if (!all.length) return false;
      const i = all.findIndex((x) => x.key === (insight.visitedPin ? insight.visitedPin() : atKey));
      const at = i < 0 ? (by > 0 ? 0 : all.length - 1) : (i + by + all.length) % all.length;
      const x = all[at];
      atKey = x.key;
      if (insight.visitPin) insight.visitPin(atKey);
      if (x.kind === 'text') { if (margin && margin.goTo) margin.goTo(x.id); } else opts.jump(x.el);
      if (opts.onStep) opts.onStep(x, at, all.length);
      return true;
    }
    function pinHere() {
      // a selection: what its bar's pin does
      const barPin = doc.querySelector('.tg-hlbar:not([hidden]) .tg-hlbar-pin');
      if (barPin) { barPin.click(); return true; }
      const focus = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest(PINNABLE);
      const el = focus && root && root.contains(focus) ? focus : hovered && doc.contains(hovered) ? hovered : null;
      if (!el || !insight.togglePin) return false;
      // a proof and a result share a corner: the innermost block under the pointer wins
      insight.togglePin(el);
      return true;
    }
    if (opts.keys !== false) {
      doc.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (typing(e.target) || doc.querySelector('dialog[open]')) return;
        const k = e.key;
        if (k === 'p' || k === 'P') { if (pinHere()) e.preventDefault(); return; }
        if (k === 'j' || k === 'J') { if (step(1)) e.preventDefault(); return; }
        if (k === 'k' || k === 'K') { if (step(-1)) e.preventDefault(); }
      });
    }

    // --- Contents: how many things are pinned in each section ---
    const toc = opts.toc || null;
    function tocBadges() {
      if (!toc) return;
      const links = Array.from(toc.querySelectorAll('a[data-id], a[href^="#"]'));
      for (const b of toc.querySelectorAll('.tg-toc-pins')) b.remove();
      if (!links.length) return;
      const els = [];
      for (const x of list.items()) {
        const el = x.kind === 'text' ? (margin && margin.textElOf ? margin.textElOf(x.id) : null) : x.el;
        if (el && doc.contains(el)) els.push(el);
      }
      if (!els.length) return;
      const depth = (a) => { const m = /toc-d(\d)/.exec((a.closest('li') || {}).className || ''); return m ? +m[1] : 0; };
      const heads = links.map((a) => ({ a, el: doc.getElementById(a.dataset.id || decodeURIComponent(a.getAttribute('href').slice(1))), d: depth(a) })).filter((h) => h.el);
      const after = (x, y) => !!(x.compareDocumentPosition(y) & 4); // y comes after x
      heads.forEach((h, i) => {
        let end = null;
        for (let j = i + 1; j < heads.length; j++) if (heads[j].d <= h.d) { end = heads[j].el; break; }
        const n = els.filter((el) => (el === h.el || after(h.el, el) || el.contains(h.el)) && !(end && (el === end || after(end, el)))).length;
        if (!n) return;
        const b = doc.createElement('span');
        b.className = 'tg-toc-pins';
        b.textContent = String(n);
        b.title = `${n} pinned in this section`;
        b.setAttribute('aria-label', `${n} pinned`);
        h.a.appendChild(b);
      });
    }
    let tocTimer = null;
    if (toc && typeof win.MutationObserver === 'function') new win.MutationObserver(() => { clearTimeout(tocTimer); tocTimer = setTimeout(tocBadges, 50); }).observe(toc, { childList: true });

    function refresh() {
      refreshBadge();
      if (!menu.hidden) list.refresh();
      clearTimeout(tocTimer);
      tocTimer = setTimeout(tocBadges, 50);
    }
    if (insight.onPins) insight.onPins(refresh);
    refreshBadge();
    tocTimer = setTimeout(tocBadges, 300);

    return { open, close, toggle, refresh, isOpen: () => !menu.hidden, menu };
  }

  // --- the Pins tab of the side panel: the pin sets on top, the pin list under them ----

  /** The sets at the top of the Pins tab: click one to pin it, × to delete it. sets: insight.pinSets(). */
  function panelSetsHtml(sets, starter, working, myPins) {
    let html = '<div class="tg-sets-title">Saved sets</div>';
    // a starter set to suggest: the main results with the definitions they rest on
    const suggest = starter && !sets.some((x) => x.name === starter)
      ? '<button type="button" class="tg-sets-starter" data-pins-starter title="A pin set of the paper’s main theorems with the definitions they rest on, in the paper’s order: change it as you like">+ Suggest a set: main results</button>' : '';
    if (!sets.length) {
      return html + '<p class="tg-sets-empty">No pin sets yet. Pin things, then <b>Save as set…</b> below keeps them, with their order and notes, under a name.</p>' + suggest;
    }
    return html + '<div class="tg-sets-list" role="group" aria-label="Saved pin sets">' +
      (working ? `<button type="button" class="tg-sets-set" data-pins-working aria-pressed="${myPins}">My pins</button>` : '') +
      sets.map((x) => `<span class="tg-sets-item"><button type="button" class="tg-sets-set" data-pins-set="${esc(x.name)}" aria-pressed="${x.on}"${x.active ? ' aria-current="true"' : ''}>` +
        `<span class="tg-sets-name">${esc(x.name)}</span>` +
        (x.draft ? '<span class="tg-sets-now">Draft</span>' : x.on ? '<span class="tg-sets-now">pinned</span>' : '') +
        `<span class="tg-sets-size" aria-label="${x.size} ${x.size === 1 ? 'thing' : 'things'}">${x.size}</span></button>` +
        `<button type="button" class="tg-sets-del" data-pins-setdel="${esc(x.name)}" title="Delete this pin set (the pins stay)" aria-label="${esc('Delete the pin set ' + x.name)}">&times;</button></span>`).join('') +
      '</div>' + suggest;
  }

  // --- collections: pins from several papers in one list (src/collections.js) ---

  /**
   * The Pins tab's "Across papers" part. c: { names, items(name) , here (the open
   * paper's key or null), adding (the name box is open), count (pins here that can
   * go in), open (the names of the collections shown open) }.
   */
  function collectionsHtml(c) {
    let html = '<div class="tg-sets-title">Across papers</div>';
    if (c.adding) {
      html += '<form class="tg-coll-add" data-coll-form>' +
        `<input class="tg-coll-name" type="text" list="tg-coll-names" maxlength="80" placeholder="Collection, e.g. Talk at the seminar" aria-label="Add the pins to this collection" value="${esc(c.adding === true ? (c.names[0] ? c.names[0].name : '') : c.adding)}">` +
        `<datalist id="tg-coll-names">${c.names.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>` +
        '<button type="submit">Add</button><button type="button" data-coll-act="cancel">Cancel</button></form>';
    } else if (c.count) {
      html += `<button type="button" class="tg-sets-starter tg-coll-addbtn" data-coll-act="add" title="Put the results, equations, figures and proofs pinned in this paper (with their notes) in a collection that gathers pins from several papers: for a talk or a literature review">+ Add the ${c.count} ${c.count === 1 ? 'pin' : 'pins'} here to a collection…</button>`;
    }
    if (!c.names.length) {
      return html + '<p class="tg-sets-empty">A collection gathers pins from several papers in one list, for a talk or a literature review. Pin things in a paper, add them to a collection, then do the same in the next paper.</p>';
    }
    html += '<div class="tg-coll-list">';
    for (const x of c.names) {
      const items = c.items(x.name);
      html += `<details class="tg-coll" data-coll="${esc(x.name)}"${c.open.has(x.name) ? ' open' : ''}><summary>` +
        `<span class="tg-sets-name">${esc(x.name)}</span><span class="tg-coll-meta">${x.size} from ${x.papers} ${x.papers === 1 ? 'paper' : 'papers'}</span>` +
        `<button type="button" class="tg-sets-del" data-coll-del="${esc(x.name)}" title="Delete this collection (the pins in the papers stay)" aria-label="${esc('Delete the collection ' + x.name)}">&times;</button></summary>`;
      let paperKey = null;
      for (const it of items) {
        if (it.paper !== paperKey) {
          paperKey = it.paper;
          html += `<div class="tg-coll-paper${it.paper === c.here ? ' tg-coll-here' : ''}">${esc(it.title || it.arxiv || it.paper)}${it.paper === c.here ? ' <span class="tg-sets-now">open</span>' : ''}</div>`;
        }
        const can = it.paper === c.here || it.arxiv || it.gh || c.saved(it.paper);
        html += `<div class="tg-coll-row"><button type="button" class="tg-coll-go" data-coll-go="${esc(it.id)}"${can ? '' : ' disabled title="This paper is not on arXiv or GitHub, nor saved on this device: open it yourself"'}>` +
          `<span class="tg-pins-name">${esc(it.name || it.key)}</span>${it.note ? ` <span class="tg-pins-note">(${esc(it.note)})</span>` : ''}</button>` +
          `<button type="button" class="tg-sets-del" data-coll-x="${esc(it.id)}" title="Take it out of this collection" aria-label="${esc('Take ' + (it.name || it.key) + ' out of ' + x.name)}">&times;</button></div>`;
      }
      html += '</details>';
    }
    return html + '</div>';
  }

  /**
   * Fill the side panel's Pins tab (TeXglassInsight.sidePanel's pinsTab): the
   * saved sets fixed at the top, and under them the pin list as the toolbar's pin
   * shows it (By kind / In order, notes, unpin, Show only these, Clear all).
   *   TeXglassPins.panel({ body, insight, margin, jump(el), showPinned(), pinMore(), onJump(), collections }) → { show(), hide(), refresh() }
   * collections (optional, the web viewer): pins gathered from several papers, see fillColl.
   */
  function panel(opts) {
    const body = opts.body;
    const insight = opts.insight;
    if (!body || !insight || !insight.pinSets || !insight.pinnedList) return null;
    const doc = body.ownerDocument;
    body.innerHTML = '<div class="tg-sets-stuck"></div><div class="tg-pins-panel"></div><div class="tg-coll-part" hidden></div>';
    const top = body.children[0];
    const listEl = body.children[1];
    const collEl = body.children[2];
    let shown = false;
    const list = controller(listEl, {
      insight, margin: opts.margin, jump: opts.jump, showPinned: opts.showPinned, pinMore: opts.pinMore, noSets: true,
      view: opts.view, viewAct: opts.viewAct,
      done: () => { if (opts.onJump) opts.onJump(); },
      canCollect: (items) => !!(C && Coll && C.here() && items.some(isCollectable)),
      collect: (items) => {
        adding = items.filter(isCollectable).map((x) => x.key);
        fillColl();
        collEl.querySelector('.tg-coll-name')?.scrollIntoView({ block: 'nearest' });
      },
    });

    function fillSets() {
      let sets = [];
      try { sets = insight.pinSets(); } catch (e) { sets = []; }
      let starter = null;
      try { starter = insight.starterSet ? insight.starterSet() : null; } catch (e) { starter = null; }
      top.innerHTML = panelSetsHtml(sets, starter, insight.hasWorkingPins && insight.hasWorkingPins(), !insight.activeSet());
    }
    const sel = (attr, v) => `[${attr}="${String(v).replace(/["\\]/g, '\\$&')}"]`;
    top.addEventListener('click', (e) => {
      if (e.target.closest('[data-pins-working]')) {
        insight.loadView(null);
        top.querySelector('[data-pins-working]')?.focus({ preventScroll: true });
        return;
      }
      const set = e.target.closest('[data-pins-set]');
      if (set) {
        const name = set.dataset.pinsSet;
        insight.loadView(name); // fills both again through onPins
        const again = top.querySelector(sel('data-pins-set', name));
        if (again) again.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest('[data-pins-starter]')) {
        const name = insight.suggestStarter && insight.suggestStarter();
        fill();
        const again = name && top.querySelector(sel('data-pins-set', name));
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
    // collections (opts.collections: { read(), write(list), here() (the open paper:
    // { paper, title, arxiv, gh } or null), saved(paperKey), open(item) }), with
    // TeXglassCollections for the list's workings
    const C = opts.collections;
    const Coll = C && (doc.defaultView || {}).TeXglassCollections;
    let adding = false;
    const openColl = new Set();
    /** The pins here that can go in a collection: results, equations, figures, proofs. */
    const isCollectable = (x) => x.el && x.kind !== 'notation' && x.kind !== 'text';
    const collectable = () => list.items().filter((x) => isCollectable(x) && (!Array.isArray(adding) || adding.includes(x.key)));
    function fillColl() {
      if (!C || !Coll) return;
      const here = C.here();
      const cur = C.read();
      collEl.hidden = false;
      const count = here ? collectable().length : 0;
      if (!count && adding) adding = false;
      collEl.innerHTML = collectionsHtml({
        names: Coll.names(cur), items: (n) => Coll.items(cur, n), here: here && here.paper,
        adding: !!adding, count, open: openColl, saved: (k) => !!(C.saved && C.saved(k)),
      });
      if (adding) {
        const input = collEl.querySelector('.tg-coll-name');
        if (input) { input.focus({ preventScroll: true }); input.select(); }
      }
    }
    if (C && Coll) {
      collEl.addEventListener('toggle', (e) => {
        const d = e.target.closest && e.target.closest('details[data-coll]');
        if (!d) return;
        if (d.open) openColl.add(d.dataset.coll); else openColl.delete(d.dataset.coll);
      }, true);
      collEl.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = collEl.querySelector('.tg-coll-name');
        const name = input ? input.value.trim() : '';
        const here = C.here();
        if (!name || !here) return;
        const items = collectable().map((x) => Object.assign({ key: x.key, name: x.note ? `${x.name} (${x.note})` : x.name, note: x.memo || '' }, here));
        if (!items.length) return;
        C.write(Coll.add(C.read(), name, items));
        adding = false;
        openColl.add(name.replace(/\s+/g, ' ').slice(0, 80));
        fillColl();
      });
      collEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && adding) { e.stopPropagation(); adding = false; fillColl(); }
      });
      collEl.addEventListener('click', (e) => {
        const act = e.target.closest('[data-coll-act]');
        if (act) { adding = act.dataset.collAct === 'add'; fillColl(); return; }
        const del = e.target.closest('[data-coll-del]');
        if (del) {
          e.preventDefault(); // not the details' toggle
          C.write(Coll.removeCollection(C.read(), del.dataset.collDel));
          fillColl();
          return;
        }
        const x = e.target.closest('[data-coll-x]');
        if (x) {
          C.write(Coll.remove(C.read(), [x.dataset.collX]));
          fillColl();
          return;
        }
        const go = e.target.closest('[data-coll-go]');
        if (go) {
          const id = go.dataset.collGo;
          const it = Coll.byId(C.read(), id);
          if (it) {
            if (opts.onJump) opts.onJump();
            C.open(it);
          }
        }
      });
    }

    function fill() {
      if (!shown) return;
      const scroller = body.closest('.toc-pane') || body;
      const keep = scroller.scrollTop;
      fillSets();
      list.refresh();
      fillColl();
      scroller.scrollTop = keep;
    }
    if (insight.onPins) insight.onPins(fill);

    return {
      show() { shown = true; list.reset(); fill(); },
      hide() { shown = false; },
      refresh: fill,
    };
  }

  /**
   * What the toolbar's pin does where there is a side panel: a click shows the
   * Pins tab (opening the panel if it is closed), a second click goes back to
   * the tab that was showing, or closes the panel if the pin opened it.
   *   TeXglassPins.tabOpener({ side (TeXglassInsight.sidePanel), shown() (the panel is
   *     showing), setShown(on) (show or hide it; false when it cannot show) }) → openTab()
   */
  function tabOpener(o) {
    let back = null; // { tab, closed }: where the pin came from
    return function openTab() {
      const side = o.side;
      if (!side || !side.show || !side.tab) return false;
      if (o.shown() && side.tab() === 'pins') {
        if (back && !back.closed && back.tab !== 'pins') side.show(back.tab);
        else o.setShown(false);
        back = null;
        return true;
      }
      const closed = !o.shown();
      const tab = side.tab();
      if (closed && o.setShown(true) === false) return false;
      side.show('pins');
      if (side.tab() !== 'pins' || !o.shown()) {
        if (closed) o.setShown(false);
        return false;
      }
      back = { tab, closed };
      return true;
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

  /**
   * What a picker (src/pick.js) shows when it is not the reader's pins, as the
   * pin list's view() takes it: the results, equations and figures in it, by name.
   */
  function viewOf(picker) {
    const v = picker && picker.view ? picker.view() : null;
    if (!v) return null;
    const Pick = typeof TeXglassPick !== 'undefined' ? TeXglassPick : null;
    const named = (el) => el.classList.contains('theorem') || (Pick && Pick.isNumberedDisplay(el)) || el.matches('figure.float');
    const nameOf = (el) => {
      if (el.matches('figure.float')) { const h = el.querySelector('.caption-head'); return h ? h.textContent.replace(/[.:]\s*$/, '').trim() : 'Figure'; }
      return Pick ? Pick.nameOf(el) : (el.textContent || '').trim().slice(0, 40);
    };
    return Object.assign({}, v, { items: v.els.filter(named).map((el) => ({ el, name: nameOf(el) })) });
  }
  /** The view's buttons in the pin list: 'save', 'keep', 'done', 'away' (take el out). */
  function viewAct(picker, a, el) {
    if (!picker) return;
    if (a === 'save') picker.saveView();
    else if (a === 'keep') picker.keepView();
    else if (a === 'done') picker.stop();
    else if (a === 'away') picker.takeAway(el);
  }

  return { attach, panel, tabOpener, listHtml, setsHtml, sheet, shareFields, sharedSheet, viewOf, viewAct, ICON };
});
