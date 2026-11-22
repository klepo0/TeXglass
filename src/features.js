/*
 * Settings: switch TeXglass's reading aids on or off, in the web viewer, the
 * browser extension (its viewer and the Overleaf preview) and the VS Code
 * preview. One list of features, one panel, kept per browser (localStorage)
 * or, in VS Code, as texglass.* settings.
 *
 *   const prefs = TeXglassFeatures.read(store);         // { refPreviews: true, ... }
 *   TeXglassFeatures.write(store, 'citeLookup', false);
 *   TeXglassFeatures.on(prefs, 'citedResults');          // false when a feature it needs is off
 *   TeXglassFeatures.previewKind(a);                     // which setting a hovered link's preview falls under
 *   TeXglassFeatures.insightParts(prefs);                // { map, notation, uses, words } for insight.setFeatures
 *   const panel = TeXglassFeatures.panel({
 *     get: () => prefs,                                  // the current values
 *     set: (id, on) => { ... },                          // the reader changed one
 *     ids: [...],                                        // optional: only these (default: all)
 *     footer: element,                                   // optional: added under the list
 *   });
 *   panel.open(); panel.refresh(); panel.close();
 *
 * Each feature keeps the key it had before Settings existed (notation on hover,
 * highlights and notes, reading progress, the handwritten look), so earlier
 * choices carry over; the rest are kept as texglass:feature-<id> = '1' or '0'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassFeatures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // needs: the feature this one works through (shown dimmed while that one is off)
  // vscode: its texglass.* setting (handwriting is texglass.previewStyle)
  const LIST = [
    { id: 'refPreviews', group: 'Previews on hover', label: 'References',
      hint: 'Rest on a link to a theorem, equation, section or figure to see it without leaving your place.',
      vscode: 'previews.references' },
    { id: 'footnotePreviews', group: 'Previews on hover', label: 'Footnotes',
      hint: 'Rest on a footnote mark to read the footnote.', vscode: 'previews.footnotes' },
    { id: 'citePreviews', group: 'Previews on hover', label: 'Citations',
      hint: 'Rest on a citation to see its bibliography entry.', vscode: 'previews.citations' },
    { id: 'citeLookup', group: 'Previews on hover', label: 'Look up cited papers online', needs: 'citePreviews',
      hint: 'Add the cited paper’s title, authors and abstract, found on DataCite, Crossref and arXiv, and a button to open it in TeXglass. The citation is sent to those services.',
      vscode: 'citationLookup' },
    { id: 'citedResults', group: 'Previews on hover', label: 'Cited theorems', needs: 'citeLookup',
      hint: '“[12, Theorem 4.1]” shows that theorem, from the cited paper’s source on arXiv.',
      vscode: 'citedTheoremPreviews' },
    { id: 'hypotheses', group: 'Previews on hover', label: 'Hypothesis checker', needs: 'refPreviews',
      hint: 'A result cited in a proof previews as its hypotheses, each with a box to tick, and its conclusion.',
      vscode: 'hypothesisChecker' },

    { id: 'notationHover', group: 'Notation and structure', label: 'Notation on hover',
      hint: 'Rest on a formula to see where its symbols are defined.',
      key: 'texglass:notationHover', yes: 'on', no: 'off', vscode: 'notationHover' },
    { id: 'proseDefinitions', group: 'Notation and structure', label: 'Symbols introduced in words',
      hint: 'Also find symbols the text defines in words (“let X be”, “denote by X”), for notation on hover and the notation index.',
      vscode: 'notationFromText' },
    { id: 'notationIndex', group: 'Notation and structure', label: 'Notation index',
      hint: 'The Notation tab of the side panel.', vscode: 'notationIndex' },
    { id: 'dependencyMap', group: 'Notation and structure', label: 'Dependency map',
      hint: 'The Map tab, the larger map (M) and “Uses / Used in” under previews.', vscode: 'dependencyMap' },
    { id: 'usesButtons', group: 'Notation and structure', label: '“What does this use?” buttons',
      hint: 'A button by each result that lights up what it rests on.', vscode: 'whatDoesThisUse' },

    { id: 'notes', group: 'Study', label: 'Highlights and notes',
      hint: 'Select text to highlight it or write a note in the margin.',
      key: 'texglass:study', yes: '1', no: '0', vscode: 'studyTools' },
    { id: 'progress', group: 'Study', label: 'Reading progress',
      hint: 'A marker by each result to note how far you have read it; progress shows in Contents and on the map.',
      key: 'texglass:progress', yes: '1', no: '0', vscode: 'readingProgress' },
    { id: 'proofSteps', group: 'Study', label: 'Step through proofs',
      hint: 'A “Step through” button by each proof shows it one sentence at a time.',
      vscode: 'stepThroughProofs' },

    { id: 'copyMath', group: 'Page', label: 'Click a formula to copy its LaTeX',
      hint: 'A click on a formula copies its source.', vscode: 'clickToCopyMath' },
    { id: 'handwriting', group: 'Page', label: 'Handwritten notes look', off: true,
      hint: 'Notes on squared paper, or chalk on a board in the dark theme. Also the pen button.',
      key: 'texglass:look', yes: 'notes', no: 'standard', vscode: 'previewStyle' },
  ];
  const BY_ID = new Map(LIST.map((f) => [f.id, f]));

  const keyOf = (f) => f.key || 'texglass:feature-' + f.id;
  const defaultOf = (f) => !f.off;

  /** Every feature's value from a { get(k) } store. */
  function read(store) {
    const out = {};
    for (const f of LIST) {
      let v = null;
      try { v = store && store.get(keyOf(f)); } catch (e) { v = null; }
      const yes = f.yes || '1';
      const no = f.no || '0';
      out[f.id] = v === yes ? true : v === no ? false : defaultOf(f);
    }
    return out;
  }

  /** Keep one feature's value in a { set(k, v) } store. */
  function write(store, id, on) {
    const f = BY_ID.get(id);
    if (!f || !store) return;
    try { store.set(keyOf(f), on ? (f.yes || '1') : (f.no || '0')); } catch (e) { /* storage unavailable */ }
  }

  /** Whether a feature is on, counting the ones it needs. */
  function on(prefs, id) {
    const f = BY_ID.get(id);
    if (!f) return true;
    if (prefs && prefs[id] === false) return false;
    if (prefs && prefs[id] === undefined && !defaultOf(f)) return false;
    return f.needs ? on(prefs, f.needs) : true;
  }

  /** The setting a hovered link's preview falls under. */
  function previewKind(a) {
    if (a && a.closest) {
      if (a.closest('sup.fn')) return 'footnotePreviews';
      if (a.closest('.cite')) return 'citePreviews';
    }
    return 'refPreviews';
  }

  /** What insight.setFeatures takes. */
  function insightParts(prefs) {
    return {
      map: on(prefs, 'dependencyMap'),
      notation: on(prefs, 'notationIndex'),
      uses: on(prefs, 'usesButtons'),
      words: on(prefs, 'proseDefinitions'),
    };
  }

  /** What sidePanel's setTabs takes. */
  function sideTabs(prefs) {
    return { deps: on(prefs, 'dependencyMap'), notation: on(prefs, 'notationIndex') };
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** The Settings dialog. See the top of the file. */
  function panel(o) {
    const doc = o.document || document;
    const ids = o.ids ? LIST.filter((f) => o.ids.includes(f.id)) : LIST;
    const dialog = doc.createElement('dialog');
    dialog.className = 'features-dialog';
    dialog.setAttribute('aria-labelledby', 'features-title');
    let html = '<div class="features-head"><h2 id="features-title">Settings</h2>' +
      '<button type="button" class="features-close" aria-label="Close">×</button></div>' +
      '<p class="features-intro">Switch TeXglass’s reading aids on or off. Choices are kept for every paper.</p>' +
      '<div class="features-list">';
    let group = null;
    for (const f of ids) {
      if (f.group !== group) {
        if (group !== null) html += '</fieldset>';
        group = f.group;
        html += `<fieldset><legend>${esc(group)}</legend>`;
      }
      html += `<label class="feature" data-feature="${f.id}"><input type="checkbox" data-id="${f.id}">` +
        `<span class="feature-text"><span class="feature-label">${esc(f.label)}</span>` +
        `<span class="feature-hint">${esc(f.hint)}</span></span></label>`;
    }
    if (group !== null) html += '</fieldset>';
    html += '</div><div class="features-foot"><button type="button" class="features-reset">Turn everything back on</button>' +
      '<button type="button" class="features-done primary">Done</button></div>';
    dialog.innerHTML = html;
    if (o.footer) dialog.querySelector('.features-foot').before(o.footer);
    (o.container || doc.body).appendChild(dialog);

    function refresh() {
      const prefs = o.get() || {};
      dialog.querySelectorAll('input[data-id]').forEach((box) => {
        const f = BY_ID.get(box.dataset.id);
        box.checked = prefs[f.id] === undefined ? defaultOf(f) : !!prefs[f.id];
        const blocked = f.needs && !on(prefs, f.needs);
        box.closest('.feature').classList.toggle('feature-blocked', !!blocked);
        box.closest('.feature').title = blocked ? `Works through “${BY_ID.get(f.needs).label}”, which is off` : '';
      });
    }
    dialog.addEventListener('change', (e) => {
      const box = e.target.closest('input[data-id]');
      if (!box) return;
      o.set(box.dataset.id, box.checked);
      refresh();
    });
    const close = () => { if (dialog.open) dialog.close(); else dialog.removeAttribute('open'); };
    dialog.querySelector('.features-close').addEventListener('click', close);
    dialog.querySelector('.features-done').addEventListener('click', close);
    dialog.querySelector('.features-reset').addEventListener('click', () => {
      const prefs = o.get() || {};
      for (const f of ids) {
        if (f.off) continue; // a look, not a reading aid
        if (prefs[f.id] === false) o.set(f.id, true);
      }
      refresh();
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // the backdrop

    return {
      element: dialog,
      open() {
        refresh();
        if (dialog.open) return;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        const first = dialog.querySelector('input[data-id]');
        if (first) first.focus();
      },
      close,
      refresh,
      isOpen: () => dialog.open || dialog.hasAttribute('open'),
    };
  }

  // The gear for a toolbar button.
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.6 7.6 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.6-1.5l2.4.9 2-3.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  return { LIST, read, write, on, previewKind, insightParts, sideTabs, panel, keyOf, ICON };
});
