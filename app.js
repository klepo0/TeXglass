/* TeXdown viewer: opening files, live reload, in-place editing and reference previews. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const preview = $('preview');
  const previewPane = $('preview-pane');
  const source = $('source');
  const sourcePane = $('source-pane');
  const status = $('status');
  const fileName = $('file-name');
  const popover = $('ref-popover');
  const inFrame = window.self !== window.top;

  let doc = ''; // the LaTeX source being shown, with \n line endings
  let mode = 'preview'; // 'preview' or 'edit'
  let editing = null; // { s, len, el, textarea, previewEl } while a block is open
  let dirty = false; // edited here since the last open or save
  let fileHandle = null; // File System Access handle, for live reload and saving
  let lastModified = 0;
  let renderTimer = null;
  let saveTimer = null;
  let statusTimer = null;
  let warningsText = '';
  let lastLabels = {};
  let lastToc = [];
  let imageUrls = []; // object URLs for the figures of an imported arXiv paper
  let resolveImage = null;

  // Syntax colouring and completion for both source editors.
  const editorOptions = { labels: () => lastLabels, source: () => doc };
  const sourceAids = window.TeXdownEditor ? TeXdownEditor.attach(source, editorOptions) : { refresh() {}, close() {} };
  const setSource = (text) => {
    source.value = text;
    sourceAids.refresh();
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // --- rendering -------------------------------------------------------------

  function renderHtml() {
    try {
      const result = TeXdown.render(doc, { sourceMap: true, resolveImage: resolveImage || undefined });
      lastLabels = result.labels;
      lastToc = result.toc;
      document.title = result.title ? `${result.title} — TeXdown` : 'TeXdown';
      const n = result.warnings.length;
      warningsText = n ? `${n} warning${n > 1 ? 's' : ''}` : '';
      status.title = result.warnings.join('\n');
      if (!statusTimer) showStatus(warningsText, n > 0);
      return result.html || '<p class="empty-doc">This document is empty. Switch to Edit and click “Add text”.</p>';
    } catch (e) {
      showStatus('Render failed', true);
      return `<pre class="render-error">${TeXdown.escapeHtml(e.stack || String(e))}</pre>`;
    }
  }

  function render() {
    const html = renderHtml();
    if (editing) renderAroundEditor(html);
    else preview.innerHTML = html;
    applyFolds();
    updateToc();
  }

  // --- table of contents sidebar ------------------------------------------------

  const tocPane = $('toc-pane');
  const tocList = $('toc-list');
  const tocToggle = $('toc-toggle');
  const narrow = window.matchMedia('(max-width: 760px)');
  let tocWanted = store.get('texdown:toc') !== 'off';
  let tocKey = '';
  let tocLinks = [];

  function updateToc() {
    // The bibliography gets an entry too, after the sections.
    const items = lastToc.slice();
    const bib = preview.querySelector('.bibliography > h2');
    if (bib && items.length) {
      bib.id = bib.id || 'references';
      items.push({ level: Math.min(...items.map((t) => t.level)), num: '', title: TeXdown.escapeHtml(bib.textContent), id: bib.id });
    }
    lastToc = items;
    const key = JSON.stringify(items);
    if (key !== tocKey) {
      tocKey = key;
      const top = Math.min(...items.map((t) => t.level));
      tocList.innerHTML = items
        .map((t) => `<li class="toc-d${Math.min(3, t.level - top)}"><a href="#${t.id}" data-id="${t.id}">${t.num ? `<span class="toc-num">${TeXdown.escapeHtml(t.num)}</span>` : ''}<span class="toc-title">${t.title}</span></a></li>`)
        .join('');
      tocLinks = Array.from(tocList.querySelectorAll('a'));
    }
    showToc();
    spyToc();
  }

  /** The sidebar shows in Preview and Edit when the document has headings and it is switched on. */
  function showToc() {
    const has = lastToc.length > 0;
    const on = tocWanted && has && mode !== 'split';
    tocPane.hidden = !on;
    document.body.classList.toggle('toc-open', on);
    tocToggle.hidden = !has || mode === 'split';
    tocToggle.setAttribute('aria-pressed', String(tocWanted));
  }

  /** Highlight the section at the top of the preview. */
  let tocJump = 0; // while a jump from the sidebar scrolls, keep its entry highlighted

  function markToc(current) {
    if (current === tocList.querySelector('a.active')) return;
    tocLinks.forEach((a) => a.classList.toggle('active', a === current));
    if (current) {
      const r = current.getBoundingClientRect();
      const pr = tocPane.getBoundingClientRect();
      if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) tocPane.scrollTop += r.top - pr.top - pr.height / 3;
    }
  }

  function spyToc() {
    if (tocPane.hidden || !tocLinks.length || Date.now() < tocJump) return;
    const limit = previewPane.getBoundingClientRect().top + 48;
    let current = null;
    for (const a of tocLinks) {
      const h = document.getElementById(a.dataset.id);
      if (!h || !h.offsetParent) continue;
      if (h.getBoundingClientRect().top <= limit) current = a;
      else break;
    }
    // At the very bottom, the last heading on screen is the current one.
    if (previewPane.scrollTop + previewPane.clientHeight >= previewPane.scrollHeight - 2) {
      for (const a of tocLinks) {
        const h = document.getElementById(a.dataset.id);
        if (h && h.offsetParent && h.getBoundingClientRect().top < previewPane.getBoundingClientRect().bottom) current = a;
      }
    }
    markToc(current);
  }

  let spyFrame = 0;
  previewPane.addEventListener('scroll', () => {
    if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; spyToc(); });
  }, { passive: true });
  previewPane.addEventListener('scrollend', () => { tocJump = 0; spyToc(); });

  tocList.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.dataset.id);
    if (!target) return;
    reveal(target);
    const y = target.getBoundingClientRect().top - previewPane.getBoundingClientRect().top + previewPane.scrollTop - 16;
    previewPane.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    markToc(a);
    tocJump = Date.now() + 1000;
    if (narrow.matches) { tocWanted = false; showToc(); }
  });

  tocToggle.addEventListener('click', () => {
    tocWanted = !tocWanted;
    if (!narrow.matches) store.set('texdown:toc', tocWanted ? 'on' : 'off');
    showToc();
    spyToc();
  });
  // On a phone the contents open as a drawer over the page: start closed, and
  // close it again on a tap outside it or Escape.
  document.addEventListener('pointerdown', (e) => {
    if (narrow.matches && tocWanted && !tocPane.contains(e.target) && !tocToggle.contains(e.target)) { tocWanted = false; showToc(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && narrow.matches && tocWanted) { tocWanted = false; showToc(); }
  });
  if (narrow.matches) tocWanted = false;

  function showStatus(text, warn) {
    status.textContent = text;
    status.classList.toggle('warn', !!warn);
  }

  function flashStatus(text) {
    clearTimeout(statusTimer);
    showStatus(text, false);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      showStatus(warningsText, !!warningsText);
    }, 2500);
  }

  function setDirty(d) {
    dirty = d;
    fileName.classList.toggle('dirty', d);
  }

  function rememberSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('texdown:last', doc), 400);
  }

  function load(text, name, images) {
    closeEditor(false);
    imageUrls.forEach((u) => URL.revokeObjectURL(u));
    imageUrls = [];
    resolveImage = null;
    if (images && Object.keys(images).length && window.TeXdownArxiv) {
      const urls = {};
      for (const [path, blob] of Object.entries(images)) imageUrls.push((urls[path] = URL.createObjectURL(blob)));
      resolveImage = TeXdownArxiv.imageResolver(urls, text);
    }
    doc = text.replace(/\r\n?/g, '\n');
    setSource(doc);
    fileName.textContent = name || 'untitled.tex';
    setDirty(false);
    render();
    previewPane.scrollTop = 0;
    store.set('texdown:last', doc);
    store.set('texdown:last-name', name || '');
  }

  // --- folding sections and proofs -------------------------------------------

  // Folded items are remembered by their text, so they stay folded across
  // re-renders and edits elsewhere in the document.
  const folded = new Set();
  try { JSON.parse(store.get('texdown:folds') || '[]').forEach((k) => folded.add(k)); } catch (e) { /* ignore */ }
  const saveFolds = () => store.set('texdown:folds', JSON.stringify(Array.from(folded).slice(-500)));

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
      const isEditor = editing && block === editing.el;
      block.classList.toggle('fold-hidden', !!hideAt && !isEditor);
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
    for (const proof of preview.querySelectorAll('.proof')) {
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
    }
    const proofs = preview.querySelectorAll('.proof').length;
    const allFolded = proofs > 0 && preview.querySelectorAll('.proof.folded').length === proofs;
    const fp = $('fold-proofs');
    fp.textContent = allFolded ? 'Show proofs' : 'Hide proofs';
    fp.setAttribute('aria-pressed', String(allFolded));
    fp.disabled = proofs === 0;
    anchors = null; // folding moves things around
  }

  function setFold(key, on) {
    if (on) folded.add(key);
    else folded.delete(key);
    saveFolds();
  }

  /** Unfold whatever hides `el`, so a reference to it can be followed. */
  function reveal(el) {
    let changed = false;
    const proof = el.closest('.proof.folded');
    if (proof) {
      setFold(proof.querySelector('.fold-toggle').dataset.key, false);
      changed = true;
    }
    let block = el.closest('#preview > *');
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
    if (changed) applyFolds();
  }

  // Registered before the Edit-mode click handler, so toggles never open the editor.
  preview.addEventListener('click', (e) => {
    const btn = e.target.closest('.fold-toggle');
    const foldedProof = !btn && mode !== 'edit' && e.target.closest('.proof.folded');
    const heading = !btn && mode !== 'edit' && !e.target.closest('a') && e.target.closest('#preview > .src-block > h1, #preview > .src-block > h2, #preview > .src-block > h3, #preview > .src-block > h4');
    const target = btn || (foldedProof && foldedProof.querySelector('.fold-toggle')) || (heading && heading.querySelector(':scope > .fold-toggle'));
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setFold(target.dataset.key, !folded.has(target.dataset.key));
    applyFolds();
  });

  $('fold-proofs').addEventListener('click', () => {
    const toggles = Array.from(preview.querySelectorAll('.proof > p:first-child > .fold-toggle'));
    const fold = !toggles.every((t) => folded.has(t.dataset.key));
    toggles.forEach((t) => setFold(t.dataset.key, fold));
    applyFolds();
  });

  // --- in-place editing ------------------------------------------------------

  function setMode(m) {
    const wasSplit = mode === 'split';
    mode = m;
    document.body.classList.toggle('mode-edit', m === 'edit');
    document.body.classList.toggle('editing', m === 'split');
    for (const k of ['preview', 'edit', 'split']) $('mode-' + k).setAttribute('aria-pressed', String(m === k));
    store.set('texdown:mode', m);
    if (m !== 'edit') closeEditor(true);
    sourcePane.hidden = m !== 'split';
    $('splitter').hidden = m !== 'split';
    showToc();
    if (m === 'split' && !wasSplit) {
      setSource(doc);
      anchors = null;
      // Line the source up with what was on screen in the preview.
      requestAnimationFrame(() => syncFrom('pre'));
    }
  }

  function makeEditor() {
    const el = document.createElement('div');
    el.className = 'inline-editor';
    const textarea = document.createElement('textarea');
    textarea.id = 'inline-source';
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'LaTeX source of this block');
    const hint = document.createElement('div');
    hint.className = 'inline-hint';
    hint.textContent = 'Type \\ for commands and snippets (Tab jumps between fields) · Esc or click outside to finish · ↑/↓ at the edges move between blocks';
    const previewEl = document.createElement('div');
    previewEl.className = 'inline-preview';
    el.append(textarea, hint, previewEl);
    const aids = window.TeXdownEditor ? TeXdownEditor.attach(textarea, editorOptions) : { refresh() {}, close() {} };
    textarea.addEventListener('input', onBlockInput);
    textarea.addEventListener('keydown', onBlockKey);
    return { el, textarea, previewEl, aids };
  }

  /** Open the source range [s, e) for editing, with the caret at `caret`. */
  function openEditor(s, e, caret) {
    if (editing) closeEditor(false);
    const ed = makeEditor();
    editing = Object.assign(ed, { s, len: e - s });
    ed.textarea.value = doc.slice(s, e);
    ed.aids.refresh();
    // Put the editor where the block was, so the page does not jump.
    const old = preview.querySelector(`.src-block[data-s="${s}"]`);
    if (old) old.replaceWith(ed.el);
    else preview.appendChild(ed.el);
    renderAroundEditor(renderHtml());
    autosize();
    ed.textarea.focus({ preventScroll: true });
    const pos = Math.max(0, Math.min(caret == null ? 0 : caret, ed.textarea.value.length));
    ed.textarea.setSelectionRange(pos, pos);
  }

  function closeEditor(rerender) {
    if (!editing) return;
    const { s, el } = editing;
    const top = el.getBoundingClientRect().top;
    editing = null;
    if (rerender === false) {
      el.remove();
      return;
    }
    preview.innerHTML = renderHtml();
    applyFolds();
    // Keep the block that was being edited where it was on screen.
    const block = preview.querySelector(`.src-block[data-s="${s}"]`);
    if (block) previewPane.scrollTop += block.getBoundingClientRect().top - top;
  }

  /** Lay out freshly rendered HTML around the open editor, without moving it. */
  function renderAroundEditor(html) {
    const tpl = document.createElement('div');
    tpl.innerHTML = html;
    const { s, len, el, previewEl } = editing;
    const end = s + len;
    const before = [];
    const inside = [];
    const after = [];
    for (const node of Array.from(tpl.childNodes)) {
      if (node.nodeType === 1 && node.classList.contains('src-block')) {
        const bs = Number(node.dataset.s);
        if (bs >= s && bs < end) inside.push(node);
        else if (bs < s) before.push(node);
        else after.push(node);
      } else if (node.nodeType === 1) {
        (inside.length || after.length ? after : before).push(node);
      }
    }
    for (const child of Array.from(preview.childNodes)) if (child !== el) child.remove();
    if (!el.parentNode) preview.appendChild(el);
    el.before(...before);
    el.after(...after);
    previewEl.replaceChildren(...inside);
    applyFolds();
  }

  function onBlockInput() {
    const value = editing.textarea.value;
    doc = doc.slice(0, editing.s) + value + doc.slice(editing.s + editing.len);
    editing.len = value.length;
    if (document.activeElement !== source) setSource(doc);
    setDirty(true);
    autosize();
    rememberSoon();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => editing && renderAroundEditor(renderHtml()), 120);
  }

  function autosize() {
    const t = editing.textarea;
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 2 + 'px';
  }

  function siblingBlock(dir) {
    let node = dir < 0 ? editing.el.previousElementSibling : editing.el.nextElementSibling;
    while (node && !node.classList.contains('src-block')) {
      node = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
    }
    return node;
  }

  function onBlockKey(e) {
    const t = e.target;
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      closeEditor(true);
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
      onBlockInput();
    } else if (e.key === 'ArrowUp' && t.selectionStart === 0 && t.selectionEnd === 0) {
      const prev = siblingBlock(-1);
      if (prev) {
        e.preventDefault();
        openEditor(Number(prev.dataset.s), Number(prev.dataset.e), Infinity);
      }
    } else if (e.key === 'ArrowDown' && t.selectionStart === t.value.length && t.selectionEnd === t.value.length) {
      const next = siblingBlock(1);
      if (next) {
        e.preventDefault();
        openEditor(Number(next.dataset.s), Number(next.dataset.e), 0);
      }
    }
  }

  /** Guess where in the block's source the reader clicked. */
  function caretFor(block, e) {
    const s = Number(block.dataset.s);
    const text = doc.slice(s, Number(block.dataset.e));
    const math = e.target.closest('.katex');
    if (math) {
      const ann = math.querySelector('annotation');
      const tex = ann ? ann.textContent.trim() : '';
      for (const n of [30, 15, 8, 4]) {
        const needle = tex.slice(0, n);
        if (needle.length < Math.min(n, tex.length)) continue;
        const k = needle ? text.indexOf(needle) : -1;
        if (k >= 0) return k;
      }
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
    if (!node || node.nodeType !== 3 || !block.contains(node)) return 0;
    // Position of the click within the block's rendered text, as a fraction.
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(node, offset);
    const fraction = range.toString().length / Math.max(1, block.textContent.length);
    const head = (/[\p{L}\p{N}]{1,16}$/u.exec(node.data.slice(0, offset)) || [''])[0];
    const tail = (/^[\p{L}\p{N}]{0,16}/u.exec(node.data.slice(offset)) || [''])[0];
    const word = head + tail;
    if (word.length >= 2) {
      let best = -1;
      let bestDist = Infinity;
      for (let k = text.indexOf(word); k >= 0; k = text.indexOf(word, k + 1)) {
        const dist = Math.abs(k / text.length - fraction);
        if (dist < bestDist) { best = k; bestDist = dist; }
      }
      if (best >= 0) return best + head.length;
    }
    return Math.round(fraction * text.length);
  }

  function addBlockAtEnd() {
    if (mode !== 'edit') setMode('edit');
    let pos = doc.search(/\\end\s*\{document\}/);
    if (pos < 0) pos = doc.length;
    const before = doc.slice(0, pos).replace(/\s*$/, '');
    const sep = before ? '\n\n' : '';
    doc = before + sep + '\n\n' + doc.slice(pos);
    setSource(doc);
    openEditor(before.length + sep.length, before.length + sep.length, 0);
    editing.el.scrollIntoView({ block: 'center' });
  }

  preview.addEventListener('click', (e) => {
    if (mode !== 'edit') return;
    if (editing && editing.el.contains(e.target)) return;
    if (String(window.getSelection())) return; // the reader is selecting text
    const block = e.target.closest('.src-block');
    e.preventDefault();
    e.stopPropagation(); // the clicked node may be gone after re-rendering
    if (!block) {
      closeEditor(true);
      return;
    }
    popover.hidden = true;
    openEditor(Number(block.dataset.s), Number(block.dataset.e), caretFor(block, e));
  });
  previewPane.addEventListener('click', (e) => {
    if (mode === 'edit' && editing && !preview.contains(e.target) && !e.target.closest('#add-block')) closeEditor(true);
  });

  $('mode-preview').addEventListener('click', () => setMode('preview'));
  $('mode-edit').addEventListener('click', () => setMode('edit'));
  $('mode-split').addEventListener('click', () => setMode('split'));
  $('add-block').addEventListener('click', addBlockAtEnd);

  // --- the whole-file source pane ---------------------------------------------

  // --- Split mode: source and preview side by side, scrolling together ---------

  // Pairs of matching vertical positions {src, pre}: where each rendered block
  // starts in the source text and in the preview. Scrolling one side maps its
  // position between the two nearest pairs onto the other side.
  let anchors = null;
  let mirror = null;
  let driver = null;
  let driverTimer = null;

  function buildAnchors() {
    const blocks = Array.from(preview.querySelectorAll(':scope > .src-block')).filter((b) => b.offsetParent);
    // Measure where offsets fall in the wrapped textarea with an invisible copy of it.
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.setAttribute('aria-hidden', 'true');
      document.body.appendChild(mirror);
    }
    const cs = getComputedStyle(source);
    Object.assign(mirror.style, {
      position: 'fixed', visibility: 'hidden', pointerEvents: 'none', top: '0', left: '-10000px',
      boxSizing: 'border-box', width: source.clientWidth + 'px', padding: cs.padding, font: cs.font,
      lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, tabSize: cs.tabSize,
      whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: cs.wordBreak,
    });
    mirror.textContent = '';
    const marks = [];
    let pos = 0;
    for (const b of blocks) {
      const at = Math.min(Number(b.dataset.s), doc.length);
      if (at < pos) { marks.push(null); continue; }
      mirror.append(doc.slice(pos, at));
      const mark = document.createElement('span');
      mirror.append(mark);
      marks.push(mark);
      pos = at;
    }
    mirror.append(doc.slice(pos) + '\n');
    const paneTop = previewPane.getBoundingClientRect().top - previewPane.scrollTop;
    const list = [{ src: 0, pre: 0 }];
    blocks.forEach((b, k) => {
      if (!marks[k]) return;
      const src = marks[k].offsetTop;
      const pre = b.getBoundingClientRect().top - paneTop;
      const last = list[list.length - 1];
      if (src >= last.src && pre >= last.pre) list.push({ src, pre });
    });
    const end = {
      src: Math.max(0, source.scrollHeight - source.clientHeight),
      pre: Math.max(0, previewPane.scrollHeight - previewPane.clientHeight),
    };
    const last = list[list.length - 1];
    if (end.src > last.src && end.pre > last.pre) list.push(end);
    anchors = list;
  }

  function mapY(y, from, to) {
    const a = anchors;
    for (let k = 1; k < a.length; k++) {
      if (y <= a[k][from] || k === a.length - 1) {
        const p = a[k - 1];
        const q = a[k];
        const t = q[from] === p[from] ? 0 : Math.max(0, Math.min(1, (y - p[from]) / (q[from] - p[from])));
        return p[to] + t * (q[to] - p[to]);
      }
    }
    return 0;
  }

  /** Scroll the other side to match `side` ('src' or 'pre'). */
  function syncFrom(side) {
    if (mode !== 'split') return;
    if (!anchors) buildAnchors();
    driver = side;
    clearTimeout(driverTimer);
    driverTimer = setTimeout(() => { driver = null; }, 120);
    if (side === 'src') previewPane.scrollTop = mapY(source.scrollTop, 'src', 'pre');
    else source.scrollTop = mapY(previewPane.scrollTop, 'pre', 'src');
  }

  const onScroll = (side) => () => {
    if (mode !== 'split' || (driver && driver !== side)) return;
    syncFrom(side);
  };
  source.addEventListener('scroll', onScroll('src'), { passive: true });
  previewPane.addEventListener('scroll', onScroll('pre'), { passive: true });
  window.addEventListener('resize', () => { anchors = null; });
  if (document.fonts) document.fonts.ready.then(() => { anchors = null; });

  // In Split mode, clicking the preview puts the cursor at that block's source.
  preview.addEventListener('click', (e) => {
    if (mode !== 'split' || e.target.closest('a, .fold-toggle') || String(window.getSelection())) return;
    const block = e.target.closest('.src-block');
    if (!block) return;
    const at = Number(block.dataset.s);
    const top = previewPane.scrollTop;
    source.focus({ preventScroll: true });
    source.setSelectionRange(at, at);
    previewPane.scrollTop = top;
    syncFrom('pre');
  });
  source.addEventListener('input', () => {
    closeEditor(false);
    doc = source.value;
    setDirty(true);
    rememberSoon();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      render();
      if (mode === 'split') requestAnimationFrame(() => syncFrom('src'));
    }, 150);
  });
  source.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
      source.dispatchEvent(new Event('input'));
    }
  });

  // --- opening and saving files -------------------------------------------------

  async function openWithPicker() {
    // The picker is not allowed inside an embedded frame; use the plain file input there.
    if (window.showOpenFilePicker && !inFrame) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'LaTeX', accept: { 'text/x-tex': ['.tex', '.ltx', '.latex'] } }],
        });
        await openHandle(handle);
      } catch (e) {
        if (e.name !== 'AbortError') $('file-input').click();
      }
    } else {
      $('file-input').click();
    }
  }

  async function openHandle(handle) {
    fileHandle = handle;
    const file = await handle.getFile();
    lastModified = file.lastModified;
    load(await file.text(), file.name);
    flashStatus('Watching the file for changes');
  }

  async function openFile(file) {
    fileHandle = null;
    load(await file.text(), file.name);
  }

  function save() {
    if (fileHandle && fileHandle.createWritable) {
      (async () => {
        try {
          const w = await fileHandle.createWritable();
          await w.write(doc);
          await w.close();
          lastModified = (await fileHandle.getFile()).lastModified;
          setDirty(false);
          flashStatus('Saved');
        } catch (e) {
          flashStatus('Could not save: ' + (e.message || e.name));
        }
      })();
      return;
    }
    if (inFrame) {
      // Downloads are blocked in an embedded page; copy the source instead.
      navigator.clipboard.writeText(doc).then(
        () => flashStatus('Source copied to the clipboard'),
        () => flashStatus('Could not copy; use Source to select the text')
      );
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([doc], { type: 'text/x-tex' }));
    a.download = fileName.textContent || 'document.tex';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setDirty(false);
    flashStatus('Downloaded');
  }

  // Re-render when the file changes on disk (browsers with the File System Access API),
  // unless there are edits made here that would be lost.
  setInterval(async () => {
    if (!fileHandle || document.hidden || dirty) return;
    try {
      const file = await fileHandle.getFile();
      if (file.lastModified !== lastModified) {
        lastModified = file.lastModified;
        closeEditor(false);
        doc = (await file.text()).replace(/\r\n?/g, '\n');
        setSource(doc);
        render();
        store.set('texdown:last', doc);
      }
    } catch (e) {
      fileHandle = null;
    }
  }, 1000);

  $('open').addEventListener('click', openWithPicker);
  $('save').addEventListener('click', save);
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) openFile(e.target.files[0]);
    e.target.value = '';
  });

  // Drag and drop.
  const overlay = $('drop-overlay');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (item && item.getAsFileSystemHandle && !inFrame) {
      try {
        const handle = await item.getAsFileSystemHandle();
        if (handle && handle.kind === 'file') return openHandle(handle);
      } catch (err) { /* fall back to a plain file */ }
    }
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'o') { e.preventDefault(); openWithPicker(); }
    if (mod && key === 's') { e.preventDefault(); save(); }
    if (mod && e.shiftKey && key === 'e') { e.preventDefault(); setMode(mode === 'split' ? 'preview' : 'split'); }
    else if (mod && key === 'e') { e.preventDefault(); setMode(mode === 'edit' ? 'preview' : 'edit'); }
  });

  // --- reference previews ----------------------------------------------------

  let hideTimer = null;
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.ref, .cite a');
    if (!a || (editing && editing.el.contains(a) && !editing.previewEl.contains(a))) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target || target.contains(a)) return;
    clearTimeout(hideTimer);
    popover.innerHTML = '';
    let node = target;
    if (node.classList.contains('caption') && node.parentElement.tagName === 'FIGURE') node = node.parentElement;
    if (/^H[1-6]$/.test(node.tagName)) {
      popover.innerHTML = `<p><strong>${node.innerHTML}</strong></p>`;
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
  preview.addEventListener('click', (e) => {
    if (mode === 'edit') return; // in Edit mode a click opens the block instead
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    popover.hidden = true;
    reveal(target);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  });

  // --- resizable split ------------------------------------------------------------

  const panes = $('panes');
  const splitter = $('splitter');

  function setSplit(pct, remember) {
    if (pct == null) {
      panes.style.removeProperty('--split');
      splitter.setAttribute('aria-valuenow', '50');
    } else {
      pct = Math.max(15, Math.min(85, pct));
      panes.style.setProperty('--split', pct.toFixed(1) + '%');
      splitter.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    anchors = null;
    if (remember) store.set('texdown:split', pct == null ? '' : String(pct));
  }

  const isStacked = () => getComputedStyle(panes).flexDirection === 'column';

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    document.body.classList.toggle('stacked', isStacked());
    const top = source.scrollTop;
    const move = (ev) => {
      const r = panes.getBoundingClientRect();
      const pct = isStacked() ? ((ev.clientY - r.top) / r.height) * 100 : ((ev.clientX - r.left) / r.width) * 100;
      setSplit(pct, false);
      source.scrollTop = top;
      syncFrom('src');
    };
    const up = () => {
      splitter.releasePointerCapture(e.pointerId);
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing', 'stacked');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      const v = parseFloat(panes.style.getPropertyValue('--split'));
      setSplit(isNaN(v) ? null : v, true);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('dblclick', () => setSplit(null, true));
  splitter.addEventListener('keydown', (e) => {
    const cur = parseFloat(splitter.getAttribute('aria-valuenow')) || 50;
    const step = e.shiftKey ? 10 : 2;
    const keys = { ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step };
    if (e.key in keys) setSplit(cur + keys[e.key], true);
    else if (e.key === 'Home') setSplit(15, true);
    else if (e.key === 'End') setSplit(85, true);
    else if (e.key === 'Enter') setSplit(null, true);
    else return;
    e.preventDefault();
  });
  {
    const saved = parseFloat(store.get('texdown:split'));
    if (!isNaN(saved)) setSplit(saved, false);
  }

  // --- light and dark theme ------------------------------------------------------

  const rootEl = document.documentElement;
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const themeButton = $('theme-toggle');
  const isDark = () => (rootEl.dataset.theme ? rootEl.dataset.theme === 'dark' : !!(darkQuery && darkQuery.matches));

  function updateThemeButton() {
    const dark = isDark();
    document.body.classList.toggle('theme-dark', dark);
    themeButton.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeButton.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  }

  themeButton.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    rootEl.dataset.theme = next;
    store.set('texdown:theme', next);
    updateThemeButton();
  });
  {
    const saved = store.get('texdown:theme');
    if (saved === 'light' || saved === 'dark') rootEl.dataset.theme = saved;
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', updateThemeButton);
    // The page's host may also change the theme attribute.
    new MutationObserver(updateThemeButton).observe(rootEl, { attributes: true, attributeFilter: ['data-theme'] });
    updateThemeButton();
  }

  // --- start -----------------------------------------------------------------

  // --- import from arXiv ------------------------------------------------------------

  const arxivDialog = $('arxiv-dialog');
  const arxivInput = $('arxiv-input');
  const arxivMessage = $('arxiv-message');
  const arxivGo = $('arxiv-go');
  let arxivBusy = false;

  function arxivSay(text, warn) {
    arxivMessage.textContent = text;
    arxivMessage.classList.toggle('warn', !!warn);
  }

  async function importArxiv(input) {
    if (arxivBusy) return false;
    const id = TeXdownArxiv.parseId(input);
    if (!id) {
      arxivSay('That does not look like an arXiv link or id, e.g. 2301.00001 or arxiv.org/abs/2301.00001.', true);
      return false;
    }
    arxivBusy = true;
    arxivGo.disabled = true;
    arxivSay(`Downloading ${id} from arXiv…`);
    showStatus(`Importing ${id}…`);
    try {
      const paper = await TeXdownArxiv.importPaper(id);
      fileHandle = null;
      load(paper.source, paper.name, paper.images);
      if (arxivDialog.open) arxivDialog.close();
      flashStatus(`Imported ${id} from arXiv`);
      return true;
    } catch (e) {
      const blocked = e instanceof TypeError || /Failed to fetch|NetworkError|Load failed|Could not reach/.test(e.message);
      arxivSay(blocked
        ? `Could not download ${id}. This page may not be allowed to reach arxiv.org here. Download arxiv.org/src/${id}, unpack it and open the .tex file instead.`
        : e.message, true);
      showStatus(warningsText);
      if (!arxivDialog.open) openArxivDialog(input);
      return false;
    } finally {
      arxivBusy = false;
      arxivGo.disabled = false;
    }
  }

  function openArxivDialog(value) {
    if (value != null) arxivInput.value = value;
    if (!arxivDialog.open) {
      if (arxivDialog.showModal) arxivDialog.showModal();
      else arxivDialog.setAttribute('open', '');
    }
    arxivInput.focus();
    arxivInput.select();
  }

  $('arxiv').addEventListener('click', () => {
    arxivSay('The source is downloaded from arxiv.org; figures in PNG or JPEG are shown too.');
    openArxivDialog();
  });
  $('arxiv-cancel').addEventListener('click', () => arxivDialog.close());
  $('arxiv-form').addEventListener('submit', (e) => {
    e.preventDefault();
    importArxiv(arxivInput.value);
  });

  // Pasting an arXiv link anywhere outside a text field imports it.
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (/arxiv/i.test(text) && TeXdownArxiv.parseId(text)) {
      e.preventDefault();
      importArxiv(text);
    }
  });

  async function loadSample() {
    fileHandle = null;
    try {
      const res = await fetch('examples/sample.tex');
      if (!res.ok) throw new Error(res.statusText);
      load(await res.text(), 'sample.tex');
    } catch (e) {
      load(
        '\\section*{Welcome to \\TeX down}\nOpen a \\texttt{.tex} file with the button above, or drop one on this page.\n\n' +
          'Math such as $\\int_0^1 x^2\\,dx = \\tfrac13$ is rendered with KaTeX.',
        'welcome.tex'
      );
    }
  }

  $('load-sample').addEventListener('click', loadSample);

  function start() {
    const saved = store.get('texdown:mode');
    setMode(saved === 'edit' || saved === 'split' ? saved : 'preview');
    // ?arxiv=2301.00001 opens that paper.
    const param = new URLSearchParams(location.search).get('arxiv');
    if (param && window.TeXdownArxiv) {
      const last = store.get('texdown:last');
      if (last) load(last, store.get('texdown:last-name'));
      return importArxiv(param);
    }
    const last = store.get('texdown:last');
    if (last) return load(last, store.get('texdown:last-name'));
    return loadSample();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
