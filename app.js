/* TeXglass viewer: opening files, live reload, in-place editing and reference previews. */
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
  // Click a formula to copy its LaTeX; off in Edit mode, where a click opens the block.
  const copier = window.TeXglassCopyTex ? window.TeXglassCopyTex.attach({ roots: [preview, popover] }) : null;

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
  let imageMap = null; // { path: object URL } for those figures

  // Syntax colouring and completion for both source editors.
  const editorOptions = { labels: () => lastLabels, source: () => doc };
  const sourceAids = window.TeXglassEditor ? TeXglassEditor.attach(source, editorOptions) : { refresh() {}, close() {} };
  const setSource = (text) => {
    source.value = text;
    sourceAids.refresh();
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  // Until November 2026 the viewer was called TeXdown and kept its state under
  // texdown:* keys. Carry those over once, so the last document, folds, theme
  // and layout survive the rename.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('texdown:') && localStorage.getItem('texglass:' + k.slice(8)) === null) {
        localStorage.setItem('texglass:' + k.slice(8), localStorage.getItem(k));
      }
    }
  } catch (e) { /* storage unavailable */ }

  // --- rendering -------------------------------------------------------------

  // Long documents (hundreds of pages, tens of thousands of formulas) take
  // seconds to convert, so the conversion runs in a worker where it can, and
  // the preview then replaces only the blocks whose HTML changed. Without a
  // worker (file:// pages, strict sandboxes) the same code runs here instead.
  const convert = (() => {
    const katexScript = document.querySelector('script[src*="katex"]');
    let worker = null;
    let ready = Promise.resolve(false);
    let nextId = 0;
    const waiting = new Map();
    const giveUp = () => {
      if (worker) worker.terminate();
      worker = null;
      waiting.forEach((done) => done(null));
      waiting.clear();
    };
    try {
      if (window.Worker && katexScript && katexScript.src) {
        worker = new Worker('src/render-worker.js');
        ready = new Promise((resolve) => {
          worker.onmessage = (e) => {
            const m = e.data;
            if ('ready' in m) {
              if (!m.ready) giveUp();
              resolve(m.ready);
              return;
            }
            const done = waiting.get(m.id);
            waiting.delete(m.id);
            if (done) done(m);
          };
          worker.onerror = (e) => {
            e.preventDefault();
            giveUp();
            resolve(false);
          };
        });
        worker.postMessage({ katex: katexScript.src });
      }
    } catch (e) {
      worker = null;
    }
    const here = (source, images) =>
      TeXglass.render(source, {
        sourceMap: true,
        resolveImage: images && window.TeXglassArxiv ? TeXglassArxiv.imageResolver(images, source) : undefined,
      });
    return async (source, images) => {
      if (worker && (await ready) && worker) {
        const m = await new Promise((resolve) => {
          const id = ++nextId;
          waiting.set(id, resolve);
          worker.postMessage({ id, source, images });
        });
        if (m && m.result) return m.result;
        if (m && m.error) throw new Error(m.error);
      }
      return here(source, images);
    };
  })();

  let renderedDoc = null; // the source the preview shows now
  let shown = []; // [{ html, nodes }] for each top-level block in the preview, except any in the inline editor
  let busy = false;
  let waiters = [];

  /** Render the current source. Resolves once the preview shows it. */
  function render() {
    return new Promise((resolve) => {
      waiters.push(resolve);
      if (!busy) runRender();
    });
  }

  function runRender() {
    busy = true;
    const source = doc;
    const done = waiters;
    waiters = [];
    const slow = setTimeout(() => { if (!statusTimer) showStatus('Rendering…'); }, 300);
    convert(source, imageMap)
      .then(
        (result) => showResult(result, source),
        (e) => {
          showStatus('Render failed', true);
          showBlocks([`<pre class="render-error">${TeXglass.escapeHtml(e.stack || e.message || String(e))}</pre>`], source);
        }
      )
      .catch((e) => console.error(e))
      .then(() => {
        clearTimeout(slow);
        busy = false;
        done.forEach((f) => f());
        if (waiters.length) runRender();
      });
  }

  function showResult(result, source) {
    lastLabels = result.labels;
    lastToc = result.toc;
    document.title = result.title ? `${result.title} — TeXglass` : 'TeXglass';
    const n = result.warnings.length;
    warningsText = n ? `${n} warning${n > 1 ? 's' : ''}` : '';
    status.title = result.warnings.join('\n');
    if (!statusTimer) showStatus(warningsText, n > 0);
    const blocks = result.blocks.length ? result.blocks : ['<p class="empty-doc">This document is empty. Switch to Edit and click “Add text”.</p>'];
    showBlocks(blocks, source);
  }

  function showBlocks(blocks, source) {
    renderedDoc = source;
    patchPreview(blocks);
    applyFolds();
    updateToc();
  }

  const BLOCK_HEAD = /^<div class="src-block" data-s="(\d+)" data-e="(\d+)">/;
  /** A block's HTML without its source range, which shifts with every edit above it. */
  const bodyOf = (html) => (html.startsWith('<div class="src-block"') ? html.slice(html.indexOf('>') + 1) : html);

  /** Parse blocks of HTML into [{ html, nodes }], in one go. */
  function toEntries(blocks) {
    if (!blocks.length) return [];
    const tpl = document.createElement('template');
    tpl.innerHTML = blocks.join('<!--b-->');
    const entries = blocks.map((html) => ({ html, nodes: [] }));
    let k = 0;
    for (const node of Array.from(tpl.content.childNodes)) {
      if (node.nodeType === 8 && node.data === 'b') k++;
      else entries[k].nodes.push(node);
    }
    return entries;
  }

  /** The block element of an entry that carries a source range, if any. */
  const blockOf = (entry) => entry.nodes.find((n) => n.nodeType === 1 && n.classList.contains('src-block')) || null;

  /**
   * Show `blocks` in the preview, keeping the DOM of blocks that did not
   * change. While the inline editor is open, the blocks inside its range go
   * to its own preview and the rest are laid out around it.
   */
  function patchPreview(blocks) {
    let outside = blocks;
    let groups = null; // with the editor open: 'b'efore or 'a'fter it, per outside block
    let inside = [];
    if (editing) {
      const { s, len } = editing;
      const end = s + len;
      outside = [];
      groups = [];
      let group = 'b';
      for (const html of blocks) {
        const m = BLOCK_HEAD.exec(html);
        if (m) {
          const bs = Number(m[1]);
          if (bs >= s && bs < end) { inside.push(html); group = 'a'; continue; }
          group = bs < s ? 'b' : 'a';
        }
        outside.push(html);
        groups.push(group);
      }
    }
    const old = shown;
    const same = (entry, html) => entry.html === html || bodyOf(entry.html) === bodyOf(html);
    let p = 0;
    while (p < old.length && p < outside.length && same(old[p], outside[p])) p++;
    let q = 0;
    while (q < old.length - p && q < outside.length - p && same(old[old.length - 1 - q], outside[outside.length - 1 - q])) q++;
    // Kept blocks may have moved in the source: update their ranges.
    const keep = (entry, html) => {
      if (entry.html === html) return entry;
      const m = BLOCK_HEAD.exec(html);
      const el = m && blockOf(entry);
      if (el) { el.dataset.s = m[1]; el.dataset.e = m[2]; }
      entry.html = html;
      return entry;
    };
    for (let k = 0; k < p; k++) keep(old[k], outside[k]);
    for (let k = 1; k <= q; k++) keep(old[old.length - k], outside[outside.length - k]);
    // Replace the rest.
    for (const entry of old.slice(p, old.length - q)) entry.nodes.forEach((n) => n.remove());
    const fresh = toEntries(outside.slice(p, outside.length - q));
    const tail = old.slice(old.length - q);
    const firstNode = (entries) => (entries.length ? entries[0].nodes[0] || null : null);
    if (!editing) {
      const ref = firstNode(tail.filter((e) => e.nodes.length));
      fresh.forEach((e) => e.nodes.forEach((n) => preview.insertBefore(n, ref)));
    } else {
      // New blocks go on their side of the editor.
      const tailGroups = groups.slice(groups.length - q);
      const beforeRef = firstNode(tail.filter((e, k) => tailGroups[k] === 'b' && e.nodes.length)) || editing.el;
      const afterRef = firstNode(tail.filter((e, k) => tailGroups[k] === 'a' && e.nodes.length));
      if (!editing.el.parentNode) preview.appendChild(editing.el);
      fresh.forEach((e, k) => {
        const ref = groups[p + k] === 'b' ? beforeRef : afterRef;
        e.nodes.forEach((n) => preview.insertBefore(n, ref));
      });
      const insideHtml = inside.join('\n');
      if (insideHtml !== editing.insideHtml) {
        editing.insideHtml = insideHtml;
        editing.inside = toEntries(inside);
        editing.previewEl.replaceChildren(...editing.inside.flatMap((e) => e.nodes));
      }
    }
    shown = old.slice(0, p).concat(fresh, tail);
  }

  /** Forget the preview, e.g. before showing another document. */
  function clearPreview() {
    preview.replaceChildren();
    shown = [];
    renderedDoc = null;
  }

  // --- table of contents sidebar ------------------------------------------------

  const tocPane = $('toc-pane');
  const tocList = $('toc-list');
  const tocToggle = $('toc-toggle');
  const narrow = window.matchMedia('(max-width: 760px)');
  let tocWanted = store.get('texglass:toc') !== 'off';
  let tocKey = '';
  let tocLinks = [];

  function updateToc() {
    // The bibliography gets an entry too, where it is in the document (before any appendix).
    const items = lastToc.slice();
    const bib = preview.querySelector('.bibliography > h2');
    if (bib && items.length && !items.some((t) => t.id === (bib.id || 'references'))) {
      bib.id = bib.id || 'references';
      const entry = { level: Math.min(...items.map((t) => t.level)), num: '', title: TeXglass.escapeHtml(bib.textContent), id: bib.id };
      const after = items.findIndex((t) => { const h = document.getElementById(t.id); return h && bib.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING; });
      items.splice(after < 0 ? items.length : after, 0, entry);
    }
    lastToc = items;
    const key = JSON.stringify(items);
    if (key !== tocKey) {
      tocKey = key;
      const top = Math.min(...items.map((t) => t.level));
      tocList.innerHTML = items
        .map((t) => `<li class="toc-d${Math.min(3, t.level - top)}"><a href="#${t.id}" data-id="${t.id}">${t.num ? `<span class="toc-num">${TeXglass.escapeHtml(t.num)}</span>` : ''}<span class="toc-title">${t.title}</span></a></li>`)
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
    TeXglassScroll.to(previewPane, target);
    markToc(a);
    tocJump = Date.now() + 1000;
    if (narrow.matches) { tocWanted = false; showToc(); }
  });

  tocToggle.addEventListener('click', () => {
    tocWanted = !tocWanted;
    if (!narrow.matches) store.set('texglass:toc', tocWanted ? 'on' : 'off');
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

  // The contents go on the left of the document, or on the right.
  const tocSide = $('toc-side');
  function setTocSide(right) {
    document.body.classList.toggle('toc-right', right);
    const label = right ? 'Move the contents to the left' : 'Move the contents to the right';
    tocSide.setAttribute('aria-label', label);
    tocSide.title = label;
  }
  setTocSide(store.get('texglass:toc-side') === 'right');
  tocSide.addEventListener('click', () => {
    const right = !document.body.classList.contains('toc-right');
    store.set('texglass:toc-side', right ? 'right' : 'left');
    setTocSide(right);
  });

  // --- zoom ----------------------------------------------------------------------

  // Ctrl/Cmd +, − and 0, or the toolbar buttons, scale the document and leave
  // the toolbar as it is. The level is remembered; printing is always at 100%.
  const zoomLevel = $('zoom-level');
  const zoom = window.TeXglassZoom
    ? TeXglassZoom.create({
      pane: previewPane,
      document: preview,
      onChange(z) {
        store.set('texglass:zoom', String(z));
        showZoom();
      },
    })
    : null;
  function showZoom() {
    zoomLevel.textContent = zoom.label();
    $('zoom-out').disabled = zoom.level <= TeXglassZoom.MIN;
    $('zoom-in').disabled = zoom.level >= TeXglassZoom.MAX;
  }
  if (zoom) {
    zoom.set(TeXglassZoom.parse(store.get('texglass:zoom')), true);
    showZoom();
    $('zoom-in').addEventListener('click', () => zoom.step(1));
    $('zoom-out').addEventListener('click', () => zoom.step(-1));
    zoomLevel.addEventListener('click', () => zoom.reset());
    window.addEventListener('keydown', (e) => {
      const dir = TeXglassZoom.keyStep(e);
      if (dir === null) return;
      e.preventDefault();
      if (dir) zoom.step(dir);
      else zoom.reset();
    });
    // Ctrl + mouse wheel or a trackpad pinch over the document zooms it too.
    previewPane.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom.set(zoom.level * Math.exp(-e.deltaY / 300));
    }, { passive: false });
  } else {
    zoomLevel.parentNode.hidden = true;
  }

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
    saveTimer = setTimeout(() => store.set('texglass:last', doc), 400);
  }

  function load(text, name, images, gh) {
    closeEditor(false);
    setGitHub(gh || null);
    imageUrls.forEach((u) => URL.revokeObjectURL(u));
    imageUrls = [];
    imageMap = null;
    if (images && Object.keys(images).length && window.TeXglassArxiv) {
      imageMap = {};
      for (const [path, blob] of Object.entries(images)) imageUrls.push((imageMap[path] = URL.createObjectURL(blob)));
    }
    doc = text.replace(/\r\n?/g, '\n');
    setSource(doc);
    fileName.textContent = name || 'untitled.tex';
    setDirty(false);
    clearPreview();
    const shown = render();
    previewPane.scrollTop = 0;
    store.set('texglass:last', doc);
    store.set('texglass:last-name', name || '');
    return shown;
  }

  /** Scroll the preview to the block that shows the source at offset `at`. */
  function scrollToSource(at) {
    // The first block that ends after it: the one holding it, or the next one if it falls between blocks.
    const target = Array.from(previewPane.querySelectorAll('.src-block')).find((b) => Number(b.dataset.e) > at);
    if (!target) return;
    // Blocks off screen are only estimated (content-visibility), so settle the position over a few frames.
    let n = 0;
    const step = () => {
      target.scrollIntoView({ block: 'start' });
      if (++n < 4) requestAnimationFrame(step);
    };
    step();
  }

  // Where the open document came from on GitHub: { links: { view, edit, dev }, path }.
  const ghLink = $('gh-link');
  function setGitHub(gh) {
    ghLink.hidden = !gh;
    if (gh) {
      ghLink.href = gh.links.edit;
      ghLink.title = `Open ${gh.path} on GitHub to edit and commit it. Or press "." there to edit it in github.dev.`;
    }
    store.set('texglass:last-gh', gh ? JSON.stringify(gh) : '');
  }

  // --- folding sections and proofs -------------------------------------------

  // Folded items are remembered by their text, so they stay folded across
  // re-renders and edits elsewhere in the document.
  const folded = new Set();
  try { JSON.parse(store.get('texglass:folds') || '[]').forEach((k) => folded.add(k)); } catch (e) { /* ignore */ }
  const saveFolds = () => store.set('texglass:folds', JSON.stringify(Array.from(folded).slice(-500)));

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
    const onFormula = !!e.target.closest('.math-copyable .math[data-tex]'); // that click copies it
    const foldedProof = !btn && !onFormula && mode !== 'edit' && e.target.closest('.proof.folded');
    const heading = !btn && !onFormula && mode !== 'edit' && !e.target.closest('a') && e.target.closest('#preview > .src-block > h1, #preview > .src-block > h2, #preview > .src-block > h3, #preview > .src-block > h4');
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
    if (copier) copier.setEnabled(m !== 'edit');
    for (const k of ['preview', 'edit', 'split']) $('mode-' + k).setAttribute('aria-pressed', String(m === k));
    store.set('texglass:mode', m);
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
    const aids = window.TeXglassEditor ? TeXglassEditor.attach(textarea, editorOptions) : { refresh() {}, close() {} };
    textarea.addEventListener('input', onBlockInput);
    textarea.addEventListener('keydown', onBlockKey);
    return { el, textarea, previewEl, aids };
  }

  /** Open the source range [s, e) for editing, with the caret at `caret`. */
  function openEditor(s, e, caret) {
    if (editing) closeEditor(false);
    const ed = makeEditor();
    editing = Object.assign(ed, { s, len: e - s, inside: [], insideHtml: '' });
    ed.textarea.value = doc.slice(s, e);
    ed.aids.refresh();
    // Put the editor where the block was, so the page does not jump, and show
    // the block's rendering under it.
    const k = shown.findIndex((entry) => {
      const el = blockOf(entry);
      return el && Number(el.dataset.s) === s;
    });
    if (k >= 0) {
      const entry = shown[k];
      entry.nodes[0].before(ed.el);
      shown.splice(k, 1);
      ed.inside = [entry];
      ed.insideHtml = entry.html;
      ed.previewEl.replaceChildren(...entry.nodes);
    } else {
      const next = shown.find((entry) => {
        const el = blockOf(entry);
        return el && Number(el.dataset.s) >= s;
      });
      preview.insertBefore(ed.el, next ? next.nodes[0] : null);
    }
    applyFolds();
    autosize();
    ed.textarea.focus({ preventScroll: true });
    const pos = Math.max(0, Math.min(caret == null ? 0 : caret, ed.textarea.value.length));
    ed.textarea.setSelectionRange(pos, pos);
  }

  /** Close the inline editor, putting the block it shows back in its place. */
  function closeEditor(rerender) {
    if (!editing) return;
    const { el, inside } = editing;
    const top = el.getBoundingClientRect().top;
    editing = null;
    // The editor sits after every block that comes before it in the source.
    let at = 0;
    while (at < shown.length && shown[at].nodes.length && el.compareDocumentPosition(shown[at].nodes[0]) & Node.DOCUMENT_POSITION_PRECEDING) at++;
    const nodes = inside.flatMap((entry) => entry.nodes);
    if (el.parentNode) el.replaceWith(...nodes);
    else nodes.forEach((n) => n.remove());
    shown.splice(at, 0, ...inside);
    if (rerender === false) return;
    applyFolds();
    // Keep the block that was being edited where it was on screen.
    const block = nodes.find((n) => n.nodeType === 1);
    if (block) previewPane.scrollTop += block.getBoundingClientRect().top - top;
    if (doc !== renderedDoc) render();
  }

  function onBlockInput() {
    const value = editing.textarea.value;
    const delta = value.length - editing.len;
    doc = doc.slice(0, editing.s) + value + doc.slice(editing.s + editing.len);
    editing.len = value.length;
    // Blocks further down moved in the source; keep their ranges right until
    // the next render, so clicking one opens the right text.
    if (delta) {
      for (const entry of shown) {
        const b = blockOf(entry);
        if (b && Number(b.dataset.s) > editing.s) {
          b.dataset.s = Number(b.dataset.s) + delta;
          b.dataset.e = Number(b.dataset.e) + delta;
        }
      }
    }
    if (document.activeElement !== source) setSource(doc);
    setDirty(true);
    autosize();
    rememberSoon();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 120);
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
    hidePopover();
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
      render().then(() => {
        if (mode === 'split') requestAnimationFrame(() => syncFrom('src'));
      });
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

  // --- export to HTML --------------------------------------------------------

  const readAsDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });

  /** KaTeX's stylesheet with its fonts inside, fetched from where this page loads them; null if that fails. */
  async function katexCssWithFonts() {
    const link = document.querySelector('link[rel="stylesheet"][href*="katex"]');
    if (!link) return null;
    try {
      const res = await fetch(link.href);
      if (!res.ok) return null;
      return await TeXglassExport.embedKatexFonts(await res.text(), async (name) => {
        const r = await fetch(new URL('fonts/' + name, link.href));
        if (!r.ok) throw new Error(name);
        return (await readAsDataUrl(await r.blob())).replace(/^data:[^,]*,/, '');
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Download the document as one standalone .html page, with the math rendered
   * and the theorems numbered as in the preview, and imported figures inside it.
   */
  async function exportHtml() {
    if (!window.TeXglassExport) return;
    showStatus('Exporting…');
    try {
      const result = await convert(doc, imageMap);
      const isBlob = (u) => u.startsWith('blob:');
      const body = await TeXglassExport.replaceImages(TeXglassExport.joinBlocks(result.blocks), isBlob, async (u) => readAsDataUrl(await (await fetch(u)).blob()));
      const cssLink = document.querySelector('link[rel="stylesheet"][href$="styles.css"]');
      const css = cssLink ? await (await fetch(cssLink.href)).text() : '';
      const diagramsJs = /class="tg-diagram/.test(body) ? await (await fetch('src/diagrams.js')).text().catch(() => '') : '';
      const html = TeXglassExport.page({ body, title: result.title || fileName.textContent || 'Document', css, katexCss: await katexCssWithFonts(), diagramsJs });
      const name = TeXglassExport.fileName(fileName.textContent, result.title);
      if (inFrame) {
        // Downloads are blocked in an embedded page; copy the page instead.
        await navigator.clipboard.writeText(html);
        flashStatus('HTML copied to the clipboard');
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      flashStatus('Exported ' + name);
    } catch (e) {
      flashStatus('Could not export: ' + (e.message || e));
    }
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
        store.set('texglass:last', doc);
      }
    } catch (e) {
      fileHandle = null;
    }
  }, 1000);

  $('open').addEventListener('click', openWithPicker);
  $('save').addEventListener('click', save);
  $('export').addEventListener('click', exportHtml);

  // --- print / save as PDF -----------------------------------------------------
  // The print stylesheet (styles.css) lays the document out like a paper. Before
  // printing, finish any inline edit so that the printout is the document itself.
  window.addEventListener('beforeprint', () => {
    if (editing) closeEditor();
    hidePopover();
  });
  $('print').addEventListener('click', () => window.print());
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

  // The popover stays open while the pointer is on the link or on the popover
  // itself, so a long preview can be scrolled. It closes a moment after the
  // pointer has left both.
  const HIDE_DELAY = 250;
  let hideTimer = null;
  let popoverLink = null;
  function hidePopover() {
    clearTimeout(hideTimer);
    popover.hidden = true;
    popoverLink = null;
  }
  function hidePopoverSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopover, HIDE_DELAY);
  }
  function showPopover(a, target) {
    clearTimeout(hideTimer);
    if (popoverLink === a && !popover.hidden) return;
    popoverLink = a;
    const body = document.createElement('div');
    body.className = 'ref-popover-body';
    let node = target;
    if (node.classList.contains('caption') && node.parentElement.tagName === 'FIGURE') node = node.parentElement;
    if (/^H[1-6]$/.test(node.tagName)) {
      body.innerHTML = `<p><strong>${node.innerHTML}</strong></p>`;
    } else {
      const clone = node.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      body.appendChild(clone);
    }
    popover.replaceChildren(body);
    popover.hidden = false;
    const r = a.getBoundingClientRect();
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
    popover.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
    // The popover's own 8px padding is the gap to the link (the hover bridge).
    const h = popover.offsetHeight;
    popover.style.top = (r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h : r.bottom) + 'px';
  }
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.ref, .cite a');
    if (!a || (editing && editing.el.contains(a) && !editing.previewEl.contains(a))) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target || target.contains(a)) return;
    showPopover(a, target);
  });
  preview.addEventListener('mouseout', (e) => {
    const a = e.target.closest('a.ref, .cite a');
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
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (target) jumpTo(target);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) hidePopover();
  });
  function jumpTo(target) {
    hidePopover();
    reveal(target);
    TeXglassScroll.to(previewPane, target, { align: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }
  preview.addEventListener('click', (e) => {
    if (mode === 'edit') return; // in Edit mode a click opens the block instead
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    jumpTo(target);
  });

  // --- find and go to ----------------------------------------------------------------

  // Ctrl+F searches the rendered text; Ctrl+G goes to "Lemma 4.1", "(3.2)", "§2".
  if (window.TeXglassFind) {
    const finder = window.TeXglassFind.attach({
      root: preview,
      scroller: previewPane,
      reveal,
      onJump: hidePopover,
    });
    window.TeXglassFind.bindKeys(window, finder);
    $('find').addEventListener('click', () => finder.open('find'));
  } else {
    $('find').hidden = true;
  }

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
    if (remember) store.set('texglass:split', pct == null ? '' : String(pct));
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
    const saved = parseFloat(store.get('texglass:split'));
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
    store.set('texglass:theme', next);
    updateThemeButton();
  });
  {
    const saved = store.get('texglass:theme');
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
  const arxivResults = $('arxiv-results');
  let arxivBusy = false;

  function arxivSay(text, warn) {
    arxivMessage.textContent = text;
    arxivMessage.classList.toggle('warn', !!warn);
  }

  async function importArxiv(input) {
    if (arxivBusy) return false;
    const id = TeXglassArxiv.parseId(input);
    if (!id) {
      arxivSay('That does not look like an arXiv link or id, e.g. 2301.00001 or arxiv.org/abs/2301.00001.', true);
      return false;
    }
    arxivBusy = true;
    arxivGo.disabled = true;
    arxivSay(`Downloading ${id} from arXiv…`);
    showStatus(`Importing ${id}…`);
    try {
      const paper = await TeXglassArxiv.importPaper(id);
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

  // --- searching arXiv (through OpenAlex; arXiv's own API blocks web pages) ---

  let searchRun = 0; // newer searches win over slower older ones
  let searchState = null; // { query, page, results, total, more }

  /** Text with $…$ / \(…\) maths through KaTeX, everything else escaped. */
  function mathText(text) {
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return String(text || '').split(/(\$\$[^$]+\$\$|\$[^$]+\$|\\\([\s\S]+?\\\))/).map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const tex = part.replace(/^\$\$?|\$\$?$/g, '').replace(/^\\\(|\\\)$/g, '');
      if (window.katex) {
        try { return katex.renderToString(tex, { throwOnError: true, output: 'html' }); } catch (e) { /* fall through */ }
      }
      return esc(part);
    }).join('');
  }

  function updateArxivButton() {
    const v = arxivInput.value.trim();
    arxivGo.textContent = !v || TeXglassArxiv.parseId(v) ? 'Import' : 'Search';
  }

  function showResults(on) {
    arxivResults.hidden = !on;
    arxivDialog.classList.toggle('has-results', on);
  }

  function renderSearch() {
    const st = searchState;
    arxivResults.textContent = '';
    const frag = document.createDocumentFragment();
    for (const r of st.results) {
      const li = document.createElement('li');
      li.className = 'preprint';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preprint-open';
      btn.title = `Open the LaTeX source of ${r.id}`;
      const authors = r.authors.length > 4 ? r.authors.slice(0, 3).join(', ') + ' et al.' : r.authors.join(', ');
      const meta = [authors, r.year, 'arXiv:' + r.id].filter(Boolean).join(' · ');
      btn.innerHTML = `<span class="preprint-title">${mathText(r.title)}</span>` +
        `<span class="arxiv-result-meta">${mathText(meta)}</span>` +
        (r.abstract ? `<span class="preprint-abstract">${mathText(r.abstract)}</span>` : '');
      btn.addEventListener('click', () => importArxiv(r.id));
      const abs = document.createElement('a');
      abs.className = 'preprint-pdf';
      abs.href = `https://arxiv.org/abs/${r.id}`;
      abs.target = '_blank';
      abs.rel = 'noopener';
      abs.textContent = 'arXiv';
      abs.title = 'The abstract page on arxiv.org';
      li.append(btn, abs);
      frag.appendChild(li);
    }
    if (st.more) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'preprints-more';
      more.textContent = 'Show more';
      more.addEventListener('click', () => searchArxiv(st.query, st.page + 1));
      const li = document.createElement('li');
      li.appendChild(more);
      frag.appendChild(li);
    }
    arxivResults.appendChild(frag);
    showResults(st.results.length > 0);
  }

  async function searchArxiv(query, page) {
    const run = ++searchRun;
    page = page || 1;
    if (page === 1) arxivResults.scrollTop = 0;
    arxivSay(page === 1 ? 'Searching arXiv…' : 'Loading more…');
    arxivGo.disabled = true;
    try {
      const res = await TeXglassArxiv.search(query, { page });
      if (run !== searchRun) return;
      if (page === 1 || !searchState || searchState.query !== query) searchState = { query, results: [] };
      const seen = new Set(searchState.results.map((r) => r.id));
      searchState.results.push(...res.results.filter((r) => !seen.has(r.id)));
      Object.assign(searchState, { page, total: res.total, more: res.more });
      renderSearch();
      const n = searchState.total;
      arxivSay(searchState.results.length
        ? `${n.toLocaleString()} paper${n === 1 ? '' : 's'} on arXiv. Click one to open its LaTeX source.`
        : 'No arXiv papers match that search.', !searchState.results.length);
    } catch (e) {
      if (run !== searchRun) return;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      arxivSay(offline
        ? 'Searching needs an internet connection. You can still paste an arXiv id once you are back online.'
        : `Search failed: ${e.message || e}. Try again in a moment, or paste an arXiv link or id.`, true);
    } finally {
      if (run === searchRun) arxivGo.disabled = false;
    }
  }

  function showArxivDialog() {
    if (!searchState && !arxivBusy) arxivSay('Search arXiv, or paste a link to download the source; figures in PNG or JPEG are shown too.');
    openArxivDialog();
    updateArxivButton();
  }
  $('arxiv').addEventListener('click', showArxivDialog);
  // Ctrl+K (Cmd+K on a Mac), the usual search shortcut, opens the arXiv dialog
  // from anywhere in the page, the editor included. Browsers let pages take it
  // over; it is left alone while another dialog is open.
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
    const other = document.querySelector('dialog[open]');
    if (other && other !== arxivDialog) return;
    e.preventDefault();
    showArxivDialog();
  });
  $('arxiv-cancel').addEventListener('click', () => arxivDialog.close());
  arxivInput.addEventListener('input', updateArxivButton);
  $('arxiv-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = arxivInput.value.trim();
    if (!v) return;
    if (TeXglassArxiv.parseId(v)) importArxiv(v);
    else searchArxiv(v, 1);
  });

  // Pasting an arXiv or GitHub link anywhere outside a text field opens it.
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (/arxiv/i.test(text) && TeXglassArxiv.parseId(text)) {
      e.preventDefault();
      importArxiv(text);
    } else if (/github/i.test(text) && window.TeXglassGitHub && TeXglassGitHub.parseUrl(text)) {
      e.preventDefault();
      importGitHub(text);
    }
  });

  // --- opening files from GitHub ---------------------------------------------

  const ghDialog = $('github-dialog');
  const ghInput = $('github-input');
  const ghMessage = $('github-message');
  const ghGo = $('github-go');
  let ghBusy = false;

  function ghSay(text, warn) {
    ghMessage.textContent = text;
    ghMessage.classList.toggle('warn', !!warn);
  }

  async function importGitHub(input) {
    if (ghBusy || !window.TeXglassGitHub) return false;
    if (!TeXglassGitHub.parseUrl(input)) {
      ghSay('That does not look like a GitHub link, e.g. https://github.com/owner/repo/blob/main/paper.tex.', true);
      if (!ghDialog.open) openGitHubDialog(input);
      return false;
    }
    ghBusy = true;
    ghGo.disabled = true;
    ghSay('Downloading from GitHub…');
    showStatus('Opening from GitHub…');
    try {
      const file = await TeXglassGitHub.importFile(input);
      fileHandle = null;
      const shown = load(file.source, file.name, file.images, { links: file.links, path: `${file.owner}/${file.repo}/${file.opened || file.path}` });
      if (ghDialog.open) ghDialog.close();
      const more = file.files.length > 1 ? ` with ${file.files.length - 1} included file${file.files.length > 2 ? 's' : ''}` : '';
      if (file.opened && file.opened !== file.path) {
        // A chapter: the whole document is shown, scrolled to where the chapter begins.
        flashStatus(`Opened ${file.opened} as part of ${file.path}${more}`);
        if (file.start != null) shown.then(() => scrollToSource(file.start));
      } else {
        flashStatus(`Opened ${file.path} from ${file.owner}/${file.repo}${more}`);
      }
      return true;
    } catch (e) {
      ghSay(e instanceof TypeError ? 'Could not reach GitHub from this page. Check your connection.' : e.message, true);
      showStatus(warningsText);
      if (!ghDialog.open) openGitHubDialog(input);
      return false;
    } finally {
      ghBusy = false;
      ghGo.disabled = false;
    }
  }

  function openGitHubDialog(value) {
    if (value != null) ghInput.value = value;
    if (!ghDialog.open) {
      if (ghDialog.showModal) ghDialog.showModal();
      else ghDialog.setAttribute('open', '');
    }
    ghInput.focus();
    ghInput.select();
  }

  const bookmarkletLink = $('bookmarklet');
  // Inside the browser extension the page is a chrome-extension:// or moz-extension://
  // URL that ordinary pages can't open, so the bookmarklet points at the website.
  const inExtension = /^(chrome|moz|ms-browser)-extension:$/.test(location.protocol);
  const bookmarkletTarget = inExtension ? 'https://klepo0.github.io/TeXglass/' : location.href;
  if (window.TeXglassGitHub) bookmarkletLink.href = TeXglassGitHub.bookmarklet(bookmarkletTarget);
  bookmarkletLink.addEventListener('click', (e) => {
    e.preventDefault();
    ghSay('Drag the button to your bookmarks bar instead of clicking it here.');
  });

  $('github').addEventListener('click', () => {
    ghSay('Public repositories only. Included files, the bibliography and PNG or JPEG figures are fetched too.');
    openGitHubDialog();
  });
  $('github-cancel').addEventListener('click', () => ghDialog.close());
  $('github-form').addEventListener('submit', (e) => {
    e.preventDefault();
    importGitHub(ghInput.value);
  });

  // --- browsing OpenAI's math preprints -------------------------------------

  const ppDialog = $('preprints-dialog');
  const ppList = $('preprints-list');
  const ppSearch = $('preprints-search');
  const ppDiscipline = $('preprints-discipline');
  const ppMessage = $('preprints-message');
  const PP_PAGE = 40; // families shown before "Show more"
  let ppCatalogue = null; // { families, disciplines } once loaded
  let ppLoading = null;
  let ppShown = PP_PAGE;
  let ppBusy = false;

  function ppSay(text, warn) {
    ppMessage.textContent = text;
    ppMessage.classList.toggle('warn', !!warn);
  }

  /** The catalogue's text as HTML: GitHub math ($`…`$) through KaTeX, and only <i>, <b>, <sub>, <sup> kept. */
  function richText(text) {
    const esc = (t) => t.replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/&lt;(\/?)(i|b|em|sub|sup)&gt;/g, '<$1$2>');
    return String(text || '').split(/\$`([\s\S]*?)`\$/).map((part, i) => {
      if (i % 2 === 0) return esc(part);
      if (window.katex) {
        try { return katex.renderToString(part, { throwOnError: false, output: 'html' }); } catch (e) { /* fall through */ }
      }
      return '<code>' + esc(part) + '</code>';
    }).join('');
  }

  const plain = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/\$`|`\$/g, '').toLowerCase();

  function ppMatches() {
    if (!ppCatalogue) return [];
    const words = ppSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
    const disc = ppDiscipline.value;
    const out = [];
    for (const f of ppCatalogue.families) {
      if (disc && f.discipline !== disc) continue;
      if (!words.length) {
        out.push({ family: f, manuscripts: f.manuscripts });
        continue;
      }
      const head = f._head || (f._head = plain(`${f.number} ${f.title} ${f.description}`));
      const headHit = words.every((w) => head.includes(w));
      const ms = f.manuscripts.filter((m) => {
        const t = m._text || (m._text = plain(`${m.title} ${m.abstract} ${m.folder}`) + ' ' + head);
        return words.every((w) => t.includes(w));
      });
      if (headHit || ms.length) out.push({ family: f, manuscripts: headHit ? f.manuscripts : ms });
    }
    return out;
  }

  function renderPreprints() {
    const matches = ppMatches();
    ppList.textContent = '';
    const frag = document.createDocumentFragment();
    for (const { family: f, manuscripts } of matches.slice(0, ppShown)) {
      const li = document.createElement('li');
      li.className = 'preprint-family';
      li.innerHTML = `<div class="preprint-family-head"><span class="preprint-family-num">${f.number}</span>` +
        `<span class="preprint-family-title">${richText(f.title)}</span>` +
        (f.discipline ? `<span class="preprint-discipline">${richText(f.discipline)}</span>` : '') + '</div>' +
        `<p class="preprint-family-desc">${richText(f.description)}</p>`;
      const ul = document.createElement('ul');
      ul.className = 'preprint-manuscripts';
      for (const m of manuscripts) {
        const item = document.createElement('li');
        item.className = 'preprint';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preprint-open';
        btn.title = 'Open the LaTeX source in TeXglass';
        btn.innerHTML = `<span class="preprint-title">${richText(m.title)}</span>` +
          (m.note ? ` <span class="preprint-note">${richText(m.note)}</span>` : '') +
          `<span class="preprint-abstract">${richText(m.abstract)}</span>`;
        btn.addEventListener('click', () => openPreprint(m, btn));
        const pdf = document.createElement('a');
        pdf.className = 'preprint-pdf';
        pdf.href = TeXglassOpenAIMath.links(m).pdf;
        pdf.target = '_blank';
        pdf.rel = 'noopener';
        pdf.textContent = 'PDF';
        pdf.title = 'The PDF on GitHub';
        item.append(btn, pdf);
        ul.appendChild(item);
      }
      li.appendChild(ul);
      frag.appendChild(li);
    }
    ppList.appendChild(frag);
    if (matches.length > ppShown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'preprints-more';
      more.textContent = `Show more (${matches.length - ppShown} more results)`;
      more.addEventListener('click', () => {
        ppShown += PP_PAGE * 2;
        const top = ppList.scrollTop;
        renderPreprints();
        ppList.scrollTop = top;
      });
      const li = document.createElement('li');
      li.appendChild(more);
      ppList.appendChild(li);
    }
    const papers = matches.reduce((n, x) => n + x.manuscripts.length, 0);
    if (!ppBusy) {
      ppSay(matches.length
        ? `${papers} manuscript${papers === 1 ? '' : 's'} in ${matches.length} result famil${matches.length === 1 ? 'y' : 'ies'}. Click one to open its LaTeX source.`
        : 'Nothing matches that search.');
    }
  }

  function loadPreprints() {
    if (ppCatalogue) return Promise.resolve(ppCatalogue);
    if (!ppLoading) {
      ppSay('Loading the catalogue from github.com/openai/math…');
      ppLoading = TeXglassOpenAIMath.loadCatalogue().then((cat) => {
        ppCatalogue = cat;
        for (const d of cat.disciplines.slice().sort()) {
          const o = document.createElement('option');
          o.value = o.textContent = d;
          ppDiscipline.appendChild(o);
        }
        return cat;
      }).finally(() => { ppLoading = null; });
    }
    return ppLoading;
  }

  async function openPreprintsDialog() {
    if (!window.TeXglassOpenAIMath) return;
    if (!ppDialog.open) {
      if (ppDialog.showModal) ppDialog.showModal();
      else ppDialog.setAttribute('open', '');
    }
    ppSearch.focus();
    try {
      await loadPreprints();
      renderPreprints();
    } catch (e) {
      ppSay(e instanceof TypeError ? 'Could not reach GitHub from this page. Check your connection.' : e.message, true);
    }
  }

  async function openPreprint(m, btn) {
    if (ppBusy) return false;
    ppBusy = true;
    if (btn) btn.disabled = true;
    ppSay(`Downloading “${m.title}” from GitHub…`);
    showStatus('Opening from GitHub…');
    let failed = null;
    try {
      const file = await TeXglassOpenAIMath.openManuscript(m);
      fileHandle = null;
      load(file.source, `${m.folder}.tex`, file.images, { links: file.links, path: `openai/math/${file.path}` });
      fileName.title = m.title;
      if (ppDialog.open) ppDialog.close();
      const more = file.files.length > 1 ? ` with ${file.files.length - 1} included file${file.files.length > 2 ? 's' : ''}` : '';
      flashStatus(`Opened ${file.path.split('/').pop()} from openai/math${more}`);
    } catch (e) {
      failed = e instanceof TypeError ? 'Could not reach GitHub from this page. Check your connection.' : e.message;
      showStatus(warningsText);
    } finally {
      ppBusy = false;
      if (btn) btn.disabled = false;
    }
    if (failed) {
      // Show why in the list, opening it if the paper was asked for by link.
      if (!ppDialog.open) await openPreprintsDialog();
      ppSay(failed, true);
    }
    return !failed;
  }

  /** ?preprint=<folder>: open that manuscript straight away. */
  async function openPreprintByFolder(folder) {
    try {
      const cat = await loadPreprints();
      const m = TeXglassOpenAIMath.byFolder(cat.families, folder);
      if (m) return openPreprint(m);
      showStatus(`There is no preprint ${folder} in openai/math.`, true);
    } catch (e) {
      showStatus(e.message, true);
    }
    return false;
  }

  let ppTimer = null;
  ppSearch.addEventListener('input', () => {
    clearTimeout(ppTimer);
    ppTimer = setTimeout(() => {
      ppShown = PP_PAGE;
      if (ppCatalogue) renderPreprints();
      ppList.scrollTop = 0;
    }, 120);
  });
  ppDiscipline.addEventListener('change', () => {
    ppShown = PP_PAGE;
    if (ppCatalogue) renderPreprints();
    ppList.scrollTop = 0;
  });
  $('preprints').addEventListener('click', openPreprintsDialog);
  $('preprints-close').addEventListener('click', () => ppDialog.close());
  ppDialog.addEventListener('click', (e) => { if (e.target === ppDialog) ppDialog.close(); });
  if (!window.TeXglassOpenAIMath) $('preprints').hidden = true;

  function loadWelcome() {
    fileHandle = null;
    load(
      '\\section*{Welcome to TeXglass}\n' +
        'Open a \\texttt{.tex} file with the \\textbf{Open} button above, or drop one on this page. ' +
        'You can also import a paper from \\textbf{arXiv}, open a file from \\textbf{GitHub}, ' +
        'or browse OpenAI\'s mathematical \\textbf{Preprints} and read one here.\n\n' +
        'Math such as $\\int_0^1 x^2\\,dx = \\tfrac13$ is rendered with KaTeX.',
      'welcome.tex'
    );
  }

  function start() {
    const saved = store.get('texglass:mode');
    setMode(saved === 'edit' || saved === 'split' ? saved : 'preview');
    let lastGh = null;
    try { lastGh = JSON.parse(store.get('texglass:last-gh') || 'null'); } catch (e) { /* ignore */ }
    const loadLast = () => load(last, store.get('texglass:last-name'), null, lastGh);
    const last = store.get('texglass:last');
    // ?arxiv=2301.00001 opens that paper (a bare ?arxiv, the arXiv dialog); ?gh=<GitHub link> opens that file;
    // ?preprint=<folder> opens that manuscript from github.com/openai/math.
    const params = new URLSearchParams(location.search);
    const arxiv = params.get('arxiv');
    const gh = params.get('gh') || params.get('github');
    if (arxiv && window.TeXglassArxiv) {
      if (last) loadLast();
      return importArxiv(arxiv);
    }
    // A bare ?arxiv (the browser extension's toolbar button away from a paper)
    // opens the arXiv dialog over the last document.
    if (params.has('arxiv') && window.TeXglassArxiv) {
      const done = last ? loadLast() : loadWelcome();
      showArxivDialog();
      return done;
    }
    if (gh && window.TeXglassGitHub) {
      if (last) loadLast();
      return importGitHub(gh);
    }
    const preprint = params.get('preprint');
    if (preprint && window.TeXglassOpenAIMath) {
      if (last) loadLast();
      else loadWelcome();
      return openPreprintByFolder(preprint);
    }
    if (last) return loadLast();
    return loadWelcome();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // Keep the viewer's files and KaTeX in the browser's cache (sw.js), so the
  // site opens and renders offline after one visit. Only on a web page: the
  // arXiv extension bundles the viewer and is offline already.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
