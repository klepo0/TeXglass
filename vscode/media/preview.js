/*
 * The TeXdown preview inside VS Code. It receives the rendered blocks from the
 * extension, keeps the DOM of blocks that did not change, and reports where
 * it is scrolled to (as a source line) so the editor can follow, and back.
 */
/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const preview = document.getElementById('preview');
  const pane = document.getElementById('preview-pane');
  const popover = document.getElementById('ref-popover');
  const status = document.getElementById('status');

  // --- theme ---------------------------------------------------------------------

  // Follow VS Code's colour theme rather than the system one.
  // Unless the texdown.previewTheme setting picks light or dark.
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
    allAnchors = shown.filter((e) => e.range && e.nodes[0] && e.nodes[0].nodeType === 1).map((e) => ({ el: e.nodes[0], line: e.range[0], end: e.range[1] }));
    applyFolds();
  }

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
    const foldedProof = !btn && e.target.closest('.proof.folded');
    const heading = !btn && !e.target.closest('a') && e.target.closest('#preview > .src-block > h1, #preview > .src-block > h2, #preview > .src-block > h3, #preview > .src-block > h4');
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
  let tocWanted = !narrow.matches;
  let toc = [];
  let tocKey = '';
  let tocLinks = [];
  let tocJump = 0; // while a jump from the sidebar scrolls, keep its entry highlighted
  const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function updateToc(items) {
    items = items.slice();
    // The bibliography gets an entry too, after the sections.
    const bib = preview.querySelector('.bibliography > h2');
    if (bib && items.length) {
      bib.id = bib.id || 'references';
      items.push({ level: Math.min(...items.map((t) => t.level)), num: '', title: escapeHtml(bib.textContent), id: bib.id });
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
    if (tocPane.hidden || !tocLinks.length || Date.now() < tocJump) return;
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
    const y = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 16;
    pane.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
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

  // --- scrolling in step with the editor -------------------------------------------

  let allAnchors = []; // every block with a source range
  let anchors = []; // those not hidden in a folded section
  let ignoreScrollUntil = 0;

  const topOf = (el) => el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;

  /** Scroll so that source line `line` is at the top. */
  function scrollToLine(line) {
    if (!anchors.length) return;
    let lo = 0;
    let hi = anchors.length - 1;
    if (line < anchors[0].line) {
      pane.scrollTop = 0;
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

  /** The source line at the top of the preview. */
  function lineAtTop() {
    if (!anchors.length) return 0;
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
    return a.line + t * (a.end - a.line + 1);
  }

  let scrollFrame = 0;
  pane.addEventListener('scroll', () => {
    if (Date.now() < ignoreScrollUntil || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      vscode.postMessage({ type: 'scroll', line: lineAtTop() });
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

  preview.addEventListener('dblclick', (e) => {
    if (e.target.closest('a')) return;
    goToSource(e);
  });

  // --- links and reference previews -----------------------------------------------------

  preview.addEventListener('click', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      popover.hidden = true;
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
    popover.hidden = true;
    reveal(target);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  });

  let hideTimer = null;
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.ref, .cite a');
    if (!a) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target || target.contains(a)) return;
    clearTimeout(hideTimer);
    popover.innerHTML = '';
    let node = target;
    if (node.classList.contains('caption') && node.parentElement.tagName === 'FIGURE') node = node.parentElement;
    if (/^H[1-6]$/.test(node.tagName)) {
      const p = document.createElement('p');
      const b = document.createElement('strong');
      b.innerHTML = node.innerHTML;
      p.appendChild(b);
      popover.appendChild(p);
    } else {
      const clone = node.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      popover.appendChild(clone);
    }
    popover.hidden = false;
    const r = a.getBoundingClientRect();
    const width = Math.min(560, window.innerWidth - 32);
    popover.style.width = width + 'px';
    popover.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
    const h = popover.offsetHeight;
    popover.style.top = (r.bottom + 8 + h > window.innerHeight && r.top - h - 8 > 0 ? r.top - h - 8 : r.bottom + 8) + 'px';
  });
  preview.addEventListener('mouseout', (e) => {
    if (!e.target.closest('a.ref, .cite a')) return;
    hideTimer = setTimeout(() => { popover.hidden = true; }, 120);
  });

  // --- messages from the extension ----------------------------------------------------

  function setStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'doc':
        if ((vscode.getState() || {}).uri !== m.uri) {
          shown = [];
          allAnchors = [];
          anchors = [];
          preview.replaceChildren();
        }
        vscode.setState({ uri: m.uri });
        break;
      case 'render': {
        show(m.blocks, m.lines);
        updateToc(m.toc || []);
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
        setStatus('Render failed');
        break;
      case 'prefs':
        folded.clear();
        (m.folds || []).forEach((k) => folded.add(k));
        if (typeof m.toc === 'boolean') tocWanted = m.toc && !narrow.matches;
        applyFolds();
        showToc();
        break;
      case 'toggle-toc':
        tocWanted = !tocWanted;
        showToc();
        vscode.postMessage({ type: 'toc', on: tocWanted });
        break;
      case 'fold-proofs':
        foldAllProofs(m.fold);
        break;
      case 'theme':
        forcedTheme = m.value;
        applyTheme();
        break;
      case 'toggle-theme':
        // Switch away from what is showing now, whatever chose it.
        vscode.postMessage({ type: 'set-theme', value: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
        break;
      case 'status':
        setStatus(m.text);
        break;
      case 'scroll-to':
        scrollToLine(m.line);
        break;
      default:
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
