/*
 * The TeXglass preview inside VS Code. It receives the rendered blocks from the
 * extension, keeps the DOM of blocks that did not change, and reports where
 * it is scrolled to (as a source line) so the editor can follow, and back.
 */
/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  // Settings (shared/features.js): which reading aids are on, from the texglass.* settings.
  const Features = window.TeXglassFeatures || null;
  let features = {};
  const featureOn = (id) => !Features || Features.on(features, id);
  const preview = document.getElementById('preview');
  const pane = document.getElementById('preview-pane');
  const popover = document.getElementById('ref-popover');
  const status = document.getElementById('status');

  // --- theme ---------------------------------------------------------------------

  // Follow VS Code's colour theme rather than the system one.
  // Unless the texglass.previewTheme setting picks light or dark.
  let forcedTheme = 'auto';
  const applyTheme = () => {
    const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    const vsTheme = dark && !document.body.classList.contains('vscode-high-contrast-light') ? 'dark' : 'light';
    document.documentElement.dataset.theme = forcedTheme === 'light' || forcedTheme === 'dark' ? forcedTheme : vsTheme;
  };
  applyTheme();
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // --- showing blocks ----------------------------------------------------------------

  let shown = []; // [{ html, nodes, line, end }] in document order

  const BLOCK_HEAD = /^<div class="src-block" data-s="\d+" data-e="\d+">/;
  const bodyOf = (html) => html.replace(BLOCK_HEAD, '');

  function toEntries(blocks, lines) {
    if (!blocks.length) return [];
    const tpl = document.createElement('template');
    tpl.innerHTML = blocks.join('<!--b-->');
    const entries = blocks.map((html, k) => ({ html, nodes: [], range: lines[k] }));
    let k = 0;
    for (const node of Array.from(tpl.content.childNodes)) {
      if (node.nodeType === 8 && node.data === 'b') k++;
      else entries[k].nodes.push(node);
    }
    return entries;
  }

  function show(blocks, lines) {
    if (!blocks.length) {
      blocks = ['<p class="empty-doc">This document is empty.</p>'];
      lines = [null];
    }
    const old = shown;
    const same = (entry, html) => entry.html === html || bodyOf(entry.html) === bodyOf(html);
    let p = 0;
    while (p < old.length && p < blocks.length && same(old[p], blocks[p])) p++;
    let q = 0;
    while (q < old.length - p && q < blocks.length - p && same(old[old.length - 1 - q], blocks[blocks.length - 1 - q])) q++;
    const keep = (entry, k) => {
      entry.html = blocks[k];
      entry.range = lines[k];
      return entry;
    };
    for (let k = 0; k < p; k++) keep(old[k], k);
    for (let k = 1; k <= q; k++) keep(old[old.length - k], blocks.length - k);
    for (const entry of old.slice(p, old.length - q)) entry.nodes.forEach((n) => n.remove());
    const fresh = toEntries(blocks.slice(p, blocks.length - q), lines.slice(p, blocks.length - q));
    const tail = old.slice(old.length - q);
    const ref = tail.length && tail[0].nodes.length ? tail[0].nodes[0] : null;
    for (const entry of fresh) entry.nodes.forEach((n) => preview.insertBefore(n, ref));
    shown = old.slice(0, p).concat(fresh, tail);
    // Blocks with a source range, for scrolling in step with the editor.
    allAnchors = shown.filter((e) => e.range && e.nodes[0] && e.nodes[0].nodeType === 1).map((e) => ({ el: e.nodes[0], line: e.range[0], end: e.range[1], file: e.range[2] || 0 }));
    applyFolds();
    if (margin) margin.refresh();
  }

  // --- the margin: \marginpar and \todo, and the reader's highlights and notes ---------

  // The reader's notes live in a file next to the .tex (paper.texglass.json),
  // which the extension reads and writes; they are anchored by their text.
  let sourceFiles = [];
  let noteSeq = 0;
  const noteWaiting = new Map();
  const margin = window.TeXglassMargin
    ? window.TeXglassMargin.attach({
      pane,
      doc: preview,
      blocks: () => allAnchors,
      files: () => sourceFiles,
      save: (list) => vscode.postMessage({ type: 'annotations', list }),
      renderNote: (text) => new Promise((resolve) => {
        const id = ++noteSeq;
        noteWaiting.set(id, resolve);
        vscode.postMessage({ type: 'render-note', id, text });
      }),
      study: false,
      onWidth: (w) => vscode.postMessage({ type: 'side-pref', key: 'texglass:margin-width', value: w }),
      onCollapse: (on) => vscode.postMessage({ type: 'side-pref', key: 'texglass:margin-collapsed', value: on }),
      onPadMove: (at) => vscode.postMessage({ type: 'side-pref', key: 'texglass:note-pad', value: at }),
    })
    : null;

  // --- folding sections and proofs (as in the web viewer) ---------------------------

  // Folds are remembered by the text of the heading or the start of the proof,
  // so they survive edits elsewhere; the extension keeps them between sessions.
  const folded = new Set();
  let hasProofs = false;
  let proofsFolded = false;
  const HEADING = ':scope > h1.part, :scope > h1.chapter, :scope > h2.section, :scope > h3.subsection, :scope > h4.subsubsection';

  /** The heading level of a top-level block, or 0 if it is not a heading. */
  function levelOf(block) {
    if (block.classList.contains('footnotes')) return 1;
    if (!block.classList.contains('src-block')) return 0;
    const h = block.querySelector(HEADING);
    if (h) return Number(h.tagName[1]) + (h.classList.contains('chapter') ? 0.5 : 0);
    return block.querySelector(':scope > .bibliography') ? 2 : 0;
  }

  function toggleButton(key, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fold-toggle';
    b.dataset.key = key;
    b.setAttribute('aria-label', label);
    b.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return b;
  }

  function applyFolds() {
    // Section headings: a toggle on each, and hide what follows a folded one.
    let hideAt = 0;
    for (const block of Array.from(preview.children)) {
      const lvl = levelOf(block);
      if (hideAt && lvl && lvl <= hideAt) hideAt = 0;
      block.classList.toggle('fold-hidden', !!hideAt);
      const h = lvl && block.querySelector(HEADING);
      if (!h) continue;
      let btn = h.querySelector(':scope > .fold-toggle');
      if (!btn) {
        btn = toggleButton('h:' + h.textContent.trim(), 'Fold or unfold this section');
        h.prepend(btn);
      }
      const isFolded = folded.has(btn.dataset.key);
      h.classList.toggle('folded', isFolded);
      btn.setAttribute('aria-expanded', String(!isFolded));
      if (isFolded && !hideAt) hideAt = lvl;
    }
    // Proofs: fold down to their first line.
    const proofs = preview.querySelectorAll('.proof');
    let n = 0;
    for (const proof of proofs) {
      let btn = proof.querySelector(':scope > p:first-child > .fold-toggle');
      if (!btn) {
        const first = proof.firstElementChild;
        if (!first) continue;
        btn = toggleButton('p:' + proof.textContent.trim().slice(0, 80), 'Fold or unfold this proof');
        first.prepend(btn);
      }
      const isFolded = folded.has(btn.dataset.key);
      proof.classList.toggle('folded', isFolded);
      btn.setAttribute('aria-expanded', String(!isFolded));
      if (isFolded) n++;
    }
    anchors = allAnchors.filter((a) => !a.el.classList.contains('fold-hidden'));
    const has = proofs.length > 0;
    const all = has && n === proofs.length;
    if (has !== hasProofs || all !== proofsFolded) {
      hasProofs = has;
      proofsFolded = all;
      vscode.postMessage({ type: 'proofs', has, folded: all });
    }
  }

  function setFold(key, on) {
    if (on) folded.add(key);
    else folded.delete(key);
  }
  const saveFolds = () => vscode.postMessage({ type: 'folds', keys: Array.from(folded) });

  function foldAllProofs(fold) {
    preview.querySelectorAll('.proof > p:first-child > .fold-toggle').forEach((t) => setFold(t.dataset.key, fold));
    saveFolds();
    applyFolds();
    spyToc();
  }

  /** Unfold whatever hides `el`, so a reference to it can be followed. */
  function reveal(el) {
    let changed = false;
    const proof = el.closest('.proof.folded');
    if (proof) {
      setFold(proof.querySelector('.fold-toggle').dataset.key, false);
      changed = true;
    }
    const block = el.closest('#preview > *');
    if (block && block.classList.contains('fold-hidden')) {
      // Unfold every folded heading above it that still covers it.
      let need = Infinity;
      for (let b = block.previousElementSibling; b; b = b.previousElementSibling) {
        const lvl = levelOf(b);
        if (lvl && lvl < need) {
          const btn = b.querySelector('.fold-toggle');
          if (btn) setFold(btn.dataset.key, false);
          need = lvl;
        }
      }
      changed = true;
    }
    if (changed) {
      saveFolds();
      applyFolds();
    }
  }

  // A click on a toggle, a section heading or a folded proof folds or unfolds it.
  preview.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) return; // that is a jump to the source
    const btn = e.target.closest('.fold-toggle');
    const onFormula = !!e.target.closest('.math-copyable .math[data-tex]'); // that click copies it
    const foldedProof = !btn && !onFormula && e.target.closest('.proof.folded');
    const heading = !btn && !onFormula && !e.target.closest('a') && e.target.closest('#preview > .src-block > h1, #preview > .src-block > h2, #preview > .src-block > h3, #preview > .src-block > h4');
    const target = btn || (foldedProof && foldedProof.querySelector('.fold-toggle')) || (heading && heading.querySelector(':scope > .fold-toggle'));
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setFold(target.dataset.key, !folded.has(target.dataset.key));
    saveFolds();
    applyFolds();
    spyToc();
  });

  // --- contents sidebar ------------------------------------------------------------------

  const tocPane = document.getElementById('toc-pane');
  const tocList = document.getElementById('toc-list');
  const narrow = window.matchMedia('(max-width: 760px)');

  // The text's width: grips on its edges (src/textwidth.js); the extension keeps it
  // for every preview (prefs: textWidth).
  const textWidth = window.TeXglassTextWidth
    ? window.TeXglassTextWidth.attach({
      doc: preview,
      pane,
      store: { get: () => null, set: (value) => vscode.postMessage({ type: 'side-pref', key: 'texglass:text-width', value }) },
      avoid: [tocPane], // the side panel, a drawer over the text in a narrow preview
    })
    : null;
  let tocWanted = !narrow.matches;
  let toc = [];
  let tocKey = '';
  let tocLinks = [];
  let tocJump = 0; // while a jump from the sidebar scrolls, keep its entry highlighted
  const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function updateToc(items) {
    items = items.slice();
    // The bibliography gets an entry too, where it is in the document (before any appendix).
    const bib = preview.querySelector('.bibliography > h2');
    if (bib && items.length) {
      bib.id = bib.id || 'references';
      const entry = { level: Math.min(...items.map((t) => t.level)), num: '', title: escapeHtml(bib.textContent), id: bib.id };
      const after = items.findIndex((t) => { const h = document.getElementById(t.id); return h && bib.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING; });
      items.splice(after < 0 ? items.length : after, 0, entry);
    }
    toc = items;
    const key = JSON.stringify(items);
    if (key !== tocKey) {
      tocKey = key;
      const top = Math.min(...items.map((t) => t.level));
      tocList.innerHTML = items
        .map((t) => `<li class="toc-d${Math.min(3, t.level - top)}"><a href="#${escapeHtml(t.id)}" data-id="${escapeHtml(t.id)}">${t.num ? `<span class="toc-num">${escapeHtml(t.num)}</span>` : ''}<span class="toc-title">${t.title}</span></a></li>`)
        .join('');
      tocLinks = Array.from(tocList.querySelectorAll('a'));
    }
    showToc();
  }

  function showToc() {
    tocPane.hidden = !(tocWanted && toc.length);
    spyToc();
  }

  function markToc(current) {
    if (current === tocList.querySelector('a.active')) return;
    tocLinks.forEach((a) => a.classList.toggle('active', a === current));
    if (current) {
      const r = current.getBoundingClientRect();
      const pr = tocPane.getBoundingClientRect();
      if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) tocPane.scrollTop += r.top - pr.top - pr.height / 3;
    }
  }

  /** Highlight the section at the top of the preview. */
  function spyToc() {
    if (tocPane.hidden || tocList.hidden || !tocLinks.length || Date.now() < tocJump) return;
    const limit = pane.getBoundingClientRect().top + 48;
    let current = null;
    for (const a of tocLinks) {
      const h = document.getElementById(a.dataset.id);
      if (!h || !h.offsetParent) continue;
      if (h.getBoundingClientRect().top <= limit) current = a;
      else break;
    }
    // At the very bottom, the last heading on screen is the current one.
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) {
      for (const a of tocLinks) {
        const h = document.getElementById(a.dataset.id);
        if (h && h.offsetParent && h.getBoundingClientRect().top < pane.getBoundingClientRect().bottom) current = a;
      }
    }
    markToc(current);
  }

  tocList.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.dataset.id);
    if (!target) return;
    reveal(target);
    TeXglassScroll.to(pane, target);
    markToc(a);
    tocJump = Date.now() + 1000;
    if (narrow.matches) {
      tocWanted = false;
      showToc();
      vscode.postMessage({ type: 'toc', on: false });
    }
  });
  let spyFrame = 0;
  pane.addEventListener('scroll', () => {
    if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; spyToc(); });
  }, { passive: true });
  pane.addEventListener('scrollend', () => { tocJump = 0; spyToc(); });
  // On a narrow preview the contents open as a drawer; a click elsewhere closes it.
  document.addEventListener('pointerdown', (e) => {
    if (narrow.matches && tocWanted && !tocPane.contains(e.target)) {
      tocWanted = false;
      showToc();
      vscode.postMessage({ type: 'toc', on: false });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && narrow.matches && tocWanted) {
      tocWanted = false;
      showToc();
      vscode.postMessage({ type: 'toc', on: false });
    }
  });

  // The contents go on the left or the right (the texglass.contentsPosition setting).
  const tocSide = document.getElementById('toc-side');
  function setTocSide(right) {
    document.body.classList.toggle('toc-right', right);
    const label = right ? 'Move the contents to the left' : 'Move the contents to the right';
    tocSide.setAttribute('aria-label', label);
    tocSide.title = label;
  }
  tocSide.addEventListener('click', () => {
    const right = !document.body.classList.contains('toc-right');
    setTocSide(right); // straight away; the setting follows
    vscode.postMessage({ type: 'set-toc-side', value: right ? 'right' : 'left' });
  });

  // --- zoom -----------------------------------------------------------------------------

  // The texglass.zoomIn / zoomOut / resetZoom commands (Ctrl/Cmd +, - and 0,
  // which VS Code runs for keys pressed in here too) scale the document. The
  // level shows in a small box at the bottom left while it is not 100%.
  const zoomFloat = document.getElementById('zoom-float');
  const zoomLevel = document.getElementById('zoom-level');
  let zoomHide = 0;
  const zoom = window.TeXglassZoom
    ? window.TeXglassZoom.create({
      pane,
      document: preview,
      onChange(z) {
        vscode.postMessage({ type: 'zoomed', level: z });
        showZoom(true);
      },
    })
    : null;
  function showZoom(changed) {
    zoomLevel.textContent = zoom.label();
    clearTimeout(zoomHide);
    zoomFloat.hidden = zoom.level === 1 && !changed;
    if (zoom.level === 1 && changed) zoomHide = setTimeout(() => { if (zoom.level === 1) zoomFloat.hidden = true; }, 1500);
  }
  if (zoom) {
    document.getElementById('zoom-in').addEventListener('click', () => zoom.step(1));
    document.getElementById('zoom-out').addEventListener('click', () => zoom.step(-1));
    zoomLevel.addEventListener('click', () => zoom.reset());
    // Ctrl + mouse wheel or a trackpad pinch zooms too.
    pane.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom.set(zoom.level * Math.exp(-e.deltaY / 300));
    }, { passive: false });
  }

  // --- scrolling in step with the editor -------------------------------------------

  let allAnchors = []; // every block with a source range
  let anchors = []; // those not hidden in a folded section
  let ignoreScrollUntil = 0;

  const topOf = (el) => el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;

  /** Scroll so that line `line` of source file number `file` is at the top. */
  function scrollToLine(line, file) {
    // Blocks from that file (a document can pull in several with \input).
    const anchors = allVisible().filter((a) => a.file === (file || 0));
    if (!anchors.length) return;
    let lo = 0;
    let hi = anchors.length - 1;
    if (line < anchors[0].line) {
      // Above the first block: the top of the document for the main file, but
      // the start of its part for a file pulled in with \input (an editor that
      // has just opened one is at its first line).
      pane.scrollTop = file ? Math.max(0, topOf(anchors[0].el) - 8) : 0;
    } else {
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (anchors[mid].line <= line) lo = mid;
        else hi = mid - 1;
      }
      const a = anchors[lo];
      const next = anchors[lo + 1];
      const top = topOf(a.el);
      let y = top;
      if (line > a.end && next) {
        // Between two blocks: interpolate across the gap.
        const t = (line - a.end) / Math.max(1, next.line - a.end);
        y = top + a.el.offsetHeight + t * (topOf(next.el) - top - a.el.offsetHeight);
      } else {
        y = top + ((line - a.line) / Math.max(1, a.end - a.line + 1)) * a.el.offsetHeight;
      }
      pane.scrollTop = Math.max(0, y - 8);
    }
    ignoreScrollUntil = Date.now() + 200;
  }

  const allVisible = () => anchors;

  // --- jumping to the cursor (forward sync) -----------------------------------------

  let syncMark = null;

  /** Bring line `line` of source file number `file` to the middle of the preview and light it up. */
  function showLine(line, file) {
    const own = allAnchors.filter((a) => a.file === (file || 0));
    if (!own.length) return;
    let lo = 0;
    let hi = own.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (own[mid].line <= line) lo = mid;
      else hi = mid - 1;
    }
    let a = own[lo];
    // On a blank line or a comment between two blocks: whichever is nearer.
    const next = own[lo + 1];
    if (line > a.end && next && next.line - line < line - a.end) a = next;
    // Unfold a section or proof that hides it.
    reveal(a.el);
    const proof = a.el.querySelector('.proof.folded');
    if (proof) reveal(proof);
    if (syncMark) syncMark.remove();
    // A band at that line's share of the block (the whole block when it is
    // short). Sizes are in % so they hold while the block gets its real height.
    const mark = document.createElement('div');
    mark.className = 'sync-mark';
    const n = a.end - a.line + 1;
    if (n > 3) {
      const t = Math.max(0, Math.min(1, (line - a.line + 0.5) / n));
      mark.style.top = `calc(${(t * 100).toFixed(2)}% - 0.8em)`;
      mark.style.height = '1.6em';
    }
    a.el.appendChild(mark);
    syncMark = mark;
    setTimeout(() => {
      if (syncMark === mark) syncMark = null;
      mark.remove();
    }, 5000);
    // (A far target is jumped to, with only a short glide at the end.)
    TeXglassScroll.to(pane, mark, {
      align: 'center',
      history: false, // following the editor is not a jump to come back from
      done() {
        if (syncMark === mark) ignoreScrollUntil = Date.now() + 150;
      },
    });
    // The editor stays where it is: this scroll is not one to follow. (Set
    // after starting it, as starting it ends a jump that was under way.)
    ignoreScrollUntil = Infinity;
  }

  /** The source file and line at the top of the preview. */
  function lineAtTop() {
    if (!anchors.length) return { line: 0, file: 0 };
    const y = pane.scrollTop + 8;
    let lo = 0;
    let hi = anchors.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (topOf(anchors[mid].el) <= y) lo = mid;
      else hi = mid - 1;
    }
    const a = anchors[lo];
    const h = a.el.offsetHeight || 1;
    const t = Math.max(0, Math.min(1, (y - topOf(a.el)) / h));
    return { line: a.line + t * (a.end - a.line + 1), file: a.file };
  }

  let scrollFrame = 0;
  pane.addEventListener('scroll', () => {
    if (Date.now() < ignoreScrollUntil || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const at = lineAtTop();
      vscode.postMessage({ type: 'scroll', line: at.line, file: at.file });
    });
  }, { passive: true });

  // Ctrl+click (Cmd+click on a Mac) or double-click goes to that spot in the
  // source. The extension finds it from the block's source range, the word
  // that was clicked and how far into the block it is.
  function whereClicked(e) {
    const anchor = anchors.find((a) => a.el.contains(e.target));
    if (!anchor) return null;
    const block = anchor.el;
    const msg = { type: 'reveal-at', s: Number(block.dataset.s), e: Number(block.dataset.e), line: anchor.line };
    const math = e.target.closest('.katex');
    if (math) {
      const ann = math.querySelector('annotation');
      msg.tex = ann ? ann.textContent.trim() : '';
      return msg;
    }
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || node.nodeType !== 3 || !block.contains(node)) {
      const r = block.getBoundingClientRect();
      msg.fraction = Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1)));
      return msg;
    }
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(node, offset);
    msg.fraction = range.toString().length / Math.max(1, block.textContent.length);
    msg.head = (/[\p{L}\p{N}]{1,16}$/u.exec(node.data.slice(0, offset)) || [''])[0];
    msg.tail = (/^[\p{L}\p{N}]{0,16}/u.exec(node.data.slice(offset)) || [''])[0];
    return msg;
  }

  function goToSource(e) {
    const msg = whereClicked(e);
    if (!msg) return false;
    vscode.postMessage(msg);
    return true;
  }

  // A single click on a formula copies its LaTeX. It waits out the double-click
  // time, so a double-click (jump to the source) does not copy.
  const copier = window.TeXglassCopyTex
    ? window.TeXglassCopyTex.attach({
      roots: [preview, popover],
      delay: 300,
      write: (text) => vscode.postMessage({ type: 'copy-tex', text }),
    })
    : null;

  preview.addEventListener('dblclick', (e) => {
    if (e.target.closest('a')) return;
    goToSource(e);
  });

  // --- links and reference previews -----------------------------------------------------

  preview.addEventListener('click', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      hidePopover();
      goToSource(e);
      return;
    }
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    e.preventDefault();
    if (!href.startsWith('#')) {
      vscode.postMessage({ type: 'open-link', href });
      return;
    }
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    if (!target) return;
    jumpTo(target);
  });

  function jumpTo(target) {
    hidePopover();
    reveal(target);
    TeXglassScroll.to(pane, target, { align: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // Citation previews (shared/cite.js). The webview may not reach the network,
  // so the extension does the lookups and sends the answers back.
  const pendingJson = new Map();
  let jsonId = 0;
  const cites = window.TeXglassCite
    ? window.TeXglassCite.create({
      getJson: (url) => new Promise((resolve, reject) => {
        const id = ++jsonId;
        pendingJson.set(id, { resolve, reject });
        vscode.postMessage({ type: 'fetch-json', id, url });
      }),
      openArxiv: (id, goto) => vscode.postMessage({ type: 'open-arxiv', id, goto }),
      openLink: (href) => vscode.postMessage({ type: 'open-link', href }),
      // "[12, Theorem 4.1]": the extension fetches the cited paper from arXiv and converts it
      loadPaper: (arxiv) => new Promise((resolve, reject) => {
        const id = ++jsonId;
        pendingJson.set(id, { resolve, reject });
        vscode.postMessage({ type: 'cited-paper', id, arxiv });
      }),
    })
    : null;
  // .pdf and .eps figures, which the webview cannot show as they are: drawn (PDF
  // with pdf.js, EPS with the PostScript interpreter) and kept per file version.
  const drawnFigures = new Map(); // figure URL -> Promise of an object URL, or null
  const latin1 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return out;
  };
  /** A .pdf or .eps figure drawn as an image Blob, or null. */
  async function figureImage(src, kind) {
    try {
      const blob = await (await fetch(src)).blob();
      if (kind === 'pdf') return window.TeXglassPdf ? await window.TeXglassPdf.toImage(blob) : null;
      const r = window.TeXglassEps ? window.TeXglassEps.toSvg(latin1(new Uint8Array(await blob.arrayBuffer()))) : null;
      return r ? new Blob([r.svg], { type: 'image/svg+xml' }) : null;
    } catch (e) {
      return null;
    }
  }
  async function drawFigure(src, kind) {
    const image = await figureImage(src, kind);
    return image ? URL.createObjectURL(image) : null;
  }
  /**
   * A document's HTML ready for an e-book (src/epub.js): every figure as a
   * data: URL, PDF and EPS figures drawn as images first, and the diagrams
   * drawn, since e-readers do not run this page's scripts.
   */
  async function prepareEpub(html) {
    const box = document.createElement('template');
    box.innerHTML = html;
    const toDataUrl = (blob) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    const done = new Map();
    for (const img of box.content.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;
      if (!done.has(src)) {
        done.set(src, (async () => {
          const kind = /\.pdf(\?|$)/i.test(src) ? 'pdf' : /\.e?ps(\?|$)/i.test(src) ? 'eps' : null;
          const blob = kind ? await figureImage(src, kind) : await (await fetch(src)).blob();
          return blob ? toDataUrl(blob) : null;
        })().catch(() => null));
      }
      const data = await done.get(src);
      if (data) img.setAttribute('src', data);
    }
    let out = box.innerHTML;
    if (window.TeXglassEpub && /class="tg-diagram/.test(out)) out = await window.TeXglassEpub.drawDiagrams(out, document);
    return out;
  }
  function drawFigures() {
    for (const img of preview.querySelectorAll('img.graphic')) {
      const src = img.getAttribute('src') || '';
      const kind = /\.pdf(\?|$)/i.test(src) ? 'pdf' : /\.e?ps(\?|$)/i.test(src) ? 'eps' : null;
      if (!kind) continue;
      if (!drawnFigures.has(src)) drawnFigures.set(src, drawFigure(src, kind));
      drawnFigures.get(src).then((url) => {
        if (url && img.getAttribute('src') === src) img.src = url;
      });
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || (m.type !== 'json' && m.type !== 'cited-paper') || !pendingJson.has(m.id)) return;
    const p = pendingJson.get(m.id);
    pendingJson.delete(m.id);
    if (m.ok) p.resolve(m.type === 'json' ? m.json : m.html);
    else p.reject(Object.assign(new Error(m.error || 'Request failed'), m.status ? { status: m.status } : {}));
  });

  // The popover stays open while the pointer is on the link or on the popover
  // itself, so a long preview can be scrolled. It closes a moment after the
  // pointer has left both.
  const HIDE_DELAY = 250;
  // References, citations and footnote marks.
  const PREVIEW_LINKS = 'a.ref, .cite a, sup.fn a';
  let hideTimer = null;
  let popoverLink = null;
  let popoverChip = null; // the "why?" chip that opened it (shared/steps.js)
  function hidePopover() {
    clearTimeout(hideTimer);
    popover.hidden = true;
    popoverLink = null;
    popoverChip = null;
  }
  function hidePopoverSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopover, HIDE_DELAY);
  }
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest(PREVIEW_LINKS);
    if (!a) return;
    if (Features && !featureOn(Features.previewKind(a))) return; // switched off in Settings
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target || target.contains(a)) return;
    showPopover(a, target);
  });
  function showPopover(a, target) {
    clearTimeout(hideTimer);
    if (popoverLink === a && !popover.hidden) return;
    popoverLink = a;
    const body = document.createElement('div');
    body.className = 'ref-popover-body';
    let node = target;
    if (node.classList.contains('caption') && node.parentElement.tagName === 'FIGURE') node = node.parentElement;
    if (node.tagName === 'LI' && node.parentElement && node.parentElement.closest('.footnotes')) {
      // A footnote: its text, without the list number or the back link.
      const note = document.createElement('div');
      note.className = 'fn-preview';
      node.childNodes.forEach((c) => note.appendChild(c.cloneNode(true)));
      note.querySelectorAll('.fn-back').forEach((el) => el.remove());
      note.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      body.appendChild(note);
    } else if (/^H[1-6]$/.test(node.tagName)) {
      const p = document.createElement('p');
      const b = document.createElement('strong');
      b.innerHTML = node.innerHTML;
      p.appendChild(b);
      body.appendChild(p);
    } else {
      const clone = node.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      // A result cited in a proof: its hypotheses and conclusion, with boxes to tick (shared/hypotheses.js).
      const split = hypotheses && featureOn('hypotheses') && hypotheses.viewFor(target, a, clone);
      body.appendChild(split || clone);
    }
    const used = insight && insight.usedByNote(target);
    if (used) body.appendChild(used);
    // A citation: the cited paper's title and abstract, looked up by the extension now.
    const cited = cites && featureOn('citeLookup') && cites.noteFor(target, { link: a, results: featureOn('citedResults'), onChange: () => { if (popoverLink === a && !popover.hidden) placePopover(a, body); } });
    if (cited) body.appendChild(cited);
    popover.replaceChildren(body);
    popover.hidden = false;
    placePopover(a, body);
  }
  function placePopover(a, body) {
    let width = Math.min(560, window.innerWidth - 32);
    popover.style.width = width + 'px';
    // Widen it, up to the window, for a display that is wider than that, so the
    // formula and its equation number fit without scrolling.
    let extra = 0;
    body.querySelectorAll('.math-display, .tg-diagram').forEach((el) => {
      extra = Math.max(extra, el.scrollWidth - el.clientWidth);
    });
    if (extra > 0) {
      width = Math.min(width + extra + 2, window.innerWidth - 32);
      popover.style.width = width + 'px';
    }
    // below or above, whichever fits; capped to the window and scrolled when it fits on neither side
    TeXglassPopover.place(popover, a);
  }
  preview.addEventListener('mouseout', (e) => {
    const a = e.target.closest(PREVIEW_LINKS);
    if (!a || popover.hidden || a.contains(e.relatedTarget)) return;
    if (popover.contains(e.relatedTarget)) return; // moving into the popover
    hidePopoverSoon();
  });
  popover.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  popover.addEventListener('mouseleave', (e) => {
    if (popoverLink && popoverLink.contains(e.relatedTarget)) return;
    hidePopoverSoon();
  });
  popover.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (!href.startsWith('#')) {
      vscode.postMessage({ type: 'open-link', href });
      return;
    }
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    if (target) jumpTo(target);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) hidePopover();
  });

  // --- back and forward -------------------------------------------------------------

  // Each jump (a reference, Contents, the map, Go to, the next note…) remembers
  // where you were: the Back button over the preview goes back there. Alt+Left
  // and Alt+Right are the texglass.back / texglass.forward commands, which VS
  // Code runs for keys pressed in here too (so they are not VS Code's own Go Back).
  const viewHistory = window.TeXglassScroll && TeXglassScroll.history ? TeXglassScroll.history(pane) : null;

  // --- find and go to ----------------------------------------------------------------

  // Opened by the texglass.find / texglass.goTo commands (Ctrl+F, Ctrl+G), which
  // VS Code runs for keys pressed in here too, so no key handling of our own.
  const finder = window.TeXglassFind
    ? window.TeXglassFind.attach({
      root: preview,
      scroller: pane,
      reveal,
      onJump: hidePopover,
      // Trace: pick a result, see only what it uses and what uses it
      onFocus: (el) => { if (insight) insight.focus(el, 'both', { scroll: true, collapse: true }); },
      related: (el) => (insight ? insight.related(el) : null),
    })
    : null;

  function selectedText() {
    const s = String(window.getSelection()).trim();
    return s && s.length <= 100 && !/\n/.test(s) ? s : null;
  }

  // --- messages from the extension ----------------------------------------------------

  function setStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'doc':
        const sameDoc = (vscode.getState() || {}).uri === m.uri;
        if (!sameDoc) {
          if (viewHistory) viewHistory.clear();
          shown = [];
          allAnchors = [];
          anchors = [];
          preview.replaceChildren();
        }
        // the same document keeps what the preview remembers about it (pinned notation, …)
        vscode.setState(sameDoc ? Object.assign({}, vscode.getState(), { uri: m.uri }) : { uri: m.uri });
        if (insight && insight.refreshPins && !sameDoc) insight.refreshPins();
        break;
      case 'render': {
        sourceFiles = m.files || [];
        if (insight && m.defs !== undefined) insight.setDefinitions(m.defs);
        show(m.blocks, m.lines);
        drawFigures();
        if (insight) insight.invalidate();
        if (picker) picker.refresh();
        if (cites) cites.decorate(preview); // "Open in TeXglass" on bibliography entries on arXiv
        updateToc(m.toc || []);
        if (progress) progress.refresh();
        if (steps) steps.refresh();
        if (params) params.refresh();
        const n = m.warnings.length;
        setStatus(n ? `${n} warning${n > 1 ? 's' : ''}` : '');
        status.title = m.warnings.join('\n');
        vscode.postMessage({ type: 'shown', blocks: shown.length, math: preview.querySelectorAll('.katex').length });
        break;
      }
      case 'error':
        shown = [];
        allAnchors = [];
        anchors = [];
        preview.replaceChildren();
        preview.insertAdjacentHTML('beforeend', '<pre class="render-error"></pre>');
        preview.firstChild.textContent = m.text;
        if (margin) margin.refresh();
        setStatus('Render failed');
        break;
      case 'prefs':
        folded.clear();
        (m.folds || []).forEach((k) => folded.add(k));
        if (typeof m.toc === 'boolean') tocWanted = m.toc && !narrow.matches;
        if (margin && m.marginWidth) margin.setWidth(m.marginWidth);
        if (margin) margin.setCollapsed(!!m.marginCollapsed);
        if (textWidth) textWidth.set(window.TeXglassTextWidth.parse(m.textWidth), false);
        if (margin && m.notePad) margin.setPadAt(m.notePad);
        if (insight && m.notationOrder) insight.setNotationOrder(m.notationOrder);
        if (insight && typeof m.notationUsedPinned === 'boolean') insight.setUsedPinned(m.notationUsedPinned);
        if (insight && typeof m.mapLocked === 'boolean') insight.setLocked(m.mapLocked);
        if (side) {
          if (m.sideWidth) side.setWidth(m.sideWidth);
          if (m.sideTab) side.show(m.sideTab);
        }
        applyFolds();
        showToc();
        break;
      case 'toggle-toc':
        tocWanted = !tocWanted;
        showToc();
        vscode.postMessage({ type: 'toc', on: tocWanted });
        break;
      case 'zoom':
        if (zoom) {
          zoom.set(window.TeXglassZoom.parse(m.level), true);
          showZoom(false);
        }
        break;
      case 'zoom-step':
        if (zoom) {
          if (m.dir) zoom.step(m.dir);
          else zoom.reset();
          showZoom(true);
        }
        break;
      case 'toc-side':
        setTocSide(m.value === 'right');
        break;
      case 'fold-proofs':
        foldAllProofs(m.fold);
        break;
      case 'margin-jump':
        if (margin) { if (m.dir < 0) margin.previous(); else margin.next(); }
        break;
      case 'click-to-copy':
        if (copier) copier.setEnabled(m.on);
        break;
      case 'theme':
        forcedTheme = m.value;
        applyTheme();
        break;
      case 'look': {
        const root = document.documentElement.dataset;
        root.look = m.look;
        root.paper = m.paper;
        root.hand = m.hand;
        root.handMath = m.handMath;
        root.ink = m.ink;
        root.inkTexture = m.inkTexture;
        break;
      }
      case 'print':
        window.print();
        break;
      case 'print-view': {
        // Printing in the browser: which blocks show now (a selection, or Hide the rest)
        let view = null;
        try { view = window.TeXglassPick ? window.TeXglassPick.snapshot(preview) : null; } catch (e) { view = null; }
        vscode.postMessage({ type: 'print', view });
        break;
      }
      case 'pick':
        // with pins: show them; without: pin some first
        if (picker) { if (insight && insight.pinCount()) picker.show(); else picker.start(); }
        break;
      case 'toggle-theme':
        // Switch away from what is showing now, whatever chose it.
        vscode.postMessage({ type: 'set-theme', value: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
        break;
      case 'status':
        setStatus(m.text);
        break;
      case 'insight':
        // Show Notation Index / Show Dependency Map: that tab of the side panel
        if (side) {
          tocWanted = true;
          showToc();
          side.show(m.tab);
          vscode.postMessage({ type: 'toc', on: true });
        } else if (insight) insight.open(m.tab);
        break;
      case 'larger-map':
        // Show Larger Dependency Map (also the M key in the preview)
        if (insight) insight.open('deps');
        break;
      case 'notation-hover':
        if (insight) insight.setHover(m.on);
        break;
      case 'features':
        features = m.prefs || {};
        applyFeatures();
        break;
      case 'show-settings':
        if (settingsPanel) settingsPanel.open();
        break;
      case 'tex-rendered': {
        const done = texWaiting.get(m.id);
        texWaiting.delete(m.id);
        if (done) done(m.html);
        break;
      }
      case 'history':
        if (viewHistory) viewHistory[m.dir < 0 ? 'back' : 'forward']();
        break;
      case 'find':
        if (finder) finder.open(m.mode, m.mode === 'find' ? selectedText() : null);
        break;
      case 'find-step':
        if (finder && finder.isOpen()) finder[m.dir < 0 ? 'prev' : 'next']();
        else if (finder) finder.open('find');
        break;
      case 'annotations':
        if (margin) margin.setAnnotations(m.list);
        // the hypothesis checker's ticks come with the notes
        hypTicks = new Set((Array.isArray(m.list) ? m.list : []).filter((a) => a && a.kind === 'check').map((a) => a.id));
        break;
      case 'study':
        if (margin) margin.setStudy(m.on);
        break;
      case 'progress':
        if (progress) progress.setMap(m.map);
        break;
      case 'map-edits':
        // the reader's changes to the map, from paper.texglass.json or another machine
        mapEdits = m.map && typeof m.map === 'object' ? m.map : {};
        if (insight) insight.refreshEdits();
        break;
      case 'reading-progress':
        if (progress) progress.setEnabled(m.on);
        break;
      case 'epub-prepare': // Export to EPUB: figures inside, diagrams drawn
        prepareEpub(m.html).then(
          (html) => vscode.postMessage({ type: 'epub-prepared', id: m.id, html }),
          () => vscode.postMessage({ type: 'epub-prepared', id: m.id, html: null })
        );
        break;
      case 'note-html': {
        const done = noteWaiting.get(m.id);
        noteWaiting.delete(m.id);
        if (done) done(m.html);
        break;
      }
      case 'live-html': {
        const done = noteWaiting.get(m.id);
        noteWaiting.delete(m.id);
        if (done) done(m.html);
        break;
      }
      case 'scroll-to':
        scrollToLine(m.line, m.file);
        break;
      case 'show-line':
        showLine(m.line, m.file);
        break;
      default:
    }
  });

  // --- notation and dependencies -------------------------------------------------------

  // Resting on a formula shows where its notation comes from; the commands
  // TeXglass: Show Notation Index and Show Dependency Map open the panel. All of
  // it is read from the page when first needed, never while rendering. The
  // extension draws the index's symbols with the document's macros.
  const texWaiting = new Map();
  let texId = 0;
  let mapEdits = {}; // the reader's changes to the map (pins, own links…), from the extension

  const insight = window.TeXglassInsight
    ? window.TeXglassInsight.attach({
      root: preview,
      jump: (el) => jumpTo(el),
      renderTex: (texs) => new Promise((resolve) => {
        const id = ++texId;
        texWaiting.set(id, resolve);
        vscode.postMessage({ type: 'render-tex', id, texs });
      }),
      onHoverChange: (on) => vscode.postMessage({ type: 'set-notation-hover', on }),
      onNotationOrder: (order) => vscode.postMessage({ type: 'side-pref', key: 'texglass:notation-order', value: order }),
      // pinned notation rows, kept with this preview's document
      pins: {
        get: () => ((vscode.getState && vscode.getState()) || {}).notationPins || [],
        set: (keys) => { if (vscode.setState) vscode.setState(Object.assign({}, vscode.getState() || {}, { notationPins: keys })); },
      },
      onUsedPinned: (on) => vscode.postMessage({ type: 'side-pref', key: 'texglass:notation-used-pinned', value: on }),
      statusOf: (el) => (progress ? progress.statusOf(el) : null),
      print: () => vscode.postMessage({ type: 'print-request' }),
      onFocusStart: () => { if (picker) picker.stop(); },
      // pins, hidden results, own links, layout and saved maps: kept by the
      // extension with the reader's notes (paper.texglass.json), synced with them
      edits: {
        get: () => mapEdits,
        set: (map) => { mapEdits = map; vscode.postMessage({ type: 'map-edits', map }); },
      },
      onLock: (on) => vscode.postMessage({ type: 'side-pref', key: 'texglass:map-locked', value: on }),
      showPinned: () => { if (picker) picker.show(); },
      onPinsChange: () => { if (picker) picker.pinsChanged(); },
    })
    : null;

  // Show pinned results (TeXglass: Show Pinned Results…): pin results and
  // numbered equations, see only those. Print asks the extension, which prints
  // in the browser what is shown here (see 'print-view').
  const picker = window.TeXglassPick
    ? window.TeXglassPick.attach({
      root: preview,
      jump: (el) => jumpTo(el),
      items: insight ? () => insight.pinnedEls() : undefined,
      isOn: insight ? (el) => insight.isPinned(el) : undefined,
      toggle: insight ? (el) => insight.togglePin(el) : undefined,
      clear: insight ? () => insight.unpinAll() : undefined,
      proofsOf: (el) => {
        const n = insight && insight.graph().byEl.get(el);
        return n ? n.proofs : null;
      },
      print: () => vscode.postMessage({ type: 'print-request' }),
      onStart: () => { if (insight) insight.unfocus(); hidePopover(); },
    })
    : null;

  // A result cited in a proof previews as its hypotheses and conclusion; the
  // ticks are kept by the extension with the reader's notes (paper.texglass.json)
  // and sync with them.
  let hypTicks = new Set();
  const hypotheses = window.TeXglassHypotheses
    ? window.TeXglassHypotheses.attach({
      root: preview,
      isChecked: (id) => hypTicks.has(id),
      setChecked: (id, on, info) => {
        if (on) hypTicks.add(id); else hypTicks.delete(id);
        vscode.postMessage({ type: 'check', id, on, info });
      },
      prefs: {
        get: (k) => ((vscode.getState && vscode.getState()) || {})[k] || null,
        set: (k, v) => { if (vscode.setState) vscode.setState(Object.assign({}, vscode.getState() || {}, { [k]: v })); },
      },
      onChange: () => { if (popoverLink && !popover.hidden) placePopover(popoverLink, popover.firstElementChild); },
    })
    : null;

  // The side panel's tabs (Contents, Map, Notation) and its draggable divider;
  // the extension keeps the tab and the width (prefs: sideTab, sideWidth).
  const side = window.TeXglassInsight
    ? window.TeXglassInsight.sidePanel({
      pane: tocPane,
      head: tocPane.querySelector('.toc-pane-head'),
      list: tocList,
      insight,
      store: {
        get: () => null,
        set: (key, value) => vscode.postMessage({ type: 'side-pref', key, value }),
      },
      onJump: () => { if (narrow.matches) { tocWanted = false; showToc(); } },
      onTab: (tab) => { if (tab === 'toc') spyToc(); },
    })
    : null;

  // Reading progress (src/progress.js): the extension keeps the statuses with the
  // paper's notes (name.texglass.json, Settings Sync, the gist).
  var progress = window.TeXglassProgress
    ? window.TeXglassProgress.attach({
      root: preview,
      pane: tocPane,
      list: tocList,
      insight,
      jump: (el) => { jumpTo(el); if (narrow.matches) { tocWanted = false; showToc(); } },
      onChange: (map) => vscode.postMessage({ type: 'progress', map }),
    })
    : null;

  // Stepping through a proof (shared/steps.js): "Step through" by each proof, one
  // piece at a time, with "why?" by each reference opening its usual preview.
  var steps = window.TeXglassSteps
    ? window.TeXglassSteps.attach({
      root: preview,
      enabled: featureOn('proofSteps'),
      reveal,
      preview: (a, chip) => {
        const target = document.getElementById(decodeURIComponent((a.getAttribute('href') || '').slice(1)));
        if (!target) return;
        if (popoverLink === a && !popover.hidden) { hidePopover(); return; } // a second press closes it
        showPopover(a, target);
        popoverChip = chip;
      },
      closePreview: () => { if (popoverChip) hidePopover(); },
      previewOpen: () => !popover.hidden,
      dismissPreview: hidePopover,
    })
    : null;
  // Live parameters (shared/params.js): sliders for a paper's \tgparam. The
  // extension draws each formula or picture again with the new values.
  var params = window.TeXglassParams
    ? window.TeXglassParams.attach({
      root: preview,
      render: (piece, values) => new Promise((resolve) => {
        const id = ++noteSeq;
        noteWaiting.set(id, resolve);
        vscode.postMessage({ type: 'render-live', id, piece, values });
      }),
    })
    : null;
  // A preview opened by a "why?" chip stays until a click elsewhere.
  document.addEventListener('pointerdown', (e) => {
    if (!popoverChip || popover.hidden) return;
    if (popover.contains(e.target) || e.target.closest('.tg-why')) return;
    hidePopover();
  }, true);

  // --- settings: switching reading aids on or off ------------------------------------
  // The panel changes the texglass.* settings; the extension sends them back ('features').

  function applyFeatures() {
    if (Features && insight) insight.setFeatures(Features.insightParts(features));
    if (Features && side && side.setTabs) side.setTabs(Features.sideTabs(features));
    if (steps) steps.setEnabled(featureOn('proofSteps'));
    if (popoverLink && !popover.hidden && Features && !featureOn(Features.previewKind(popoverLink))) hidePopover();
    if (settingsPanel && settingsPanel.isOpen()) settingsPanel.refresh();
  }
  const settingsPanel = Features
    ? Features.panel({
      get: () => features,
      set: (id, on) => {
        features = Object.assign({}, features, { [id]: on });
        applyFeatures();
        vscode.postMessage({ type: 'set-feature', id, on });
      },
      footer: (() => {
        const p = document.createElement('p');
        p.className = 'features-extra';
        p.innerHTML = 'These are VS Code settings (texglass.*), kept with your other settings. <button type="button" class="link-button">Open in Settings</button>';
        p.querySelector('button').addEventListener('click', () => vscode.postMessage({ type: 'open-settings' }));
        return p;
      })(),
    })
    : null;

  vscode.postMessage({ type: 'ready' });
})();
