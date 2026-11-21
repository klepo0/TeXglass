/*
 * Reading progress on a paper's results, in the web viewer and the VS Code
 * preview.
 *
 *   - A small marker by the heading of each theorem, lemma, definition… and
 *     proof. A click steps it through unread, skimmed, read and understood; a
 *     "?" beside it flags the result as one to ask about.
 *   - The Contents tab shows how far each section has got ("4 of 7
 *     understood") and, at the top, the paper as a whole, with
 *     "What should I read next?" (the unread result the most other results
 *     rest on) and "Questions", the list of "?" results, to copy and take to a
 *     supervisor or a coauthor.
 *   - The dependency map (src/insight.js) colours its results by status: the
 *     host passes statusOf to TeXglassInsight.attach.
 *
 * Statuses are kept by the host with the reader's notes (src/notes-sync.js:
 * record.progress), so they sync the same way. A result is named by its
 * \label when it has one ("label:thm:main"), else by its name on the page
 * ("name:Lemma 2.3"), so statuses find their result again in a revised paper.
 * A proof goes by its result's key ("proof:label:thm:main").
 *
 * Nothing here runs while a document renders: markers are added when the
 * browser is idle after a render.
 *
 *   const progress = TeXglassProgress.attach({
 *     root: preview,                      // the rendered document
 *     pane, list,                         // the side panel and its contents list
 *     insight,                            // from TeXglassInsight.attach (graph, map)
 *     jump(el) { ... },                   // show an element of the page
 *     onChange(map) { ... },              // the reader changed a status: keep map
 *   });
 *   progress.setMap(record.progress);     // statuses from storage or another device
 *   progress.refresh();                   // after a render, or the contents changed
 *   progress.setEnabled(on);
 *   progress.statusOf(theoremEl);         // { s, q } or null (for the map)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassProgress = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUSES = ['unread', 'skimmed', 'read', 'understood'];
  const LABELS = { unread: 'Unread', skimmed: 'Skimmed', read: 'Read', understood: 'Understood' };
  const INSIDE_POPOVER = '.ref-popover, .insight-popover, .insight-dialog, .cited-box, .tg-margin';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const nextStatus = (s) => STATUSES[(STATUSES.indexOf(s || 'unread') + 1) % STATUSES.length];

  // ---------------------------------------------------------------------------
  // Reading the page
  // ---------------------------------------------------------------------------

  /** A block's own heading (.thm-head or .proof-head), not one of a block inside it. */
  function headOf(el) {
    const sel = el.classList.contains('proof') ? '.proof-head' : '.thm-head';
    const box = el.classList.contains('proof') ? '.proof' : '.theorem';
    for (const h of el.querySelectorAll(sel)) if (h.closest(box) === el) return h;
    return null;
  }

  function nameOf(el) {
    const h = headOf(el);
    const n = h && h.querySelector('.thm-name');
    return n ? n.textContent.trim().replace(/\s+/g, ' ') : 'Result';
  }

  function noteOf(el) {
    const h = headOf(el);
    const n = h && h.querySelector('.thm-note');
    return n ? n.textContent.trim().replace(/\s+/g, ' ').replace(/^\(|\)$/g, '') : '';
  }

  const styleOf = (el) => (el.classList.contains('thm-definition') ? 'definition' : el.classList.contains('thm-remark') ? 'remark' : 'plain');

  /**
   * The results and proofs of a page, in document order:
   * { results: [{ el, key, name, note, style }], proofs: [{ el, key, owner }], byEl }.
   * A proof belongs to the result its heading links to, or names ("Proof of
   * Theorem 2"), else to the result just before it.
   */
  function scan(doc) {
    const blocks = Array.from(doc.querySelectorAll('.theorem, .proof')).filter((el) => !el.closest(INSIDE_POPOVER));
    const results = [];
    const proofs = [];
    const byEl = new Map();
    const seen = new Map();
    const unique = (k) => {
      const c = (seen.get(k) || 0) + 1;
      seen.set(k, c);
      return c > 1 ? k + '#' + c : k;
    };
    for (const el of blocks) {
      if (!el.classList.contains('theorem')) continue;
      const name = nameOf(el);
      const note = noteOf(el);
      const label = el.dataset.label;
      const numbered = /\d/.test(name);
      const key = unique(label ? 'label:' + label : 'name:' + name + (!numbered && note ? ' (' + note + ')' : ''));
      const r = { el, key, name, note, style: styleOf(el) };
      results.push(r);
      byEl.set(el, r);
    }
    const byName = new Map(results.map((r) => [r.name.toLowerCase(), r]));
    let last = null;
    const proofCount = new Map();
    for (const el of blocks) {
      if (el.classList.contains('theorem')) { last = byEl.get(el); continue; }
      const head = headOf(el);
      let owner = null;
      if (head) {
        for (const a of head.querySelectorAll('a[href^="#"]')) {
          let id = a.getAttribute('href').slice(1);
          try { id = decodeURIComponent(id); } catch (e) { /* keep it */ }
          const t = (doc.ownerDocument || document).getElementById(id);
          const r = t && t.closest('.theorem');
          if (r && byEl.has(r)) { owner = byEl.get(r); break; }
        }
        if (!owner) {
          const m = /\b([A-Z][a-z]+\.?\s*[A-Z]?\d+(?:\.\d+)*[a-z]?)/.exec(head.textContent.replace(/\s+/g, ' '));
          if (m) owner = byName.get(m[1].toLowerCase()) || null;
        }
      }
      if (!owner) owner = last;
      if (!owner) continue;
      const c = (proofCount.get(owner) || 0) + 1;
      proofCount.set(owner, c);
      const p = { el, key: 'proof:' + owner.key + (c > 1 ? '#' + c : ''), owner, proof: true, name: 'Proof of ' + owner.name };
      proofs.push(p);
      byEl.set(el, p);
    }
    return { results, proofs, byEl };
  }

  /**
   * The results to read next, best first: those not yet read, ranked by how
   * many other results rest on them (directly or not), then by where they are.
   * deps(r) gives that count. Remarks and examples come last. Each entry is
   * { r, count, tier }, tier 0 unread, 1 skimmed, 2 read.
   */
  function rankNext(results, statusOf, deps) {
    const out = [];
    results.forEach((r, order) => {
      const s = (statusOf(r.key) || {}).s || 'unread';
      if (s === 'understood') return;
      out.push({ r, order, tier: STATUSES.indexOf(s), count: deps(r), remark: r.style === 'remark' });
    });
    out.sort((a, b) => a.tier - b.tier || a.remark - b.remark || b.count - a.count || a.order - b.order);
    return out;
  }

  /** Counts by status for a list of results: { unread, skimmed, read, understood, q, total }. */
  function tally(list, statusOf) {
    const t = { unread: 0, skimmed: 0, read: 0, understood: 0, q: 0, total: list.length };
    for (const r of list) {
      const m = statusOf(r.key) || {};
      t[m.s || 'unread']++;
      if (m.q) t.q++;
    }
    return t;
  }

  /** A small bar of how far a list of results has got, as HTML. */
  function barHtml(t) {
    if (!t.total) return '';
    const pct = (k) => ((100 * t[k]) / t.total).toFixed(1);
    return `<span class="rp-bar" aria-hidden="true"><i class="rp-bar-understood" style="width:${pct('understood')}%"></i>` +
      `<i class="rp-bar-read" style="width:${pct('read')}%"></i><i class="rp-bar-skimmed" style="width:${pct('skimmed')}%"></i></span>`;
  }

  /** "4 of 7 understood, 2 read, 1 skimmed" */
  function tallyText(t) {
    const parts = [`${t.understood} of ${t.total} understood`];
    if (t.read) parts.push(`${t.read} read`);
    if (t.skimmed) parts.push(`${t.skimmed} skimmed`);
    return parts.join(', ');
  }

  // ---------------------------------------------------------------------------
  // The UI
  // ---------------------------------------------------------------------------

  function attach(opts) {
    const doc = opts.root;
    const document_ = doc.ownerDocument || document;
    const win = document_.defaultView || window;
    let map = {}; // key -> { s, q, t }
    let enabled = opts.enabled !== false;
    let page = null; // scan(doc), until the page changes
    let showQuestions = false;
    let nextAt = 0; // which suggestion "What should I read next?" is on
    let nextShown = null; // the key it showed

    const getPage = () => page || (page = scan(doc));
    const statusOfKey = (k) => map[k] || null;

    // --- markers by the headings ---------------------------------------------------

    function markerHtml(entry) {
      const m = map[entry.key] || {};
      const s = m.s || 'unread';
      const what = entry.proof ? 'this proof' : entry.name;
      return `<button type="button" class="rp-mark" data-s="${s}" title="${esc(`${LABELS[s]}. Click: ${LABELS[nextStatus(s)].toLowerCase()}`)}" aria-label="${esc(`Reading status of ${what}: ${LABELS[s]}. Press for ${LABELS[nextStatus(s)].toLowerCase()}`)}"></button>` +
        `<button type="button" class="rp-q" aria-pressed="${!!m.q}" title="${m.q ? 'Flagged with a question. Click to clear' : 'Flag with a question, to ask about later'}" aria-label="${esc(`Question about ${what}`)}"></button>`;
    }

    function paint(entry) {
      let box = entry.el._rpMarks;
      if (!box || !entry.el.contains(box)) {
        const head = headOf(entry.el);
        if (!head) return;
        box = document_.createElement('span');
        box.className = 'rp-marks';
        box._rpEntry = entry;
        head.after(box);
        entry.el._rpMarks = box;
      }
      box._rpEntry = entry;
      const m = map[entry.key] || {};
      box.dataset.s = m.s || 'unread';
      box.classList.toggle('rp-flagged', !!m.q);
      box.innerHTML = markerHtml(entry);
    }

    function paintAll() {
      const p = getPage();
      for (const e of p.results) paint(e);
      for (const e of p.proofs) paint(e);
    }

    function removeMarks() {
      doc.querySelectorAll('.rp-marks').forEach((b) => b.remove());
    }

    function set(entry, change) {
      const old = map[entry.key] || {};
      const m = Object.assign({ s: old.s || 'unread' }, old.q ? { q: true } : {}, change, { t: new Date().toISOString() });
      if (!m.q) delete m.q;
      map = Object.assign({}, map, { [entry.key]: m });
      paint(entry);
      changed();
      if (opts.onChange) opts.onChange(map);
    }

    doc.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.rp-mark, .rp-q');
      if (!b || !enabled) return;
      const box = b.closest('.rp-marks');
      const entry = box && box._rpEntry;
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.classList.contains('rp-q')) set(entry, { q: !(map[entry.key] || {}).q });
      else set(entry, { s: nextStatus((map[entry.key] || {}).s) });
      const again = entry.el._rpMarks && entry.el._rpMarks.querySelector(b.classList.contains('rp-q') ? '.rp-q' : '.rp-mark');
      if (again) again.focus();
    }, true);
    doc.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.rp-marks')) e.stopPropagation(); // not a text selection or an edit
    });

    // --- the Contents tab: per section, and the paper as a whole -------------------

    let summary = null;
    function buildSummary() {
      if (summary || !opts.list) return;
      summary = document_.createElement('div');
      summary.className = 'rp-summary';
      summary.hidden = true;
      opts.list.before(summary);
      summary.addEventListener('click', (e) => {
        const b = e.target.closest('[data-rp]');
        if (!b) return;
        e.preventDefault();
        const act = b.dataset.rp;
        if (act === 'next') suggest(true);
        else if (act === 'another') { nextAt++; suggest(false); }
        else if (act === 'go-next') { const r = findEntry(nextShown); if (r) opts.jump(r.el); }
        else if (act === 'questions') { showQuestions = !showQuestions; fillSummary(); }
        else if (act === 'copy') copyQuestions(b);
        else if (act === 'go') { const r = findEntry(b.dataset.key); if (r) opts.jump(r.el); }
      });
    }

    const findEntry = (key) => getPage().results.find((r) => r.key === key) || getPage().proofs.find((r) => r.key === key) || null;

    function flagged() {
      const p = getPage();
      return p.results.concat(p.proofs).filter((e) => (map[e.key] || {}).q)
        .sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
    }

    function fillSummary() {
      buildSummary();
      if (!summary) return;
      const p = getPage();
      if (!enabled || !p.results.length) {
        summary.hidden = true;
        if (opts.pane) opts.pane.classList.remove('rp-only-q');
        return;
      }
      const t = tally(p.results, statusOfKey);
      const qs = flagged();
      if (!qs.length) showQuestions = false;
      summary.hidden = false;
      let html = `<div class="rp-sum-line" title="${esc(tallyText(t))}">${barHtml(t)}<span class="rp-sum-text">${t.understood} of ${t.total} understood</span></div>` +
        '<div class="rp-sum-actions">' +
        '<button type="button" data-rp="next" title="The unread result that the most other results rest on">What should I read next?</button>' +
        (qs.length ? `<button type="button" data-rp="questions" aria-pressed="${showQuestions}" title="Show only the results flagged with ?">? ${qs.length}</button>` : '') +
        '</div><div class="rp-next" aria-live="polite"></div>';
      if (showQuestions) {
        html += '<div class="rp-qhead"><strong>Flagged with ?</strong> <button type="button" data-rp="copy" title="Copy the list, to ask a supervisor or a coauthor">Copy list</button></div><ol class="rp-qlist">' +
          qs.map((e) => `<li><a href="#" data-rp="go" data-key="${esc(e.key)}">${esc(e.name)}</a>${e.note ? ` <span class="rp-muted">(${esc(e.note)})</span>` : ''}</li>`).join('') + '</ol>';
      }
      summary.innerHTML = html;
      if (opts.pane) opts.pane.classList.toggle('rp-only-q', showQuestions);
      if (nextShown) suggest(false, true);
    }

    function copyQuestions(button) {
      const lines = flagged().map((e) => `- ${e.name}${e.note ? ` (${e.note})` : ''}`);
      const title = (document_.title || '').replace(/ — TeXglass$/, '');
      const text = (title ? `Questions on ${title}:\n` : '') + lines.join('\n') + '\n';
      const done = () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy list'; }, 1500); };
      try {
        if (win.navigator.clipboard && win.navigator.clipboard.writeText) win.navigator.clipboard.writeText(text).then(done, () => {});
      } catch (e) { /* no clipboard here */ }
    }

    /** How many results rest on r, directly or not (from the dependency map). */
    function depsCounter() {
      const ins = opts.insight;
      if (!ins || !ins.related) return () => 0;
      const memo = new Map();
      return (r) => {
        if (!memo.has(r)) {
          const rel = ins.related(r.el);
          memo.set(r, rel ? rel.usedBy : 0);
        }
        return memo.get(r);
      };
    }

    /** "What should I read next?": go to the best suggestion and say why. */
    function suggest(jump, quiet) {
      const box = summary && summary.querySelector('.rp-next');
      if (!box) return;
      const ranked = rankNext(getPage().results, statusOfKey, depsCounter());
      if (!ranked.length) {
        nextShown = null;
        box.innerHTML = '<p>Everything here is marked understood.</p>';
        return;
      }
      if (jump) nextAt = 0;
      if (nextAt >= ranked.length) nextAt = 0;
      if (quiet) {
        const k = ranked.findIndex((x) => x.r.key === nextShown);
        if (k < 0) { box.innerHTML = ''; nextShown = null; return; }
        nextAt = k;
      }
      const x = ranked[nextAt];
      nextShown = x.r.key;
      const status = x.tier === 0 ? 'unread' : x.tier === 1 ? 'only skimmed' : 'read but not yet understood';
      const why = x.count
        ? `${x.count} other result${x.count === 1 ? ' rests' : 's rest'} on it, and it is ${status}.`
        : `It is ${status}${x.tier === 0 ? ', and comes first' : ''}.`;
      box.innerHTML = `<p><a href="#" data-rp="go-next"><strong>${esc(x.r.name)}</strong></a>${x.r.note ? ` <span class="rp-muted">(${esc(x.r.note)})</span>` : ''}: ${esc(why)}` +
        (ranked.length > 1 ? ' <button type="button" data-rp="another" title="Suggest the next one instead">Another</button>' : '') + '</p>';
      if (!quiet) opts.jump(x.r.el);
    }

    /** Progress bars by the sections in the contents list. */
    function fillToc() {
      const list = opts.list;
      if (!list) return;
      list.querySelectorAll('.rp-toc').forEach((b) => b.remove());
      if (!enabled) return;
      const p = getPage();
      if (!p.results.length) return;
      const items = Array.from(list.querySelectorAll('li')).map((li) => {
        const a = li.querySelector('a[data-id]');
        const h = a && document_.getElementById(a.dataset.id);
        const d = /\btoc-d(\d)/.exec(li.className);
        return h && doc.contains(h) ? { li, a, h, depth: d ? Number(d[1]) : 0, own: [] } : null;
      }).filter(Boolean);
      if (!items.length) return;
      // each result goes to the last heading before it
      let k = -1;
      for (const r of p.results) {
        while (k + 1 < items.length && items[k + 1].h.compareDocumentPosition(r.el) & 4) k++;
        if (k >= 0) items[k].own.push(r);
      }
      items.forEach((it, i) => {
        let all = it.own.slice();
        for (let j = i + 1; j < items.length && items[j].depth > it.depth; j++) all = all.concat(items[j].own);
        if (!all.length) return;
        const t = tally(all, statusOfKey);
        const title = (it.a.querySelector('.toc-title') || it.a).textContent.trim();
        const num = (it.a.querySelector('.toc-num') || {}).textContent || '';
        const span = document_.createElement('span');
        span.className = 'rp-toc' + (t.understood === t.total ? ' rp-toc-done' : '');
        span.title = `${num ? 'Section ' + num.trim() : title}: ${tallyText(t)}${t.q ? `, ${t.q} with ?` : ''}`;
        span.innerHTML = barHtml(t) + `<span class="rp-toc-n">${t.understood}/${t.total}</span>`;
        it.a.appendChild(span);
      });
    }

    // --- keeping it up to date ---------------------------------------------------------

    function changed() {
      fillSummary();
      fillToc();
      if (opts.insight && opts.insight.repaint) opts.insight.repaint();
    }

    let idle = null;
    const later = (f) => {
      if (idle) (win.cancelIdleCallback || win.clearTimeout)(idle);
      idle = win.requestIdleCallback ? win.requestIdleCallback(() => { idle = null; f(); }, { timeout: 1500 }) : win.setTimeout(() => { idle = null; f(); }, 200);
    };

    /** After a render or a new contents list: read the page again (when idle). */
    function refresh() {
      page = null;
      later(() => {
        page = null;
        if (enabled) paintAll();
        changed();
      });
    }

    function setMap(m) {
      const next = m && typeof m === 'object' ? Object.assign({}, m) : {};
      if (JSON.stringify(next) === JSON.stringify(map)) return;
      map = next;
      if (enabled && doc.querySelector('.rp-marks')) paintAll();
      changed();
    }

    function setEnabled(on) {
      enabled = !!on;
      doc.classList.toggle('rp-off', !enabled);
      if (enabled) paintAll();
      else removeMarks();
      changed();
    }
    doc.classList.toggle('rp-off', !enabled);

    return {
      refresh,
      setMap,
      setEnabled,
      enabled: () => enabled,
      map: () => map,
      /** { s, q } for a result or proof element, or null (off, or not a result). */
      statusOf(el) {
        if (!enabled || !el) return null;
        const e = getPage().byEl.get(el);
        if (!e) return null;
        return Object.assign({ s: 'unread' }, map[e.key] || {});
      },
      /** The key a result or proof element goes by, or null. */
      keyOf(el) {
        const e = getPage().byEl.get(el);
        return e ? e.key : null;
      },
      suggest: () => suggest(true),
      showQuestions(on) { showQuestions = on !== false; fillSummary(); },
    };
  }

  return { attach, scan, rankNext, tally, nextStatus, STATUSES };
});
