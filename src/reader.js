/*
 * The reading tools inside an exported page (src/export.js page({ reader })),
 * made by the web viewer's "Export as HTML (with reading tools)" and by
 * `texglass paper.tex --reader`.
 *
 * The page holds the rendered document and, before this script, the same
 * shared modules the viewer uses: KaTeX and src/texglass.js (to draw symbols
 * in the notation index), src/popover.js, src/scroll.js, src/find.js,
 * src/copytex.js, src/insight.js and src/cite.js. This file only wires them
 * up, as the viewer does:
 *
 *   - previews of references, citations and footnotes on hover (a sheet on touch);
 *   - notation on hover and "What does this use?" (src/insight.js);
 *   - a side panel with Contents, the Map of which results use which, and the
 *     Notation index;
 *   - Navigate: Ctrl+F to find, Ctrl+G to go to "Lemma 4.1", Trace;
 *   - Back and forward after a jump (Alt+Left, Alt+Right);
 *   - cited papers' titles and abstracts (online only), click a formula to copy it.
 *
 * Choices (side panel open, its tab and width) are kept in this browser
 * under texglass:page-* when it allows storage, and nothing else is stored.
 * The document's macros and contents come in a JSON block, #tg-reader-data.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const preview = $('preview');
  const pane = $('preview-pane');
  const popover = $('ref-popover');
  const tocPane = $('toc-pane');
  const tocList = $('toc-list');
  const tocToggle = $('toc-toggle');
  if (!preview || !pane) return;

  let data = {};
  try { data = JSON.parse(($('tg-reader-data') || {}).textContent || '{}') || {}; } catch (e) { data = {}; }

  // Storage may be off (a private window, a file:// page in some browsers): then nothing is kept.
  const store = {
    get(k) { try { return localStorage.getItem(k.replace('texglass:', 'texglass:page-')); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k.replace('texglass:', 'texglass:page-'), v); } catch (e) { /* not kept */ } },
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // --- light and dark --------------------------------------------------------------

  // The page's own switch (src/export.js) sets data-theme; the icon follows it.
  const rootEl = document.documentElement;
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const isDark = () => (rootEl.dataset.theme ? rootEl.dataset.theme === 'dark' : !!(darkQuery && darkQuery.matches));
  const syncTheme = () => document.body.classList.toggle('theme-dark', isDark());
  syncTheme();
  if ($('theme-toggle')) $('theme-toggle').addEventListener('click', () => setTimeout(syncTheme));
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', syncTheme);

  // --- jumps, back and forward ---------------------------------------------------------

  if (window.TeXglassScroll && TeXglassScroll.history) TeXglassScroll.history(pane, { keys: window });
  const narrow = window.matchMedia('(max-width: 760px)');

  function jumpTo(target) {
    hidePopover();
    if (window.TeXglassScroll) TeXglassScroll.to(pane, target, { align: 'center' });
    else target.scrollIntoView({ block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // --- previews of references, citations and footnotes -----------------------------------

  const PREVIEW_LINKS = 'a.ref, .cite a, sup.fn a';
  const HIDE_DELAY = 250;
  let hideTimer = null;
  let popoverLink = null;
  let insight = null;
  let cites = null;
  const asSheet = () => !!(window.TeXglassPopover && TeXglassPopover.sheet && TeXglassPopover.sheet(window));

  function hidePopover() {
    clearTimeout(hideTimer);
    if (popover) popover.hidden = true;
    popoverLink = null;
  }
  function hidePopoverSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopover, HIDE_DELAY);
  }
  function showPopover(a, target) {
    if (!popover) return;
    clearTimeout(hideTimer);
    if (popoverLink === a && !popover.hidden) return;
    popoverLink = a;
    const body = document.createElement('div');
    body.className = 'ref-popover-body';
    let node = target;
    if (node.classList.contains('caption') && node.parentElement.tagName === 'FIGURE') node = node.parentElement;
    if (node.tagName === 'LI' && node.parentElement && node.parentElement.closest('.footnotes')) {
      const note = document.createElement('div');
      note.className = 'fn-preview';
      node.childNodes.forEach((c) => note.appendChild(c.cloneNode(true)));
      note.querySelectorAll('.fn-back').forEach((el) => el.remove());
      note.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      body.appendChild(note);
    } else if (/^H[1-6]$/.test(node.tagName)) {
      body.innerHTML = `<p><strong>${node.innerHTML}</strong></p>`;
    } else {
      const clone = node.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      body.appendChild(clone);
    }
    const used = insight && insight.usedByNote(target);
    if (used) body.appendChild(used);
    const cited = cites && cites.noteFor(target, { link: a, onChange: () => { if (popoverLink === a && !popover.hidden) placePopover(a, body); } });
    if (cited) body.appendChild(cited);
    if (asSheet()) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'tg-sheet-go';
      go.textContent = 'Go there';
      go.addEventListener('click', () => jumpTo(target));
      const head = document.createElement('div');
      head.className = 'tg-sheet-head';
      head.appendChild(go);
      body.prepend(head);
    }
    popover.replaceChildren(body);
    popover.hidden = false;
    placePopover(a, body);
  }
  function placePopover(a, body) {
    let width = Math.min(560, window.innerWidth - 32);
    popover.style.width = width + 'px';
    let extra = 0;
    body.querySelectorAll('.math-display, .tg-diagram').forEach((el) => { extra = Math.max(extra, el.scrollWidth - el.clientWidth); });
    if (extra > 0) popover.style.width = Math.min(width + extra + 2, window.innerWidth - 32) + 'px';
    if (window.TeXglassPopover) TeXglassPopover.place(popover, a);
  }
  const targetOf = (a) => document.getElementById((a.getAttribute('href') || '').slice(1));

  preview.addEventListener('mouseover', (e) => {
    if (asSheet()) return;
    const a = e.target.closest(PREVIEW_LINKS);
    const target = a && targetOf(a);
    if (target && !target.contains(a)) showPopover(a, target);
  });
  preview.addEventListener('mouseout', (e) => {
    if (asSheet() || !popover) return;
    const a = e.target.closest(PREVIEW_LINKS);
    if (!a || popover.hidden || a.contains(e.relatedTarget) || popover.contains(e.relatedTarget)) return;
    hidePopoverSoon();
  });
  preview.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    const target = a && targetOf(a);
    if (!target) return;
    e.preventDefault();
    if (asSheet() && a.matches(PREVIEW_LINKS) && !target.contains(a)) {
      if (popoverLink !== a || popover.hidden) showPopover(a, target);
      return;
    }
    jumpTo(target);
  });
  if (popover) {
    popover.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    popover.addEventListener('mouseleave', (e) => { if (!(popoverLink && popoverLink.contains(e.relatedTarget))) hidePopoverSoon(); });
    popover.addEventListener('tg-sheet-close', hidePopover);
    popover.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      const target = a && targetOf(a);
      if (!target) return;
      e.preventDefault();
      jumpTo(target);
    });
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popover && !popover.hidden) hidePopover(); });

  // Click a formula to copy its LaTeX.
  if (window.TeXglassCopyTex) TeXglassCopyTex.attach({ roots: [preview, popover].filter(Boolean) });

  // --- citations, notation and dependencies ------------------------------------------

  // A paper on arXiv opens in the TeXglass web viewer; titles and abstracts are looked up online.
  const VIEWER = 'https://klepo0.github.io/TeXglass/';
  cites = window.TeXglassCite
    ? TeXglassCite.create({
      openArxiv: (id, goto) => window.open(VIEWER + '?arxiv=' + encodeURIComponent(id) + (goto ? '&goto=' + encodeURIComponent(goto) : ''), '_blank', 'noopener'),
    })
    : null;
  if (cites) cites.decorate(preview);

  insight = window.TeXglassInsight
    ? TeXglassInsight.attach({
      root: preview,
      jump: (el) => jumpTo(el),
      onEditSearch: () => { if (finder) finder.open('uses'); },
      renderTex: (texs, defs) => (window.TeXglass && TeXglass.renderSnippets ? TeXglass.renderSnippets(defs, texs) : null),
      hover: store.get('texglass:notationHover') !== 'off',
      onHoverChange: (on) => store.set('texglass:notationHover', on ? 'on' : 'off'),
      notationOrder: store.get('texglass:notation-order'),
      onNotationOrder: (order) => store.set('texglass:notation-order', order),
      print: () => window.print(),
    })
    : null;
  if (insight && data.defs) insight.setDefinitions(data.defs);

  // --- the side panel: Contents, Map, Notation ----------------------------------------

  const toc = Array.isArray(data.toc) ? data.toc.slice() : [];
  const bib = preview.querySelector('.bibliography > h2');
  if (bib && toc.length && !toc.some((t) => t.id === (bib.id || 'references'))) {
    bib.id = bib.id || 'references';
    toc.push({ level: Math.min(...toc.map((t) => t.level)), num: '', title: escapeHtml(bib.textContent), id: bib.id });
  }
  let tocLinks = [];
  if (tocList) {
    const top = toc.length ? Math.min(...toc.map((t) => t.level)) : 0;
    // Titles come from the converter as HTML (they may hold math).
    tocList.innerHTML = toc.length
      ? toc.map((t) => `<li class="toc-d${Math.min(3, t.level - top)}"><a href="#${escapeHtml(t.id)}" data-id="${escapeHtml(t.id)}">${t.num ? `<span class="toc-num">${escapeHtml(t.num)}</span>` : ''}<span class="toc-title">${t.title}</span></a></li>`).join('')
      : '<li class="toc-empty">This document has no sections.</li>';
    tocLinks = Array.from(tocList.querySelectorAll('a'));
  }
  const hasPanel = !!tocPane && (tocLinks.length > 0 || !!insight);
  let tocWanted = hasPanel && !narrow.matches && store.get('texglass:toc') !== 'off';

  function showToc() {
    if (!tocPane) return;
    tocPane.hidden = !(tocWanted && hasPanel);
    document.body.classList.toggle('toc-open', !tocPane.hidden);
    if (tocToggle) {
      tocToggle.hidden = !hasPanel;
      tocToggle.setAttribute('aria-pressed', String(!tocPane.hidden));
    }
  }
  function spyToc() {
    if (!tocPane || tocPane.hidden || !tocLinks.length) return;
    const limit = pane.getBoundingClientRect().top + 48;
    let current = null;
    for (const a of tocLinks) {
      const h = document.getElementById(a.dataset.id);
      if (!h || !h.offsetParent) continue;
      if (h.getBoundingClientRect().top <= limit) current = a;
      else break;
    }
    tocLinks.forEach((a) => a.classList.toggle('active', a === current));
  }
  let spyFrame = 0;
  pane.addEventListener('scroll', () => {
    if (popover && !popover.hidden && !asSheet()) hidePopover();
    if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; spyToc(); });
  }, { passive: true });
  if (tocList) {
    tocList.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-id]');
      if (!a) return;
      e.preventDefault();
      const target = document.getElementById(a.dataset.id);
      if (!target) return;
      if (window.TeXglassScroll) TeXglassScroll.to(pane, target);
      else target.scrollIntoView();
      if (narrow.matches) { tocWanted = false; showToc(); }
    });
  }
  if (tocToggle) {
    tocToggle.addEventListener('click', () => {
      tocWanted = !tocWanted;
      if (!narrow.matches) store.set('texglass:toc', tocWanted ? 'on' : 'off');
      showToc();
      spyToc();
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (narrow.matches && tocWanted && tocPane && !tocPane.contains(e.target) && !(tocToggle && tocToggle.contains(e.target))) { tocWanted = false; showToc(); }
  });
  if (insight && tocPane) {
    TeXglassInsight.sidePanel({
      pane: tocPane,
      head: tocPane.querySelector('.toc-pane-head'),
      list: tocList,
      insight,
      store,
      onJump: () => { if (narrow.matches) { tocWanted = false; showToc(); } },
      onTab: (tab) => { if (tab === 'toc') spyToc(); },
    });
  }
  showToc();
  spyToc();

  // --- Navigate: find, go to, trace, uses ---------------------------------------------------

  const findButton = $('find');
  let finder = null;
  if (window.TeXglassFind) {
    finder = TeXglassFind.attach({
      root: preview,
      scroller: pane,
      reveal: () => {},
      onJump: hidePopover,
      onFocus: (el) => { if (insight) insight.focus(el, 'both', { scroll: true, collapse: true }); },
      related: (el) => (insight ? insight.related(el) : null),
      uses: (q) => (insight ? insight.searchUses(q) : null),
      onUses: (q, el) => { if (insight) insight.showUses(q, { at: el, scroll: true, collapse: true }); },
    });
    TeXglassFind.bindKeys(window, finder);
    if (findButton) findButton.addEventListener('click', () => finder.open('find'));
  } else if (findButton) {
    findButton.hidden = true;
  }
})();
