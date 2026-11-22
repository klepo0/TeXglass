/* TeXglass viewer: opening files, live reload, in-place editing and reference previews. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const preview = $('preview');
  const previewPane = $('preview-pane');
  // Each jump (a reference, Contents, the map, Go to, the next note…) remembers
  // where you were: the Back button over the preview, or Alt+Left, goes back there.
  const viewHistory = window.TeXglassScroll && TeXglassScroll.history ? TeXglassScroll.history(previewPane, { keys: window }) : null;
  // \marginpar and \todo notes go in a margin column beside the text (src/margin.js).
  const margin = window.TeXglassMargin
    ? window.TeXglassMargin.attach({
      pane: previewPane,
      doc: preview,
      study: false, // turned on once a paper is open (notes, below)
      // the reader's highlights and notes, kept per paper (see "the reader's notes" below)
      save: (list) => notesChanged(list),
      // text pinned from the selection bar shows in the toolbar's Pinned list
      onPins: () => { try { if (pinsButton) pinsButton.refresh(); if (picker) picker.pinsChanged(); } catch (e) { /* not set up yet */ } },
      renderNote: (text) => {
        const at = doc.indexOf('\\begin{document}');
        const preamble = at >= 0 ? doc.slice(0, at) : '';
        return Promise.resolve(TeXglass.render(`${preamble}\\begin{document}\n${String(text)}\n\\end{document}`).html);
      },
      // the margin's width, once its divider was dragged (stored below)
      onWidth: (w) => store.set('texglass:margin-width', w == null ? '' : String(w)),
      // folded away with its button, or not (stored below)
      onCollapse: (on) => store.set('texglass:margin-collapsed', on ? '1' : ''),
    })
    : null;
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
  let watcher = null; // { check: async () => new source or null }: live reload of a folder or a file:// document
  let renderTimer = null;
  let saveTimer = null;
  let statusTimer = null;
  let warningsText = '';
  let lastLabels = {};
  let lastToc = [];
  let imageUrls = []; // object URLs for the figures of an imported arXiv paper
  let imageMap = null; // { path: object URL } for those figures
  let opened = { images: null, gh: null, arxiv: null }; // the open document's figures (Blobs) and where it came from, to save it for offline reading
  let insight = null; // notation on hover, notation index, dependency map (src/insight.js)
  let progress = null; // reading progress on the results (src/progress.js)
  let steps = null; // stepping through a proof (src/steps.js)
  let params = null; // sliders for texglass.sty's \tgparam (src/params.js)
  let picker = null; // "Show pinned results" (src/pick.js)
  let pinsButton = null; // the toolbar's pin: everything pinned (src/pins.js)
  let cites = null; // citation previews (src/cite.js)
  let hypotheses = null; // the hypothesis checker in previews of cited results (src/hypotheses.js)
  let sideView = null; // the side panel's tabs (TeXglassInsight.sidePanel)
  let comparing = null; // comparing with an older version: { source, blocks, urls, labels, view } (src/diff.js)

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
    remove(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };
  // Settings: which reading aids are on (src/features.js), kept in this browser.
  const Features = window.TeXglassFeatures || null;
  let features = Features ? Features.read(store) : {};
  const featureOn = (id) => !Features || Features.on(features, id);
  if (margin) {
    margin.setWidth(parseFloat(store.get('texglass:margin-width')));
    margin.setCollapsed(store.get('texglass:margin-collapsed') === '1');
  }
  // The text's width: grips on its edges (src/textwidth.js), remembered in this browser.
  const TEXT_KEY = 'texglass:text-width';
  const textWidth = window.TeXglassTextWidth
    ? window.TeXglassTextWidth.attach({
      doc: preview,
      pane: previewPane,
      store: { get: () => store.get(TEXT_KEY), set: (v) => store.set(TEXT_KEY, v) },
      avoid: [$('toc-pane')], // the side panel, a drawer over the text in a narrow window
    })
    : null;
  if (textWidth) {
    window.addEventListener('storage', (e) => {
      if (e.key === TEXT_KEY) textWidth.set(window.TeXglassTextWidth.parse(e.newValue), false);
    });
  }

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
    if (insight) insight.setDefinitions(result.defs);
    lastLabels = result.labels;
    lastToc = result.toc;
    document.title = result.title ? `${result.title} — TeXglass` : fileName.textContent && fileName.textContent !== 'welcome.tex' ? `${fileName.textContent} — TeXglass` : 'TeXglass';
    const n = result.warnings.length;
    warningsText = n ? `${n} warning${n > 1 ? 's' : ''}` : '';
    status.title = result.warnings.join('\n');
    if (!statusTimer) showStatus(warningsText, n > 0);
    const blocks = result.blocks.length ? result.blocks : ['<p class="empty-doc">This document is empty. Switch to Edit and click “Add text”.</p>'];
    showBlocks(blocks, source);
  }

  function showBlocks(blocks, source) {
    renderedDoc = source;
    if (comparing) comparing.view.clear(); // marks come off before the blocks change, and go back on below
    patchPreview(blocks);
    swapPdfFigures(); // a render that started before a PDF figure was drawn
    applyFolds();
    updateToc();
    if (margin) margin.refresh();
    reflowSoon(); // too-wide formulas on a phone break onto more lines
    if (insight) insight.invalidate(); // read the page again when next needed
    if (picker) picker.refresh(); // the same selection, on the new page
    if (progress) progress.refresh(); // status markers, once the browser is idle
    if (steps) steps.refresh(); // "Step through" buttons; a proof being stepped through carries on
    if (params) params.refresh(); // sliders by what uses a \tgparam; moved values stay
    if (cites) cites.decorate(preview); // "Open in TeXglass" on bibliography entries on arXiv
    if (comparing) markChanges(blocks, source); // comparing two versions: what changed since the older one
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
    if (tocPane.hidden || tocList.hidden || !tocLinks.length || Date.now() < tocJump) return;
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

  /**
   * PDF figures cannot be shown as they are: draw each (one at a time, with
   * pdf.js) and swap the picture in, in the preview and for later renders.
   * <html data-pdf-figures="drawing"> while that goes on.
   */
  let pdfRun = 0;
  const pdfSwaps = new Map(); // object URL of a PDF -> of its picture
  function swapPdfFigures() {
    if (!pdfSwaps.size) return;
    for (const img of preview.querySelectorAll('img.graphic')) {
      const url = pdfSwaps.get(img.getAttribute('src'));
      if (url) img.src = url;
    }
  }
  async function drawPdfFigures(images, map) {
    const run = ++pdfRun;
    pdfSwaps.clear();
    if (!window.TeXglassPdf) return;
    const pdfs = Object.entries(images).filter(([, blob]) => TeXglassPdf.isPdf(blob));
    if (!pdfs.length) return;
    const root = document.documentElement;
    root.dataset.pdfFigures = 'drawing';
    try {
      for (const [path, blob] of pdfs) {
        let image = null;
        try { image = await TeXglassPdf.toImage(blob); } catch (e) { image = null; }
        if (run !== pdfRun) return; // another document was opened meanwhile
        if (!image) continue;
        const url = URL.createObjectURL(image);
        imageUrls.push(url);
        pdfSwaps.set(map[path], url);
        map[path] = url;
        swapPdfFigures();
      }
    } finally {
      if (run === pdfRun) delete root.dataset.pdfFigures;
    }
  }

  function load(text, name, images, gh) {
    stopCompare();
    closeEditor(false);
    watcher = null;
    showFolderHint(null);
    setGitHub(gh || null);
    imageUrls.forEach((u) => URL.revokeObjectURL(u));
    imageUrls = [];
    imageMap = null;
    pdfSwaps.clear();
    pdfRun++;
    delete document.documentElement.dataset.pdfFigures;
    opened = { images: images || null, gh: gh || null, arxiv: null };
    if (images && Object.keys(images).length && window.TeXglassArxiv) {
      imageMap = {};
      for (const [path, blob] of Object.entries(images)) imageUrls.push((imageMap[path] = URL.createObjectURL(blob)));
      drawPdfFigures(images, imageMap);
    }
    doc = text.replace(/\r\n?/g, '\n');
    setSource(doc);
    fileName.textContent = name || 'untitled.tex';
    openNotes(gh && gh.path, name, doc);
    updateLibraryButton();
    setDirty(false);
    clearPreview();
    const shown = render();
    previewPane.scrollTop = 0;
    if (viewHistory) viewHistory.clear(); // a new document: nowhere to go back to
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
      if (block.classList.contains('diff-old')) continue; // an older version's block, shown while comparing
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
      if (proof.closest('.diff-old')) continue;
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
    const fpLabel = allFolded ? 'Show proofs' : 'Hide proofs';
    const fpText = fp.querySelector('.tb-label');
    if (fpText) fpText.textContent = fpLabel;
    else fp.textContent = fpLabel;
    fp.setAttribute('aria-label', fpLabel);
    fp.title = proofs === 0 ? 'This document has no proofs' : allFolded ? 'Show proofs: unfold every proof' : 'Hide proofs: fold every proof to its first line';
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
    if (copier) copier.setEnabled(m !== 'edit' && featureOn('copyMath'));
    updateStudy();
    updateProgress();
    if (steps) steps.setEnabled(featureOn('proofSteps') && m !== 'edit');
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

  const Local = window.TeXglassLocal;
  const LATEX_TYPES = [{ description: 'LaTeX', accept: { 'text/x-tex': ['.tex', '.ltx', '.latex'] } }];

  async function openWithPicker() {
    // The picker is not allowed inside an embedded frame; use the plain file input there.
    if (window.showOpenFilePicker && !inFrame) {
      try {
        const handles = await window.showOpenFilePicker({ types: LATEX_TYPES, multiple: !!Local });
        if (handles.length === 1) await openHandle(handles[0]);
        else await openFiles(await Promise.all(handles.map((h) => h.getFile())));
      } catch (e) {
        if (e.name !== 'AbortError') $('file-input').click();
      }
    } else {
      $('file-input').click();
    }
  }

  /**
   * Open a whole folder: its main .tex file with what it pulls in (\input
   * files, local packages, bibliography, figures). Chromium's folder picker
   * also lets TeXglass watch the files; elsewhere a folder <input> reads them once.
   */
  async function openFolder() {
    if (!Local) return openWithPicker();
    if (window.showDirectoryPicker && !inFrame) {
      let dir;
      try {
        dir = await window.showDirectoryPicker(fileHandle ? { startIn: fileHandle, id: 'texglass-folder' } : { id: 'texglass-folder' });
      } catch (e) {
        if (e.name === 'AbortError') return;
        $('folder-input').click();
        return;
      }
      showStatus(`Reading ${dir.name}…`);
      try {
        const { raw, handles } = await Local.readDirectoryHandle(dir);
        openRaw(raw, dir.name, handles);
      } catch (e) {
        flashStatus('Could not read the folder: ' + (e.message || e.name));
      }
    } else {
      $('folder-input').click();
    }
  }

  async function openHandle(handle) {
    fileHandle = handle;
    const file = await handle.getFile();
    lastModified = file.lastModified;
    const text = await file.text();
    load(text, file.name);
    flashStatus('Watching the file for changes');
    suggestFolder(text, file.name);
  }

  async function openFile(file) {
    fileHandle = null;
    const text = await file.text();
    load(text, file.name);
    suggestFolder(text, file.name);
  }

  /** Several files (from a picker or an input): one .tex file opens alone, more as a folder. */
  async function openFiles(files) {
    files = Array.from(files);
    const tex = files.filter((f) => /\.(tex|ltx|latex)$/i.test(f.name));
    if (files.length === 1 || !Local || (tex.length === 1 && files.length === 1)) return openFile(files[0]);
    showStatus('Reading the files…');
    openRaw(await Local.readFileList(files), files.length + ' files');
  }

  /** The file that was open on its own, when its folder is opened next: it is the main file if it is a whole document. */
  let soloName = null;

  /** Open a folder's files ({ path: bytes }); `handles` ({ path: file handle }) watches them for changes. */
  function openRaw(raw, label, handles) {
    let opened;
    try {
      let main = null;
      if (soloName) {
        // The file that was open, if it is a whole document (has \documentclass) and sits in this folder.
        const paths = Object.keys(Local.stripCommonFolder(Object.assign({}, raw)));
        const hits = paths.filter((p) => p.split('/').pop() === soloName).sort((x, y) => x.length - y.length);
        const full = Object.keys(raw).find((p) => p.endsWith(hits[0] || '\u0000'));
        if (hits[0] && full && /\\documentclass/.test(new TextDecoder().decode(raw[full]))) main = hits[0];
      }
      opened = Local.fromFolder(raw, { main });
    } catch (e) {
      flashStatus(e.message);
      return false;
    }
    fileHandle = null; // the source shown is the files put together; Save downloads it rather than overwriting the main file
    load(opened.source, opened.name, opened.images);
    soloName = null;
    const others = opened.files.length - 1;
    flashStatus(`Opened ${opened.main}` + (others > 0 ? ` from ${label}, with ${others} other file${others === 1 ? '' : 's'}` : ''));
    if (handles) watcher = folderWatcher(raw, handles);
    return true;
  }

  /** Watches the LaTeX files of a folder chosen with the folder picker. */
  function folderWatcher(raw, handles) {
    const times = {};
    const texts = Object.keys(handles).filter((p) => Local.isText(p));
    const ready = Promise.all(texts.map(async (p) => { times[p] = (await handles[p].getFile()).lastModified; }));
    return {
      async check() {
        await ready;
        let changed = false;
        for (const p of texts) {
          const f = await handles[p].getFile();
          if (f.lastModified === times[p]) continue;
          times[p] = f.lastModified;
          raw[p] = new Uint8Array(await f.arrayBuffer());
          changed = true;
        }
        return changed ? Local.fromFolder(raw).source : null;
      },
    };
  }

  /**
   * Open a file:// address, which the browser extension can read once it is
   * allowed to "access file URLs": the file and the files it pulls in, read
   * from beside it, and read again when they change.
   */
  async function openFileUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { u = null; }
    if (!u || u.protocol !== 'file:' || !Local) {
      flashStatus('Not a file on this computer: ' + url);
      return false;
    }
    const folder = new URL('.', u);
    const name = decodeURIComponent(u.pathname.split('/').pop());
    const read = async (rel) => {
      try {
        const res = await fetch(new URL(rel.split('/').map(encodeURIComponent).join('/'), folder));
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      } catch (e) {
        return null;
      }
    };
    showStatus(`Opening ${name}…`);
    const raw = await Local.gather(name, read);
    if (!raw) {
      showFileAccessHelp(name);
      return false;
    }
    let opened;
    try {
      opened = Local.fromFolder(raw, { main: name });
    } catch (e) {
      flashStatus(e.message);
      return false;
    }
    fileHandle = null;
    load(opened.source, name, opened.images);
    const others = opened.files.length - 1;
    flashStatus(others > 0 ? `Opened ${name} with ${others} other file${others === 1 ? '' : 's'} from its folder` : `Opened ${name}`);
    // Read the LaTeX files again every few seconds, and follow new \input files.
    let last = {};
    for (const p of Object.keys(raw)) if (Local.isText(p)) last[p] = new TextDecoder().decode(raw[p]);
    watcher = {
      async check() {
        let changed = false;
        for (const p of Object.keys(last)) {
          const b = await read(p);
          const t = b ? new TextDecoder().decode(b) : null;
          if (t != null && t !== last[p]) changed = true;
        }
        if (!changed) return null;
        const fresh = await Local.gather(name, read);
        if (!fresh) return null;
        last = {};
        for (const p of Object.keys(fresh)) if (Local.isText(p)) last[p] = new TextDecoder().decode(fresh[p]);
        return Local.fromFolder(fresh, { main: name }).source;
      },
    };
    return true;
  }

  // --- the bar that offers to open a lone file's folder, and other notes about opening files ---

  const folderHint = $('folder-hint');
  const folderHintText = $('folder-hint-text');
  const folderHintOpen = $('folder-hint-open');
  /** Show a note in the bar under the toolbar, with a button (null hides it). */
  function showFolderHint(text, button) {
    if (!folderHint) return;
    folderHint.hidden = !text;
    folderHintText.textContent = text || '';
    folderHintOpen.hidden = !button;
    if (button) folderHintOpen.textContent = button;
  }

  /** After a file opens on its own: if it \inputs files or shows figures, offer to open its folder. */
  function suggestFolder(text, name) {
    if (!Local) return;
    const m = Local.missing(text);
    const parts = [];
    if (m.inputs.length) parts.push(`${m.inputs.length} other file${m.inputs.length === 1 ? '' : 's'} (\\input)`);
    if (m.figures.length) parts.push(`${m.figures.length} figure${m.figures.length === 1 ? '' : 's'}`);
    if (!parts.length) return;
    soloName = name;
    showFolderHint(`${name} uses ${parts.join(' and ')} that TeXglass cannot see. Open its folder to include them.`, 'Open its folder');
  }

  /** When the extension may not read a file:// address: say how to allow it. */
  function showFileAccessHelp(name) {
    const chromium = location.protocol === 'chrome-extension:';
    showStatus(warningsText);
    showFolderHint(chromium
      ? `TeXglass could not read ${name}. To open .tex files from this computer directly, turn on "Allow access to file URLs" for TeXglass in your browser's extension settings (chrome://extensions or edge://extensions, then Details). Or choose the file here.`
      : `This browser does not let extensions read ${name} from its address. Choose the file (or its folder) here instead.`,
    'Choose the file');
    soloName = name;
    folderHintOpen.dataset.action = 'file';
  }

  if (folderHint) {
    folderHintOpen.addEventListener('click', () => {
      const action = folderHintOpen.dataset.action;
      delete folderHintOpen.dataset.action;
      showFolderHint(null);
      if (action === 'file') openWithPicker();
      else openFolder();
    });
    $('folder-hint-close').addEventListener('click', () => showFolderHint(null));
  }

  // --- opening from this computer: the dialog behind ?open (the extension's "Open a .tex file" menu item) ---

  const localDialog = $('local-dialog');
  function showLocalDialog() {
    if (!localDialog) return openWithPicker();
    $('local-file-access').hidden = location.protocol !== 'chrome-extension:';
    if (localDialog.showModal) localDialog.showModal();
    else localDialog.setAttribute('open', '');
    $('local-file').focus();
  }
  if (localDialog) {
    const closeLocal = () => (localDialog.open && localDialog.close ? localDialog.close() : localDialog.removeAttribute('open'));
    $('local-file').addEventListener('click', () => { closeLocal(); openWithPicker(); });
    $('local-folder').addEventListener('click', () => { closeLocal(); openFolder(); });
    $('local-cancel').addEventListener('click', closeLocal);
    localDialog.addEventListener('click', (e) => { if (e.target === localDialog) closeLocal(); });
  }
  for (const [id, fn] of [['arxiv-local-file', openWithPicker], ['arxiv-local-folder', openFolder]]) {
    const el = $(id);
    if (el) el.addEventListener('click', () => {
      if (arxivDialog && arxivDialog.open) arxivDialog.close();
      fn();
    });
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
   * With `tools`, the page also carries the reading tools (src/reader.js):
   * reference previews, notation on hover, the side panel, Navigate and Back.
   */
  async function exportHtml(tools) {
    if (!window.TeXglassExport) return;
    showStatus('Exporting…');
    try {
      const result = await convert(doc, imageMap);
      const isBlob = (u) => u.startsWith('blob:');
      const body = await TeXglassExport.replaceImages(TeXglassExport.joinBlocks(result.blocks), isBlob, async (u) => readAsDataUrl(await (await fetch(u)).blob()));
      const cssLink = document.querySelector('link[rel="stylesheet"][href$="styles.css"]');
      const css = cssLink ? await (await fetch(cssLink.href)).text() : '';
      const diagramsJs = /class="tg-diagram/.test(body) ? await (await fetch('src/diagrams.js')).text().catch(() => '') : '';
      let reader = null;
      if (tools === true) {
        const scripts = await Promise.all(TeXglassExport.READER_SCRIPTS.map(async (f) => {
          const res = await fetch(f);
          if (!res.ok) throw new Error('missing ' + f);
          return res.text();
        }));
        reader = { scripts, data: { defs: result.defs, toc: result.toc } };
      }
      const html = TeXglassExport.page({ body, title: result.title || fileName.textContent || 'Document', css, katexCss: await katexCssWithFonts(), diagramsJs, reader });
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

  /**
   * Download the document as an EPUB e-book (src/epub.js): formulas as MathML,
   * a chapter per section, the e-reader's contents from the sections, figures
   * inside, and diagrams drawn here first, so they show in any e-reader.
   */
  async function exportEpub() {
    if (!window.TeXglassEpub || !window.TeXglassExport) return;
    if (inFrame) {
      flashStatus('Open TeXglass in a tab of its own to export an e-book');
      return;
    }
    showStatus('Making the e-book…');
    try {
      const result = await convert(doc, imageMap);
      let body = TeXglassExport.joinBlocks(result.blocks);
      if (/class="tg-diagram/.test(body)) body = await TeXglassEpub.drawDiagrams(body, document);
      const link = document.querySelector('link[rel="stylesheet"][href*="katex"]');
      const katexCss = link ? await fetch(link.href).then((r) => (r.ok ? r.text() : null), () => null) : null;
      const title = result.title || fileName.textContent || 'Document';
      const { bytes, warnings } = await TeXglassEpub.build({
        body,
        title,
        toc: result.toc,
        katexCss,
        diagramsDrawn: true,
        readFont: async (name) => {
          const r = await fetch(new URL('fonts/' + name, link.href));
          return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
        },
        readImage: async (src) => {
          const blob = await (await fetch(src)).blob();
          return { data: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
        },
      });
      const name = TeXglassEpub.fileName(fileName.textContent, result.title);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/epub+zip' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      for (const w of warnings) console.warn('TeXglass EPUB: ' + w);
      const left = warnings.filter((w) => w.startsWith('Left out a figure')).length;
      flashStatus(`Exported ${name}${left ? ` (${left} figure${left === 1 ? '' : 's'} left out)` : ''}`);
    } catch (e) {
      flashStatus('Could not export: ' + (e.message || e));
    }
  }

  // Re-render when the file changes on disk (browsers with the File System Access API),
  // unless there are edits made here that would be lost.
  const reshow = (text) => {
    closeEditor(false);
    doc = text.replace(/\r\n?/g, '\n');
    setSource(doc);
    render();
    store.set('texglass:last', doc);
  };
  setInterval(async () => {
    if (!fileHandle || document.hidden || dirty) return;
    try {
      const file = await fileHandle.getFile();
      if (file.lastModified !== lastModified) {
        lastModified = file.lastModified;
        reshow(await file.text());
      }
    } catch (e) {
      fileHandle = null;
    }
  }, 1000);

  // The same for a folder, or a file:// document and the files it pulls in.
  let checking = false;
  setInterval(async () => {
    if (!watcher || checking || document.hidden || dirty) return;
    checking = true;
    const w = watcher;
    try {
      const text = await w.check();
      if (text != null && w === watcher && text.replace(/\r\n?/g, '\n') !== doc) reshow(text);
    } catch (e) {
      if (w === watcher) watcher = null;
    } finally {
      checking = false;
    }
  }, 1500);

  // Open: the Open dialog (arXiv, GitHub, or this computer); Shift+click opens a folder.
  $('open').addEventListener('click', (e) => (e.shiftKey ? openFolder() : showArxivDialog()));
  $('save').addEventListener('click', save);
  $('export').addEventListener('click', () => exportHtml(false));
  if ($('export-reader')) $('export-reader').addEventListener('click', () => exportHtml(true));
  if ($('export-epub')) $('export-epub').addEventListener('click', exportEpub);
  if ($('ai-prompt')) $('ai-prompt').addEventListener('click', copyAiPrompt);

  /**
   * "Copy AI prompt for authors": the prompt in latex/AI-PROMPT.md, which asks
   * a chatbot for texglass.sty hints for the author's .tex file. If it can't
   * be read or copied, the page with the prompt opens instead.
   */
  async function copyAiPrompt() {
    try {
      const md = await (await fetch('latex/AI-PROMPT.md')).text();
      const m = /<!-- ai-prompt:start -->\s*````text\n([\s\S]*?)\n````/.exec(md);
      if (!m) throw new Error('no prompt in latex/AI-PROMPT.md');
      await navigator.clipboard.writeText(m[1] + '\n');
      flashStatus('AI prompt copied: paste it into a chatbot, with your .tex file');
    } catch (e) {
      window.open('https://github.com/klepo0/TeXglass/blob/main/latex/AI-PROMPT.md#the-prompt', '_blank', 'noopener');
    }
  }

  // --- the "…" menu: Save, Export, Print ---------------------------------------
  const moreBtn = $('more');
  const moreMenu = $('more-menu');
  const menuItems = () => [...moreMenu.querySelectorAll('[role^="menuitem"]')].filter((b) => !b.hidden && !b.disabled && b.getClientRects().length);
  function setMenu(open, focusFirst) {
    moreMenu.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open && focusFirst) menuItems()[0].focus();
  }
  moreBtn.addEventListener('click', () => setMenu(moreMenu.hidden, false));
  moreBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setMenu(true, true); }
  });
  // Choosing an item closes the menu first (its own listener above does the work).
  moreMenu.addEventListener('click', (e) => { if (e.target.closest('[role^="menuitem"]')) setMenu(false); });
  moreMenu.addEventListener('keydown', (e) => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setMenu(false);
      moreBtn.focus();
    } else if (e.key === 'Tab') {
      setMenu(false);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!moreMenu.hidden && !e.target.closest('.more-group')) setMenu(false);
  });

  // --- phones and tablets ---------------------------------------------------------
  // A narrow window keeps a few large buttons in the toolbar (Open, Contents,
  // Navigate, Save for offline, Share, the theme, "…"); the others, Settings and the handwritten look too, move to the top of the "…" menu and back
  // again when the window widens. The side panel and the margin notes become
  // drawers: their buttons open them, and so does a swipe in from the edge of the
  // screen (src/touch.js); a swipe back, a tap outside or Escape closes them.
  const compact = $('more-compact');
  const COMPACT_MOVES = ['.mode-switch', '.zoom-group', '#fold-proofs', '#pins', '#gh-link', '#settings', '#hand-toggle']
    .map((sel) => document.querySelector('.toolbar ' + sel))
    .filter(Boolean)
    .map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
  function setCompact(on) {
    if (on) {
      for (const m of COMPACT_MOVES) compact.appendChild(m.el);
    } else {
      for (const m of COMPACT_MOVES.slice().reverse()) m.parent.insertBefore(m.el, m.next && m.next.parentNode === m.parent ? m.next : null);
    }
    compact.hidden = !on || !COMPACT_MOVES.some((m) => !m.el.hidden);
    document.body.classList.toggle('compact', on);
  }
  // in the menu, those buttons close it once used (zooming keeps it open, to zoom again)
  compact.addEventListener('click', (e) => {
    const b = e.target.closest('button, a');
    if (b && !b.closest('.zoom-group')) setMenu(false);
  });

  function setNarrow(on) {
    setCompact(on);
    if (margin && margin.setOverlay) margin.setOverlay(on);
    if (on && tocWanted) { tocWanted = false; showToc(); }
    if (!on) { tocWanted = store.get('texglass:toc') !== 'off'; showToc(); }
    reflowMath();
  }
  if (window.TeXglassTouch) {
    const tocEdge = () => (document.body.classList.contains('toc-right') ? 'right' : 'left');
    TeXglassTouch.edgeSwipe(window, {
      enabled: () => narrow.matches && mode !== 'split' && !document.querySelector('dialog[open]'),
      onSwipe: (edge) => {
        if (edge === tocEdge()) {
          if (!tocToggle.hidden && !tocWanted) { tocWanted = true; showToc(); spyToc(); }
        } else if (edge === 'right' && margin && margin.shown()) {
          margin.open(true);
        }
      },
    });
    TeXglassTouch.swipeAway(tocPane, {
      edge: tocEdge,
      enabled: () => narrow.matches && tocWanted,
      onSwipe: () => { tocWanted = false; showToc(); },
    });
  }

  // A display formula too wide for a narrow or touch screen breaks after its relations and
  // operators, as inline maths does (the stylesheet, .tg-reflow), instead of
  // scrolling sideways. Ones that cannot break (a matrix, an alignment) still scroll.
  const coarse = window.matchMedia('(pointer: coarse)');
  function reflowMath() {
    const on = narrow.matches || coarse.matches; // a phone, or a tablet: scrolling a formula sideways is awkward there
    preview.querySelectorAll('.math-display').forEach((el) => {
      const html = el.querySelector(':scope > .katex-display > .katex > .katex-html');
      if (!on || !html || html.querySelectorAll(':scope > .base').length < 2) { el.classList.remove('tg-reflow'); return; }
      if (el.classList.contains('tg-reflow')) return;
      if (el.scrollWidth > el.clientWidth + 1) el.classList.add('tg-reflow');
    });
  }
  let reflowFrame = 0;
  const reflowSoon = () => { if (!reflowFrame) reflowFrame = requestAnimationFrame(() => { reflowFrame = 0; reflowMath(); }); };
  window.addEventListener('resize', () => {
    // wider again: let every formula try one line first
    preview.querySelectorAll('.math-display.tg-reflow').forEach((el) => el.classList.remove('tg-reflow'));
    reflowSoon();
  });

  setNarrow(narrow.matches);
  narrow.addEventListener('change', (e) => setNarrow(e.matches));

  // Install as an app (Chrome, Edge, Android): offered in the "…" menu when the
  // browser says it can be. Safari: Share, then Add to Home Screen.
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('install').hidden = false;
    $('install-sep').hidden = false;
  });
  $('install').addEventListener('click', () => {
    if (!installPrompt) return;
    const p = installPrompt;
    installPrompt = null;
    p.prompt();
    Promise.resolve(p.userChoice).finally(() => { $('install').hidden = true; $('install-sep').hidden = true; });
  });
  window.addEventListener('appinstalled', () => { $('install').hidden = true; $('install-sep').hidden = true; });

  // --- the reader's highlights and notes ---------------------------------------
  // Highlights and notes made on the preview (src/margin.js) are kept per paper
  // in this browser (localStorage, texglass:notes:<paper key>); see
  // src/notes-sync.js for the key and the file. They can be exported to a file
  // and imported again, and synced between devices: through the browser's own
  // sync in the browser extension, and through a private GitHub gist with the
  // reader's own token wherever they sign in. Copies are merged by note id.
  const NotesSync = window.TeXglassNotesSync;
  const NOTES = 'texglass:notes:';
  const extApi = (() => {
    try {
      const api = (typeof browser !== 'undefined' && browser) || (typeof chrome !== 'undefined' && chrome) || null;
      return api && api.storage && api.storage.sync && api.runtime && api.runtime.id ? api : null;
    } catch (e) {
      return null;
    }
  })();
  const EXT_ITEM_MAX = 8000; // chrome.storage.sync keeps at most 8 KB per item
  let paper = null; // { key, record } for the open document's notes
  let notesSyncing = Promise.resolve();
  let notesPushTimer = null;

  function readNotes(key) {
    try {
      const r = JSON.parse(store.get(NOTES + key) || 'null');
      if (r && Array.isArray(r.notes)) return Object.assign(NotesSync.empty(key), r, { paper: key });
    } catch (e) { /* not a record */ }
    return null;
  }
  function writeNotes(key, record) {
    if (NotesSync.isEmpty(record)) store.remove(NOTES + key);
    else store.set(NOTES + key, JSON.stringify(record));
  }
  /** Every paper with notes in this browser: { key: record }. */
  function allNotes() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(NOTES)) {
          const r = readNotes(k.slice(NOTES.length));
          if (r) out[k.slice(NOTES.length)] = r;
        }
      }
    } catch (e) { /* storage unavailable */ }
    return out;
  }

  const studyOn = () => featureOn('notes');
  function updateStudy() {
    const on = !!(margin && NotesSync && paper && studyOn() && mode !== 'edit');
    if (margin) margin.setStudy(on);
    const item = $('notes-toggle');
    if (item) item.setAttribute('aria-checked', String(studyOn()));
    for (const id of ['notes-export', 'notes-import']) if ($(id)) $(id).disabled = !paper;
  }

  /** Show the notes of the document just opened (`ghPath`: where on GitHub it came from). */
  function openNotes(ghPath, name, source) {
    if (!margin || !NotesSync) return;
    clearTimeout(notesPushTimer);
    const key = NotesSync.paperKey({ github: ghPath, name, source });
    paper = key ? { key, record: readNotes(key) || NotesSync.empty(key, NotesSync.titleOf(source)) } : null;
    if (paper) showNotes();
    else margin.setAnnotations([]);
    updateStudy();
    updateProgress();
    if (insight) insight.refreshEdits();
    if (paper) syncNotes(true);
  }

  /** Put the open paper's notes in the margin. */
  function showNotes() {
    paper.shown = new Set(paper.record.notes.map((a) => a.id));
    margin.setAnnotations(paper.record.notes);
  }

  /** The reader changed the notes (margin.js). */
  function notesChanged(list) {
    if (!paper) return;
    // Notes that came in while one was being written are not in the margin yet: keep them.
    const waiting = paper.record.notes.filter((a) => !paper.shown.has(a.id) && !list.some((b) => b.id === a.id));
    paper.record = Object.assign(NotesSync.track(paper.record, list.concat(waiting)), { paper: paper.key });
    paper.shown = new Set(list.map((a) => a.id));
    writeNotes(paper.key, paper.record);
    clearTimeout(notesPushTimer);
    notesPushTimer = setTimeout(() => syncNotes(true), 2500);
  }

  /** Bring in notes from elsewhere (another tab, device or file) for the open paper. */
  function takeNotes(record) {
    if (!paper || !record) return;
    const merged = NotesSync.merge(paper.record, record);
    if (NotesSync.equal(merged, paper.record)) return;
    paper.record = merged;
    writeNotes(paper.key, merged);
    if (progress) progress.setMap(merged.progress);
    if (insight) insight.refreshEdits();
    // Not while a note is being written: try again a little later.
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.tg-mcard-input');
    if (typing) setTimeout(() => paper && showNotes(), 4000);
    else showNotes();
  }

  // The browser extension: the browser's own sync, one item per paper.
  async function extSync(key, record) {
    if (!extApi) return record;
    const item = 'notes:' + key;
    try {
      const got = (await extApi.storage.sync.get(item))[item];
      const merged = NotesSync.merge(record, got ? Object.assign({}, got, { paper: key }) : null);
      const slim = { notes: merged.notes, deleted: merged.deleted, progress: merged.progress, map: merged.map };
      if (!got || !NotesSync.equal(merged, Object.assign(NotesSync.empty(key), got))) {
        if (JSON.stringify(slim).length + item.length < EXT_ITEM_MAX) await extApi.storage.sync.set({ [item]: slim });
      }
      return merged;
    } catch (e) {
      return record; // over the quota, or sync off: the notes stay in this browser
    }
  }
  if (extApi && extApi.storage.onChanged) {
    extApi.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !paper) return;
      const c = changes['notes:' + paper.key];
      if (c && c.newValue) takeNotes(Object.assign(NotesSync.empty(paper.key), c.newValue));
    });
  }
  window.addEventListener('storage', (e) => {
    if (paper && e.key === NOTES + paper.key) takeNotes(readNotes(paper.key));
  });

  const gistToken = () => store.get('texglass:gist-token') || '';
  function gistClient() {
    return NotesSync.gist(gistToken(), { gistId: store.get('texglass:gist-id') || null });
  }

  /**
   * Sync the open paper's notes (or, with all, every paper's) with the browser's
   * sync and the gist. Quiet: say nothing unless something went wrong.
   */
  function syncNotes(quiet, all) {
    const run = async () => {
      if (!NotesSync) return;
      if (!all && !paper) return;
      const key = paper && paper.key;
      let rec = paper && paper.record;
      if (key) rec = await extSync(key, rec);
      if (gistToken() && navigator.onLine !== false) {
        try {
          const g = gistClient();
          if (all) {
            const local = allNotes();
            if (key) local[key] = rec;
            const merged = await g.sync(null, local);
            for (const [k, r] of Object.entries(merged)) if (k !== key) writeNotes(k, Object.assign(NotesSync.empty(k), readNotes(k), r));
            if (key) rec = merged[key];
            if (!quiet) flashStatus(`Notes synced with GitHub (${Object.keys(merged).length} paper${Object.keys(merged).length === 1 ? '' : 's'})`);
          } else {
            rec = await g.sync(key, rec);
            if (!quiet) flashStatus('Notes synced with GitHub');
          }
          if (g.id()) store.set('texglass:gist-id', g.id());
          store.set('texglass:gist-error', '');
          store.set('texglass:gist-synced', new Date().toISOString());
        } catch (e) {
          store.set('texglass:gist-error', e.message);
          if (!quiet || e.auth) flashStatus('Notes not synced: ' + e.message);
        }
        updateSyncMenu();
      } else if (!quiet) {
        flashStatus(gistToken() ? 'Offline: notes will sync later' : 'Notes saved in this browser');
      }
      if (paper && paper.key === key) takeNotes(rec);
    };
    notesSyncing = notesSyncing.then(run, run);
    return notesSyncing;
  }
  window.addEventListener('online', () => { if (paper && gistToken()) syncNotes(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && paper && gistToken()) syncNotes(true);
  });

  function exportNotes() {
    if (!paper) return;
    const base = (fileName.textContent || 'paper.tex').replace(/\.(tex|ltx|latex)$/i, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([NotesSync.toFile(paper.record)], { type: 'application/json' }));
    a.download = `${base}.texglass.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    flashStatus(`Exported ${paper.record.notes.length} note${paper.record.notes.length === 1 ? '' : 's'}`);
  }

  async function importNotes(file) {
    if (!file || !paper) return;
    let papers;
    try {
      papers = NotesSync.parseFile(await file.text(), paper.key);
    } catch (e) {
      flashStatus('Could not import: ' + (e instanceof SyntaxError ? 'not a notes file' : e.message));
      return;
    }
    if (window.TeXglassLibrary) delete papers[TeXglassLibrary.LIST_KEY]; // the saved-papers list in a gist's file
    const keys = Object.keys(papers);
    // One paper's file goes on the open paper (its notes find their text again);
    // a file of many papers (the gist's) fills in each of them.
    const mine = keys.length === 1 ? papers[keys[0]] : papers[paper.key];
    for (const k of keys) {
      if (k === paper.key || keys.length === 1) continue;
      writeNotes(k, NotesSync.merge(readNotes(k) || NotesSync.empty(k), Object.assign({}, papers[k], { paper: k })));
    }
    const before = paper.record.notes.length;
    if (mine) {
      takeNotes(Object.assign({}, mine, { paper: paper.key }));
      // keep the paper's own key, and push the imported notes on
      notesChanged(paper.record.notes);
    }
    const added = paper.record.notes.length - before;
    flashStatus(keys.length > 1
      ? `Imported notes for ${keys.length} papers${mine ? `, ${added} new here` : ''}`
      : `Imported ${added} new note${added === 1 ? '' : 's'}`);
  }

  // The "Sync notes" dialog: a GitHub token that may use gists, kept in this browser only.
  // Once it is given, syncing is automatic (on opening a paper, a moment after each
  // change, on coming back to the tab), and the dialog and menu say so: "Sync now"
  // is only a quiet extra.
  const syncDialog = $('notes-sync-dialog');
  /** "just now", "5 min ago", "3 h ago", or the date. */
  function syncedAgo(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return 'on ' + new Date(t).toLocaleDateString();
  }
  /** One line on the state of GitHub sync, or '' when not signed in. */
  function syncStateLine() {
    if (!gistToken()) return '';
    const err = store.get('texglass:gist-error');
    if (err) return 'Syncing automatically · last try failed: ' + err;
    const ago = syncedAgo(store.get('texglass:gist-synced'));
    return 'Syncing automatically' + (ago ? ' · last synced ' + ago : '');
  }
  /** The … menu item reads "Syncing with GitHub" once signed in, its tooltip the state line. */
  function updateSyncMenu() {
    const item = $('notes-sync');
    if (!item) return;
    const on = !!gistToken();
    item.textContent = on ? 'Syncing with GitHub…' : 'Sync notes with GitHub…';
    if (on) {
      const hint = document.createElement('span');
      hint.className = 'more-hint';
      hint.textContent = 'automatic';
      item.appendChild(hint);
    }
    item.title = on
      ? syncStateLine() + '. Notes and saved papers sync on their own; click for details or to sign out'
      : 'Keep your highlights and notes in step on all your devices, through a private gist on your GitHub account. Sign in once; after that it is automatic';
  }
  function renderSyncDialog(note) {
    const on = !!gistToken();
    const err = store.get('texglass:gist-error');
    $('notes-sync-title').textContent = on ? 'Syncing with GitHub' : 'Sync notes with GitHub';
    const state = $('notes-sync-state');
    state.hidden = !on;
    state.textContent = syncStateLine();
    state.classList.toggle('failed', !!(on && err));
    $('notes-sync-about').innerHTML = on
      ? 'Your highlights, notes, reading progress and list of saved papers sync <strong>on their own</strong> with the private gist <code>texglass-notes.json</code> in your GitHub account: when you open a paper, a few seconds after each change, and when you come back to this tab. There is nothing more to do here.'
      : 'Your highlights, notes, reading progress and list of saved papers go to a private gist, <code>texglass-notes.json</code>, in your own GitHub account, and come back on every device where you sign in. Nothing passes through any other server. Notes made on two devices at once are merged. <strong>You sign in once</strong>: after that everything syncs automatically.';
    $('notes-sync-token-box').hidden = on;
    $('notes-sync-token').value = '';
    $('notes-sync-token').placeholder = 'ghp_… or github_pat_…';
    $('notes-sync-signout').hidden = !on;
    $('notes-sync-replace').hidden = !on;
    $('notes-sync-now').hidden = !on;
    $('notes-sync-cancel').hidden = on;
    $('notes-sync-go').textContent = on ? 'Done' : 'Sign in';
    $('notes-sync-message').textContent = note || '';
  }
  function showSyncDialog() {
    if (!syncDialog) return;
    renderSyncDialog();
    syncDialog.showModal();
  }
  /** Sync everything now (notes of every paper, the saved list); '' or the error. */
  async function syncAll() {
    if (navigator.onLine === false) return 'you are offline; it will sync once you are back online';
    await syncNotes(true, true);
    await syncLibrary();
    updateSyncMenu();
    return store.get('texglass:gist-error') || '';
  }
  if (syncDialog) {
    $('notes-sync-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fresh = $('notes-sync-token').value.trim();
      if (!fresh) {
        if (gistToken()) syncDialog.close(); // Done
        else $('notes-sync-message').textContent = 'Paste a token first.';
        return;
      }
      const had = gistToken();
      store.set('texglass:gist-token', fresh);
      store.remove('texglass:gist-id');
      store.set('texglass:gist-error', '');
      $('notes-sync-message').textContent = 'Signing in and syncing…';
      $('notes-sync-go').disabled = true;
      const err = await syncAll();
      $('notes-sync-go').disabled = false;
      if (err) {
        if (had) store.set('texglass:gist-token', had);
        else store.remove('texglass:gist-token');
        store.set('texglass:gist-error', '');
        updateSyncMenu();
        $('notes-sync-message').textContent = 'Could not sync: ' + err;
        return;
      }
      // Stay open a moment to say the one thing readers miss: it is automatic from now on.
      renderSyncDialog('Signed in. You won’t need to come back here: syncing just happens.');
      flashStatus('Signed in to GitHub: notes now sync automatically');
    });
    $('notes-sync-cancel').addEventListener('click', () => syncDialog.close());
    $('notes-sync-replace').addEventListener('click', () => {
      $('notes-sync-token-box').hidden = false;
      $('notes-sync-replace').hidden = true;
      $('notes-sync-go').textContent = 'Use this token';
      $('notes-sync-token').focus();
    });
    $('notes-sync-now').addEventListener('click', async () => {
      $('notes-sync-now').disabled = true;
      $('notes-sync-message').textContent = 'Syncing…';
      const err = await syncAll();
      $('notes-sync-now').disabled = false;
      renderSyncDialog(err ? 'Could not sync: ' + err : 'Up to date.');
    });
    $('notes-sync-signout').addEventListener('click', () => {
      store.remove('texglass:gist-token');
      store.remove('texglass:gist-id');
      store.remove('texglass:gist-error');
      store.remove('texglass:gist-synced');
      syncDialog.close();
      updateSyncMenu();
      flashStatus('Signed out. Notes stay in this browser.');
    });
  }
  updateSyncMenu();
  if ($('more')) $('more').addEventListener('click', updateSyncMenu); // keep "last synced" fresh

  if ($('notes-toggle')) {
    $('notes-toggle').addEventListener('click', () => {
      setFeature('notes', !studyOn());
    });
    $('notes-export').addEventListener('click', exportNotes);
    $('notes-import').addEventListener('click', () => $('notes-file').click());
    $('notes-file').addEventListener('change', (e) => {
      importNotes(e.target.files[0]);
      e.target.value = '';
    });
    $('notes-sync').addEventListener('click', showSyncDialog);
  }
  if (!NotesSync || !margin) for (const id of ['notes-toggle', 'notes-export', 'notes-import', 'notes-sync']) if ($(id)) $(id).hidden = true;

  // --- saved papers, for offline reading ----------------------------------------------
  // "Save for offline" keeps the open paper whole on this device (IndexedDB, see
  // src/library.js): source, figures and where it came from. "Saved papers…" lists
  // them; they open with no connection, and an arXiv paper asked for offline (or
  // when arXiv can't be reached) opens from its saved copy. The list itself (not
  // the papers) syncs through the notes gist when the reader signed in there.
  const Library = window.TeXglassLibrary;
  const LIBRARY_LIST = 'texglass:library';
  const libraryDb = Library ? Library.open().catch(() => null) : Promise.resolve(null);
  const libraryHere = new Set(); // keys of the papers saved on this device
  let librarySyncing = false;

  function libraryKeyOf(arxivId) {
    return NotesSync ? NotesSync.paperKey({ arxiv: arxivId }) : null;
  }
  function readLibraryList() {
    try {
      const r = JSON.parse(store.get(LIBRARY_LIST) || 'null');
      if (r && Array.isArray(r.notes)) return Object.assign(Library.emptyList(), r);
    } catch (e) { /* not a list */ }
    return Library.emptyList();
  }
  function writeLibraryList(list) {
    store.set(LIBRARY_LIST, JSON.stringify(list));
  }

  function updateLibraryButton() {
    updateShareButton();
    const btn = $('library-save');
    if (!btn) return;
    const saved = !!(paper && libraryHere.has(paper.key));
    btn.setAttribute('aria-checked', String(saved));
    btn.textContent = saved ? 'Saved for offline' : 'Save for offline';
    btn.title = saved
      ? 'This paper is kept on this device and opens with no connection. Click to remove it'
      : 'Keep this paper on this device, figures and all, to read it with no connection';
    btn.disabled = !paper;
    const tb = $('save-offline');
    if (tb) {
      tb.setAttribute('aria-pressed', String(saved));
      tb.disabled = !paper;
      tb.title = btn.title;
      tb.setAttribute('aria-label', saved ? 'Saved for offline' : 'Save for offline');
      tb.querySelector('.tb-label').textContent = saved ? 'Saved offline' : 'Save offline';
    }
    if (saved && store.get('texglass:last-saved') !== paper.key) markOpened(paper.key);
    store.set('texglass:last-saved', saved ? paper.key : '');
  }

  /** The open paper as a record to keep. */
  function savedRecord() {
    const title = Library.plainTitle(NotesSync.titleOf(doc)) || fileName.title || (fileName.textContent || '').replace(/\.(tex|ltx|latex)$/i, '');
    const arxiv = opened.arxiv || (paper.key.startsWith('arxiv:') ? paper.key.slice(6) : null);
    return { key: paper.key, title, name: fileName.textContent, nameTitle: fileName.title || '', source: doc, images: opened.images || {}, arxiv, gh: opened.gh, saved: new Date().toISOString() };
  }
  /** What the synced list keeps of a saved paper. */
  const listInfo = (rec) => ({ key: rec.key, title: rec.title, arxiv: rec.arxiv, gh: rec.gh && rec.gh.links && rec.gh.links.view });

  async function saveForOffline() {
    const db = await libraryDb;
    if (!db || !paper) {
      flashStatus('This browser cannot keep papers for offline reading here (a private window?)');
      return;
    }
    const key = paper.key;
    if (libraryHere.has(key)) {
      await db.remove(key);
      libraryHere.delete(key);
      writeLibraryList(Library.removeEntry(readLibraryList(), key));
      updateLibraryButton();
      flashStatus('Removed from your saved papers');
      syncLibrary();
      return;
    }
    const rec = savedRecord();
    try {
      await db.put(rec);
    } catch (e) {
      flashStatus('Could not save: ' + (e.message || 'the device may be out of space'));
      return;
    }
    libraryHere.add(key);
    writeLibraryList(Library.addEntry(readLibraryList(), listInfo(rec)));
    updateLibraryButton();
    // ask the browser not to clear saved papers when it runs short of space
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* not offered */ }
    flashStatus(`Saved for offline reading (${Library.formatSize(Library.sizeOf(rec))})`);
    syncLibrary();
  }

  /** Open a saved paper from this device. */
  function openSaved(rec, quiet) {
    fileHandle = null;
    markOpened(rec.key);
    const shown = load(rec.source, rec.name, rec.images, rec.gh || null);
    opened.arxiv = rec.arxiv || null;
    if (rec.nameTitle) fileName.title = rec.nameTitle;
    updateLibraryButton();
    if (!quiet) flashStatus(navigator.onLine === false ? 'Offline: opened your saved copy' : 'Opened your saved copy');
    return shown;
  }
  /** Open the saved paper with this key, if there is one. opts.quiet: no status; opts.source: only if its source is this. */
  async function openSavedKey(key, opts) {
    const o = opts || {};
    if (!key) return false;
    const db = await libraryDb;
    const rec = db && await db.get(key).catch(() => null);
    if (!rec || (o.source != null && rec.source !== o.source)) return false;
    await openSaved(rec, o.quiet);
    return true;
  }

  /** Merge the saved list with the notes gist (if signed in there). Quiet. */
  function syncLibrary() {
    if (!Library || !NotesSync || !gistToken() || navigator.onLine === false || librarySyncing) return notesSyncing;
    const run = async () => {
      librarySyncing = true;
      try {
        const g = gistClient();
        const merged = await g.sync(Library.LIST_KEY, readLibraryList());
        if (g.id()) store.set('texglass:gist-id', g.id());
        if (merged) writeLibraryList(Object.assign(Library.emptyList(), merged));
        store.set('texglass:gist-synced', new Date().toISOString());
        if (libraryDialog && libraryDialog.open) renderLibrary();
        if (arxivDialog.open) renderRecentSaved();
      } catch (e) {
        /* the notes' own sync reports problems with the gist */
      } finally {
        librarySyncing = false;
      }
    };
    notesSyncing = notesSyncing.then(run, run);
    return notesSyncing;
  }

  // The dialog listing the saved papers.
  const libraryDialog = $('library-dialog');
  let libraryFilter = '';
  function librarySay(text, warn) {
    $('library-message').textContent = text;
    $('library-message').classList.toggle('warn', !!warn);
  }
  // When each saved paper was last opened here, so the Open dialog lists the recent ones first.
  const LIBRARY_OPENED = 'texglass:library-opened';
  function openedTimes() {
    try { return JSON.parse(store.get(LIBRARY_OPENED) || '{}') || {}; } catch (e) { return {}; }
  }
  function markOpened(key) {
    const t = openedTimes();
    t[key] = new Date().toISOString();
    // keep the 200 most recent
    const keep = Object.entries(t).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 200);
    store.set(LIBRARY_OPENED, JSON.stringify(Object.fromEntries(keep)));
  }

  /**
   * Every saved paper: those on this device, then those saved on other devices
   * (from the synced list); most recently saved first. `here`: the records on this device.
   */
  async function libraryRows() {
    const db = await libraryDb;
    const here = db ? await db.all().catch(() => []) : [];
    libraryHere.clear();
    for (const r of here) libraryHere.add(r.key);
    const rows = here.map((r) => ({ key: r.key, title: r.title, arxiv: r.arxiv, gh: r.gh && r.gh.links && r.gh.links.view, saved: r.saved, bytes: r.bytes, here: true }));
    for (const e of Library.entries(readLibraryList())) if (!libraryHere.has(e.key)) rows.push(Object.assign({}, e, { here: false }));
    rows.sort((a, b) => (Date.parse(b.saved) || 0) - (Date.parse(a.saved) || 0));
    return { rows, here };
  }
  const whereOf = (r) => (r.arxiv ? 'arXiv:' + r.arxiv : r.key.startsWith('github:') ? r.key.slice(7) : r.key.replace(/^tex:/, '').replace(/#.*/, ''));

  /** The Open dialog's short list: the 5 saved papers saved or opened most recently. */
  async function renderRecentSaved() {
    const box = $('library-recent');
    if (!box || !Library) return;
    const { rows } = await libraryRows();
    const opened = openedTimes();
    const last = (r) => Math.max(Date.parse(r.saved) || 0, Date.parse(opened[r.key]) || 0);
    const recent = rows.slice().sort((a, b) => last(b) - last(a)).slice(0, 5);
    const ol = $('library-recent-list');
    ol.textContent = '';
    for (const r of recent) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'library-recent-open' + (r.here ? '' : ' library-elsewhere');
      b.dataset.key = r.key;
      const meta = r.here ? whereOf(r) : whereOf(r) + ' · on another device';
      b.innerHTML = `<span class="library-recent-title">${mathText(r.title || whereOf(r))}</span><span class="arxiv-result-meta">${mathText(meta)}</span>`;
      b.title = r.here ? 'Open this saved paper (offline too)' : 'Download this paper and keep it on this device too';
      if (!r.here && !(r.arxiv || r.gh)) b.disabled = true;
      b.addEventListener('click', () => openFromLibrary(r));
      li.appendChild(b);
      ol.appendChild(li);
    }
    $('arxiv-library').textContent = rows.length > recent.length ? `All saved papers (${rows.length})` : 'All saved papers';
    box.hidden = !rows.length;
  }

  async function renderLibrary() {
    const { rows, here } = await libraryRows();
    const q = libraryFilter.trim().toLowerCase();
    const shown = q ? rows.filter((r) => `${r.title} ${r.arxiv || ''} ${r.key}`.toLowerCase().includes(q)) : rows;
    $('library-filters').hidden = rows.length < 7;
    const ol = $('library-list');
    ol.textContent = '';
    const fmtDate = (t) => { try { return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } };
    for (const r of shown) {
      const li = document.createElement('li');
      li.className = 'preprint library-item' + (r.here ? '' : ' library-elsewhere');
      li.dataset.key = r.key;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'preprint-open';
      const where = whereOf(r);
      const meta = r.here
        ? [where, Library.formatSize(r.bytes || 0), r.saved && 'saved ' + fmtDate(r.saved)]
        : [where, 'saved on another device'];
      open.innerHTML = `<span class="preprint-title">${mathText(r.title || where)}</span><span class="arxiv-result-meta">${mathText(meta.filter(Boolean).join(' · '))}</span>`;
      const canGet = !r.here && (r.arxiv || r.gh);
      if (!r.here && !canGet) open.disabled = true;
      open.title = r.here ? 'Open this paper (offline too)' : canGet ? 'Download this paper and keep it on this device too' : 'Only on the device where it was saved';
      open.addEventListener('click', () => openFromLibrary(r));
      li.appendChild(open);
      if (!r.here && canGet) {
        const get = document.createElement('button');
        get.type = 'button';
        get.className = 'library-action library-download';
        get.textContent = 'Download';
        get.title = open.title;
        get.addEventListener('click', () => openFromLibrary(r));
        li.appendChild(get);
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'library-action library-remove';
      rm.textContent = 'Remove';
      rm.title = r.here ? 'Remove it from this device and from your list' : 'Remove it from your list';
      rm.addEventListener('click', () => removeFromLibrary(r.key));
      li.appendChild(rm);
      ol.appendChild(li);
    }
    if (!rows.length) librarySay('No saved papers yet.');
    else if (!shown.length) librarySay('No saved paper matches.');
    else librarySay('');
    let foot = rows.length ? `${here.length} paper${here.length === 1 ? '' : 's'} on this device, ${Library.formatSize(here.reduce((n, r) => n + (r.bytes || 0), 0))}.` : '';
    if (rows.length && gistToken()) foot += ' The list syncs automatically with your notes on GitHub.';
    else if (rows.length && NotesSync) foot += ' Sign in under Sync notes with GitHub to see this list on your other devices.';
    $('library-foot').textContent = foot;
    updateLibraryButton();
  }

  async function openFromLibrary(r) {
    if (r.here) {
      libraryDialog.close();
      if (arxivDialog.open) arxivDialog.close();
      await openSavedKey(r.key);
      return;
    }
    if (navigator.onLine === false) {
      librarySay('Downloading needs a connection. It will stay on your list.', true);
      return;
    }
    librarySay('Downloading…');
    const ok = r.arxiv ? await importArxiv(r.arxiv) : await importGitHub(r.gh);
    if (!ok || !paper) {
      librarySay('Could not download it. Try again when you are online.', true);
      return;
    }
    libraryDialog.close();
    if (!libraryHere.has(paper.key)) await saveForOffline();
  }

  async function removeFromLibrary(key) {
    const db = await libraryDb;
    if (db) await db.remove(key).catch(() => {});
    libraryHere.delete(key);
    writeLibraryList(Library.removeEntry(readLibraryList(), key));
    await renderLibrary();
    syncLibrary();
  }

  function showLibrary() {
    if (!libraryDialog) return;
    if (arxivDialog.open) arxivDialog.close();
    libraryFilter = $('library-search').value = '';
    renderLibrary();
    libraryDialog.showModal();
    syncLibrary();
  }

  if (Library && NotesSync && libraryDialog) {
    $('library-save').addEventListener('click', () => { saveForOffline(); setMenu(false); });
    $('save-offline').addEventListener('click', () => saveForOffline());
    $('library-open').addEventListener('click', () => { setMenu(false); showLibrary(); });
    $('arxiv-library').addEventListener('click', showLibrary);
    $('library-close').addEventListener('click', () => libraryDialog.close());
    libraryDialog.addEventListener('click', (e) => { if (e.target === libraryDialog) libraryDialog.close(); });
    $('library-search').addEventListener('input', (e) => { libraryFilter = e.target.value; renderLibrary(); });
    libraryDb.then((db) => (db ? db.keys() : [])).then((keys) => {
      for (const k of keys) libraryHere.add(k);
      updateLibraryButton();
    }).catch(() => {});
    window.addEventListener('online', () => syncLibrary());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncLibrary(); });
    setTimeout(syncLibrary, 1500);
  } else {
    for (const id of ['library-save', 'library-open', 'save-offline']) if ($(id)) $(id).hidden = true;
  }

  // --- share -----------------------------------------------------------------------
  // A link that opens this paper, at the section being read, in the public viewer
  // (src/share.js): the share sheet on a phone, the clipboard on a computer.
  // Papers with no public home (a file from this computer) have nothing to share.
  const Share = window.TeXglassShare || null;

  function shareWhere() {
    if (!paper) return null;
    const arxiv = opened.arxiv || (paper.key.startsWith('arxiv:') ? paper.key.slice(6) : null);
    const gh = !arxiv && opened.gh && opened.gh.links ? opened.gh.links.view : null;
    return arxiv || gh ? { arxiv, gh } : null;
  }

  /** The numbered section at the top of the preview, as Go to names it ("§2.3"), or ''. */
  function sectionHere() {
    const limit = previewPane.getBoundingClientRect().top + 48;
    let num = '';
    for (const t of lastToc) {
      const h = document.getElementById(t.id);
      if (!h || !h.offsetParent) continue;
      if (h.getBoundingClientRect().top > limit) break;
      num = t.num || '';
    }
    return Share.sectionName(String(num).replace(/<[^>]*>/g, ''));
  }

  function updateShareButton() {
    const btn = $('share');
    if (!btn) return;
    const can = !!(Share && shareWhere());
    btn.hidden = !Share;
    btn.disabled = !can;
    btn.title = can
      ? 'Share a link that opens this paper in TeXglass, at the section you are reading'
      : 'Only papers from arXiv or GitHub can be shared as a link';
  }

  async function sharePaper() {
    const where = Share && shareWhere();
    if (!where) return;
    const goto = sectionHere();
    const url = Share.link({ ...where, goto });
    const title = Library ? Library.plainTitle(NotesSync.titleOf(doc)) : '';
    const how = await Share.share(url, title || (where.arxiv ? 'arXiv:' + where.arxiv : ''));
    if (how === 'copied') flashStatus(goto ? `Link copied, opens at ${goto}` : 'Link copied');
    else if (how === 'failed') showStatus('Could not copy the link: ' + url, true);
  }

  if ($('share')) $('share').addEventListener('click', sharePaper);
  updateShareButton();

  // --- reading progress -------------------------------------------------------------
  // A status by each result (src/progress.js), kept with the paper's notes
  // (record.progress), so it is exported, imported and synced with them.
  function progressOn() { return featureOn('progress'); }
  function updateProgress() {
    const item = $('progress-toggle');
    if (item) item.setAttribute('aria-checked', String(progressOn()));
    if (!progress) return;
    progress.setMap(paper ? paper.record.progress : {});
    progress.setEnabled(!!(paper && progressOn() && mode !== 'edit'));
  }
  /** The reader changed a status. */
  function progressChanged(map) {
    if (!paper) return;
    paper.record = Object.assign({}, paper.record, { progress: map });
    writeNotes(paper.key, paper.record);
    clearTimeout(notesPushTimer);
    notesPushTimer = setTimeout(() => syncNotes(true), 2500);
  }
  // --- the reader's changes to the dependency map --------------------------------------
  // Pins, hidden results, their own links, where they dragged things and saved
  // maps (src/insight.js), kept with the paper's notes (record.map), so they are
  // exported, imported and synced with them. Without a paper: for this visit.
  let looseMap = {};
  function mapEditsChanged(m) {
    if (!paper || !NotesSync) { looseMap = m; return; }
    paper.record = Object.assign({}, paper.record, { map: m });
    writeNotes(paper.key, paper.record);
    clearTimeout(notesPushTimer);
    notesPushTimer = setTimeout(() => syncNotes(true), 2500);
  }

  if ($('progress-toggle')) {
    $('progress-toggle').addEventListener('click', () => {
      setFeature('progress', !progressOn());
    });
    if (!NotesSync || !window.TeXglassProgress) $('progress-toggle').hidden = true;
  }

  // --- print / save as PDF -----------------------------------------------------
  // The print stylesheet (styles.css) lays the document out like a paper. Before
  // printing, finish any inline edit so that the printout is the document itself.
  window.addEventListener('beforeprint', () => {
    if (editing) closeEditor();
    hidePopover();
  });
  $('print').addEventListener('click', () => window.print());
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) openFiles(e.target.files);
    e.target.value = '';
  });
  const folderInput = $('folder-input');
  if (folderInput) folderInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length || !Local) return;
    showStatus('Reading the folder…');
    const top = (files[0].webkitRelativePath || '').split('/')[0];
    openRaw(await Local.readFileList(files), top || 'the folder');
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
    const items = Array.from(e.dataTransfer.items || []).filter((i) => i.kind === 'file');
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    // A folder, or several files: put them together (main file, \input files, figures).
    if (Local && (items.length > 1 || entries.some((en) => en && en.isDirectory))) {
      // Chromium hands over a handle for one dropped folder, which lets TeXglass watch it.
      // (Both are asked for before any await: the dropped items empty once the event is over.)
      const asking = items.length === 1 && items[0].getAsFileSystemHandle && !inFrame ? items[0].getAsFileSystemHandle().catch(() => null) : null;
      const handle = asking ? await asking : null;
      showStatus('Reading the files…');
      try {
        if (handle && handle.kind === 'directory') {
          const { raw, handles } = await Local.readDirectoryHandle(handle);
          openRaw(raw, handle.name, handles);
        } else {
          const label = entries.length === 1 && entries[0] ? entries[0].name : `${items.length} files`;
          openRaw(await Local.readDropped(entries.filter(Boolean)), label);
        }
      } catch (err) {
        flashStatus('Could not read what was dropped: ' + (err.message || err.name));
      }
      return;
    }
    const item = items[0];
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
    if (mod && key === 'o') { e.preventDefault(); if (e.shiftKey) openFolder(); else openWithPicker(); }
    if (mod && key === 's') { e.preventDefault(); save(); }
    if (mod && e.shiftKey && key === 'e') { e.preventDefault(); setMode(mode === 'split' ? 'preview' : 'split'); }
    else if (mod && key === 'e') { e.preventDefault(); setMode(mode === 'edit' ? 'preview' : 'edit'); }
  });

  // --- reference previews ----------------------------------------------------

  // The popover stays open while the pointer is on the link or on the popover
  // itself, so a long preview can be scrolled. It closes a moment after the
  // pointer has left both.
  const HIDE_DELAY = 250;
  // References, citations and footnote marks.
  const PREVIEW_LINKS = 'a.ref, .cite a, sup.fn a';
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
    if (node.tagName === 'LI' && node.parentElement && node.parentElement.closest('.footnotes')) {
      // A footnote: its text, without the list number or the back link.
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
      // A result cited in a proof: its hypotheses and conclusion, with boxes to tick (src/hypotheses.js).
      const split = hypotheses && featureOn('hypotheses') && hypotheses.viewFor(target, a, clone);
      body.appendChild(split || clone);
    }
    // a result or numbered equation can be pinned from its preview (it joins the Pinned list)
    const refPin = insight && insight.pinButtonFor && insight.pinButtonFor(target);
    if (refPin) body.prepend(refPin);
    const used = insight && insight.usedByNote(target);
    if (used) body.appendChild(used);
    // A citation: the cited paper's title and abstract, looked up now (never while rendering).
    const cited = cites && featureOn('citeLookup') && cites.noteFor(target, { link: a, results: featureOn('citedResults'), onChange: () => { if (popoverLink === a && !popover.hidden) placePopover(a, body); } });
    if (cited) body.appendChild(cited);
    // On a touch screen the preview is a sheet at the bottom: a tap opened it, and
    // this button goes to the result itself (as a click on the link does elsewhere).
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
  const asSheet = () => !!(window.TeXglassPopover && TeXglassPopover.sheet && TeXglassPopover.sheet(window));
  popover.addEventListener('tg-sheet-close', hidePopover);
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
  preview.addEventListener('mouseover', (e) => {
    if (asSheet()) return; // a tap opens the preview there (below)
    const a = e.target.closest(PREVIEW_LINKS);
    if (!a || (editing && editing.el.contains(a) && !editing.previewEl.contains(a))) return;
    if (Features && !featureOn(Features.previewKind(a))) return; // switched off in Settings
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target || target.contains(a)) return;
    showPopover(a, target);
  });
  preview.addEventListener('mouseout', (e) => {
    if (asSheet()) return;
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
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (target) jumpTo(target);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) hidePopover();
  });
  /** Go to a numbered thing by name ("Theorem 4.1", "Equation (3.2)"), as the Go to box would. */
  function goToNamed(name) {
    if (!window.TeXglassFind) return;
    const t = TeXglassFind.rankTargets(TeXglassFind.collectTargets(preview), name, 1)[0];
    if (t) jumpTo(t.el.closest('.math-display') || t.el);
  }
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
    // On a touch screen a tap on a reference shows it in a sheet first; "Go there" jumps.
    if (asSheet() && a.matches(PREVIEW_LINKS) && (!Features || featureOn(Features.previewKind(a))) && !target.contains(a) && !(editing && editing.el.contains(a) && !editing.previewEl.contains(a))) {
      if (popoverLink !== a || popover.hidden) showPopover(a, target);
      return;
    }
    jumpTo(target);
  });

  // --- find and go to ----------------------------------------------------------------

  // Ctrl+F searches the rendered text; Ctrl+G goes to "Lemma 4.1", "(3.2)", "§2".
  let finder = null;
  if (window.TeXglassFind) {
    finder = window.TeXglassFind.attach({
      root: preview,
      scroller: previewPane,
      reveal,
      onJump: hidePopover,
      // Uses tab: pick a result, see what it uses and what uses it, or light up one side
      onFocus: (el, o) => { if (insight) insight.focus(el, (o && o.dir) || 'both', { scroll: true, collapse: true, at: o && o.at }); },
      related: (el, o) => (insight ? insight.related(el, o) : null),
      // or search by use ("Lemma 2 but not Assumption A"), and light up what it finds
      uses: (q) => (insight ? insight.searchUses(q) : null),
      onUses: (q, el) => { if (insight) insight.showUses(q, { at: el, scroll: true, collapse: true }); },
    });
    window.TeXglassFind.bindKeys(window, finder);
    $('find').addEventListener('click', () => finder.open('find'));
  } else {
    $('find').hidden = true;
  }

  // --- citation previews -------------------------------------------------------------

  // Resting on a citation shows its bibliography entry, then the cited paper's
  // title and abstract once looked up; a paper on arXiv opens in TeXglass in a new tab,
  // as does the "Open in TeXglass" button on its entry in the bibliography.
  // A citation that names a result ("[12, Theorem 4.1]") shows that result
  // itself: the cited paper's source is fetched from arXiv and converted in a
  // worker of its own, so the document's own renders never wait for it.
  const loadCitedPaper = (() => {
    const katexScript = document.querySelector('script[src*="katex"]');
    let worker = null;
    let ready = null;
    let nextId = 0;
    const waiting = new Map();
    const start = () => {
      if (ready) return ready;
      ready = new Promise((resolve) => {
        try {
          if (!window.Worker || !katexScript || !katexScript.src) { resolve(false); return; }
          worker = new Worker('src/render-worker.js');
          worker.onmessage = (e) => {
            const m = e.data;
            if ('ready' in m) { resolve(m.ready); return; }
            const done = waiting.get(m.id);
            waiting.delete(m.id);
            if (done) done(m);
          };
          worker.onerror = (e) => {
            e.preventDefault();
            waiting.forEach((done) => done({ error: 'The converter stopped.' }));
            waiting.clear();
            worker = null;
            resolve(false);
          };
          worker.postMessage({ katex: katexScript.src });
        } catch (e) {
          worker = null;
          resolve(false);
        }
      });
      return ready;
    };
    return async (id) => {
      if ((await start()) && worker) {
        const m = await new Promise((resolve) => {
          const k = ++nextId;
          waiting.set(k, resolve);
          worker.postMessage({ id: k, arxiv: id });
        });
        if (m.error) throw new Error(m.error);
        return m.html;
      }
      const paper = await TeXglassArxiv.importPaper(id);
      return TeXglass.render(paper.source, {}).html;
    };
  })();

  cites = window.TeXglassCite
    ? window.TeXglassCite.create({
      // goto: a result to show once the paper is open ("Theorem 4.1")
      openArxiv: (id, goto) => {
        const url = new URL(location.href);
        url.search = '?arxiv=' + encodeURIComponent(id) + (goto ? '&goto=' + encodeURIComponent(goto) : '');
        url.hash = '';
        window.open(url.href, '_blank', 'noopener');
      },
      loadPaper: window.TeXglassArxiv ? loadCitedPaper : undefined,
    })
    : null;
  if (cites) cites.decorate(preview);

  // --- notation and dependencies -------------------------------------------------

  // Resting on a formula shows where its notation comes from; the Index button
  // opens the notation index and the map of which results use which. All of
  // it is read from the page when first needed, never while rendering.
  insight = window.TeXglassInsight
    ? window.TeXglassInsight.attach({
      root: preview,
      jump: (el) => jumpTo(el),
      renderTex: (texs, defs) => (window.TeXglass && TeXglass.renderSnippets ? TeXglass.renderSnippets(defs, texs) : null),
      hover: featureOn('notationHover'),
      onHoverChange: (on) => setFeature('notationHover', on),
      notationOrder: store.get('texglass:notation-order'),
      onNotationOrder: (order) => store.set('texglass:notation-order', order),
      // pinned notation rows, kept per paper (or per file name)
      pins: {
        get: () => { try { return JSON.parse(store.get('texglass:notation-pins:' + (paper ? paper.key : fileName.textContent)) || '[]'); } catch (e) { return []; } },
        set: (keys) => store.set('texglass:notation-pins:' + (paper ? paper.key : fileName.textContent), JSON.stringify(keys)),
      },
      usedPinned: store.get('texglass:notation-used-pinned') === '1',
      onUsedPinned: (on) => store.set('texglass:notation-used-pinned', on ? '1' : ''),
      statusOf: (el) => (progress ? progress.statusOf(el) : null),
      print: () => window.print(),
      onFocusStart: () => { if (picker) picker.stop(); },
      onEditSearch: () => { if (finder) finder.open('uses'); }, // "Change" on a search by use
      // the reader's pins, hidden results, own links, layout and saved maps
      edits: {
        get: () => (paper && NotesSync ? paper.record.map : looseMap),
        set: mapEditsChanged,
      },
      locked: store.get('texglass:map-locked') === '1',
      onLock: (on) => store.set('texglass:map-locked', on ? '1' : ''),
      showPinned: () => { if (picker) picker.show(); },
      onPinsChange: () => { if (picker) picker.pinsChanged(); },
    })
    : null;
  // Show pinned results: pin results and numbered equations, see (and print) only
  // those. The pins are the map's (src/insight.js), kept with the paper's notes.
  picker = window.TeXglassPick
    ? TeXglassPick.attach({
      root: preview,
      jump: (el) => jumpTo(el),
      // pinned results and equations (with what their pins bring along), and the paragraphs holding pinned text
      items: insight ? () => insight.pinnedEls().concat(margin && margin.pinnedTextEls ? margin.pinnedTextEls() : []) : undefined,
      isOn: insight ? (el) => insight.isPinned(el) : undefined,
      toggle: insight ? (el) => insight.togglePin(el) : undefined,
      clear: insight ? () => insight.unpinAll() : undefined,
      proofsOf: (el) => {
        const n = insight && insight.graph().byEl.get(el);
        return n ? n.proofs : null;
      },
      print: () => window.print(),
      onStart: () => { if (insight) insight.unfocus(); hidePopover(); },
    })
    : null;
  // The pin in the toolbar: how many things are pinned, and a list of them all
  // (results and equations on the map, rows in the Notation tab) to jump to.
  pinsButton = window.TeXglassPins && insight && $('pins')
    ? TeXglassPins.attach({
      button: $('pins'),
      insight,
      margin,
      jump: (el) => jumpTo(el),
      showPinned: picker ? () => picker.show() : undefined,
      pinMore: picker ? () => picker.start() : undefined,
      onOpen: () => { setMenu(false); hidePopover(); },
    })
    : null;
  if (!pinsButton && $('pins')) $('pins').hidden = true;
  if ($('pick-results')) {
    // with pins: show them; without: pin some first
    if (picker) $('pick-results').addEventListener('click', () => { if (insight && insight.pinCount()) picker.show(); else picker.start(); });
    else $('pick-results').hidden = true;
  }
  // A result cited in a proof previews as its hypotheses and conclusion; the
  // reader's ticks are kept with their notes (and sync with them).
  const hypTicks = new Map(); // ticks while no paper is open to keep them with
  hypotheses = window.TeXglassHypotheses
    ? window.TeXglassHypotheses.attach({
      root: preview,
      isChecked: (id) => (paper && NotesSync ? NotesSync.checks(paper.record).has(id) : !!hypTicks.get(id)),
      setChecked: (id, on, info) => {
        if (!paper || !NotesSync) { hypTicks.set(id, on); return; }
        paper.record = Object.assign(NotesSync.setCheck(paper.record, id, on, info), { paper: paper.key });
        writeNotes(paper.key, paper.record);
        clearTimeout(notesPushTimer);
        notesPushTimer = setTimeout(() => syncNotes(true), 2500);
      },
      prefs: store,
      onChange: () => { if (popoverLink && !popover.hidden) placePopover(popoverLink, popover.firstElementChild); },
    })
    : null;

  // The side panel's tabs (Contents, Map, Notation) and its draggable divider.
  if (window.TeXglassInsight) {
    sideView = TeXglassInsight.sidePanel({
      pane: tocPane,
      head: tocPane.querySelector('.toc-pane-head'),
      list: tocList,
      insight,
      store,
      onJump: () => { if (narrow.matches) { tocWanted = false; showToc(); } },
      onTab: (tab) => { if (tab === 'toc') spyToc(); },
    });
  }
  // Reading progress: markers by the results, progress in Contents, colours on the map.
  progress = window.TeXglassProgress && NotesSync
    ? TeXglassProgress.attach({
      root: preview,
      pane: tocPane,
      list: tocList,
      insight,
      enabled: false, // until a paper is open (updateProgress)
      jump: (el) => { jumpTo(el); if (narrow.matches) { tocWanted = false; showToc(); } },
      onChange: progressChanged,
    })
    : null;
  updateProgress();
  if (progress) progress.refresh();

  // --- stepping through a proof -----------------------------------------------------
  // "Step through" by each proof (src/steps.js): one piece at a time, nested parts
  // folding once passed. Esc closes a preview before it stops the stepping.
  steps = window.TeXglassSteps
    ? TeXglassSteps.attach({
      root: preview,
      enabled: featureOn('proofSteps') && mode !== 'edit',
      reveal,
      previewOpen: () => !popover.hidden,
      dismissPreview: hidePopover,
    })
    : null;
  // --- live parameters ---------------------------------------------------------------
  // Sliders for the parameters a paper declares with \tgparam (src/params.js): each
  // formula or picture that uses one is drawn again, with the paper's own macros.
  params = window.TeXglassParams
    ? TeXglassParams.attach({
      root: preview,
      render: (piece, values) => Promise.resolve(TeXglass.renderLive(renderedDoc || doc, piece, values)),
    })
    : null;

  // --- settings: switching reading aids on or off ---------------------------------

  /** Bring the page in line with the settings. */
  function applyFeatures() {
    if (copier) copier.setEnabled(mode !== 'edit' && featureOn('copyMath'));
    if (insight) {
      insight.setHover(featureOn('notationHover'));
      if (Features) insight.setFeatures(Features.insightParts(features));
    }
    if (sideView && sideView.setTabs && Features) sideView.setTabs(Features.sideTabs(features));
    updateStudy();
    updateProgress();
    if (steps) steps.setEnabled(featureOn('proofSteps') && mode !== 'edit');
    if (typeof setHandwritten === 'function' && (rootEl.dataset.look === 'notes') !== featureOn('handwriting')) setHandwritten(featureOn('handwriting'), false);
    if (popoverLink && !popover.hidden && Features && !featureOn(Features.previewKind(popoverLink))) hidePopover();
    if (settingsPanel && settingsPanel.isOpen()) settingsPanel.refresh();
  }
  function setFeature(id, on) {
    if (!Features) return;
    Features.write(store, id, on);
    features = Features.read(store);
    applyFeatures();
  }
  const settingsPanel = Features ? Features.panel({ get: () => features, set: setFeature }) : null;
  if ($('settings')) {
    if (settingsPanel) $('settings').addEventListener('click', () => settingsPanel.open());
    else $('settings').hidden = true;
  }
  // Settings changed in another tab of this browser.
  window.addEventListener('storage', (e) => {
    if (!Features || !e.key || !Features.LIST.some((f) => Features.keyOf(f) === e.key)) return;
    features = Features.read(store);
    applyFeatures();
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

  // --- handwritten notes look ---------------------------------------------------

  // Notes on squared paper, or chalk on a board in the dark theme (vscode/media/notes.css,
  // shared with the VS Code extension). The ink filters go in on first use.
  const handButton = $('hand-toggle');
  function setHandwritten(on, save) {
    if (on && window.TeXglassInk && !document.querySelector('.tg-ink-filters')) document.body.insertAdjacentHTML('afterbegin', window.TeXglassInk);
    if (on) rootEl.dataset.look = 'notes';
    else delete rootEl.dataset.look;
    handButton.setAttribute('aria-pressed', String(on));
    const label = on ? 'Show as a typeset page' : 'Show as handwritten notes';
    handButton.setAttribute('aria-label', label);
    handButton.title = on ? label : 'Show as handwritten notes (chalk on a board in the dark theme)';
    if (save) {
      store.set('texglass:look', on ? 'notes' : 'standard');
      if (Features) features = Features.read(store);
      if (settingsPanel && settingsPanel.isOpen()) settingsPanel.refresh();
    }
  }
  handButton.addEventListener('click', () => setHandwritten(rootEl.dataset.look !== 'notes', true));
  setHandwritten(store.get('texglass:look') === 'notes', false);
  applyFeatures();

  // --- start -----------------------------------------------------------------

  // --- import from arXiv ------------------------------------------------------------

  const arxivDialog = $('arxiv-dialog');
  const arxivInput = $('arxiv-input');
  const arxivMessage = $('arxiv-message');
  const arxivGo = $('arxiv-go');
  const arxivResults = $('arxiv-results');
  let arxivBusy = false;
  let ghBusy = false; // opening from GitHub, in the same dialog

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
    // Saved for offline reading: with no connection, the saved copy opens straight away.
    const savedKey = libraryKeyOf(id);
    if (navigator.onLine === false && await openSavedKey(savedKey)) {
      if (arxivDialog.open) arxivDialog.close();
      return true;
    }
    arxivBusy = true;
    arxivGo.disabled = true;
    arxivSay(`Downloading ${id} from arXiv…`);
    showStatus(`Importing ${id}…`);
    try {
      const paper = await TeXglassArxiv.importPaper(id);
      fileHandle = null;
      load(paper.source, paper.name, paper.images);
      opened.arxiv = id;
      updateLibraryButton();
      if (arxivDialog.open) arxivDialog.close();
      flashStatus(`Imported ${id} from arXiv`);
      return true;
    } catch (e) {
      // could not download it, but it is saved here: open that copy
      if (await openSavedKey(savedKey)) {
        if (arxivDialog.open) arxivDialog.close();
        return true;
      }
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

  // --- comparing versions (src/diff.js) ------------------------------------------

  // The open document is the newer version; the older one is rendered once,
  // and every render of the newer one is compared with it block by block:
  // changed blocks get a bar and their new words marked (the old version opens
  // under them), new blocks a green bar, removed ones a folded box where they
  // were. A bar at the bottom steps through the changes.

  const Diff = window.TeXglassDiff || null;
  const compareDialog = $('compare-dialog');
  const compareOld = $('compare-old');
  const compareNew = $('compare-new');
  const compareMessage = $('compare-message');
  let compareVersions = null; // [{ v, date }] for the open arXiv paper

  function compareSay(text, warn) {
    compareMessage.textContent = text || '';
    compareMessage.classList.toggle('warn', !!warn);
  }

  function stopCompare() {
    if (!comparing) return;
    const c = comparing;
    comparing = null;
    c.view.destroy();
    c.urls.forEach((u) => URL.revokeObjectURL(u));
    document.documentElement.classList.remove('comparing');
  }

  /** Mark what changed in the blocks just shown, against the older version. */
  function markChanges(blocks, source) {
    if (!comparing) return;
    const result = Diff.compareRenders(comparing.blocks, comparing.source, blocks, source);
    comparing.view.apply(result);
  }

  /**
   * Compare the open document with an older version: its source, figures
   * ({ path: Blob }) and labels ({ old: 'v1', new: 'v2' }).
   */
  async function startCompare(oldSource, oldImages, labels) {
    stopCompare();
    if (!Diff) return false;
    const source = String(oldSource).replace(/\r\n?/g, '\n');
    const urls = [];
    let map = null;
    if (oldImages && Object.keys(oldImages).length) {
      map = {};
      for (const [path, blob] of Object.entries(oldImages)) urls.push((map[path] = URL.createObjectURL(blob)));
    }
    showStatus(`Rendering ${labels.old}…`);
    let old;
    try {
      old = await convert(source, map);
    } catch (e) {
      urls.forEach((u) => URL.revokeObjectURL(u));
      flashStatus(`Could not render ${labels.old}: ${e.message}`);
      return false;
    }
    await render(); // the newer version on screen before marking it
    const view = Diff.view({
      root: preview,
      labels,
      onExit: stopCompare,
      jump: (el) => {
        reveal(el);
        TeXglassScroll.to(previewPane, el, { align: 'center' });
      },
    });
    comparing = { source, blocks: old.blocks, urls, labels, view };
    document.documentElement.classList.add('comparing');
    markChanges(shownBlocks(), renderedDoc);
    const c = view.counts;
    const n = c.changed + c.added + c.removed + c.moved;
    flashStatus(n ? `${labels.old} → ${labels.new}: ${n} change${n > 1 ? 's' : ''}` : `No changes between ${labels.old} and ${labels.new}`);
    return true;
  }

  /** The HTML of the blocks on screen, as the last render gave them. */
  function shownBlocks() {
    return shown.map((e) => e.html).concat(editing && editing.inside ? editing.inside.map((e) => e.html) : []);
  }

  /** The arXiv id (no version) and version (null: the latest) of the open paper, or null. */
  function openArxivPaper() {
    if (!opened.arxiv || !window.TeXglassArxiv) return null;
    return { base: TeXglassArxiv.baseId(opened.arxiv), v: TeXglassArxiv.versionOf(opened.arxiv) };
  }

  /**
   * Compare two arXiv versions of a paper: `id` (with its version, or the
   * latest) is opened, and `older` ('v1' or 1) is compared with it.
   */
  async function compareArxiv(id, older) {
    const base = TeXglassArxiv.baseId(TeXglassArxiv.parseId(id) || '');
    const oldV = Number(String(older).replace(/^v/i, ''));
    if (!base || !(oldV > 0)) return false;
    const newV = TeXglassArxiv.versionOf(id);
    const cur = openArxivPaper();
    if (!cur || cur.base !== base || cur.v !== newV) {
      if (!(await importArxiv(id))) return false;
    }
    showStatus(`Downloading ${base}v${oldV}…`);
    let paper;
    try {
      paper = await TeXglassArxiv.importPaper(`${base}v${oldV}`);
    } catch (e) {
      flashStatus(e.message);
      return false;
    }
    let newLabel = newV ? `v${newV}` : 'latest';
    if (!newV && compareVersions && compareVersions.length && compareVersions.base === base) newLabel = `v${compareVersions[compareVersions.length - 1].v}`;
    return startCompare(paper.source, paper.images, { old: `v${oldV}`, new: newLabel });
  }

  function fillVersions(list, cur) {
    const opt = (v, label) => `<option value="${v}">${label}</option>`;
    const latest = list.length ? list[list.length - 1].v : null;
    const name = (x) => `v${x.v}${x.date ? ` (${x.date})` : ''}`;
    compareOld.innerHTML = list.map((x) => opt(x.v, name(x))).join('');
    compareNew.innerHTML = list.map((x) => opt(x.v, name(x) + (x.v === latest ? ', latest' : ''))).join('');
    const shownV = cur.v || latest;
    compareNew.value = String(shownV);
    compareOld.value = String(Math.max(1, shownV - 1));
    $('compare-go').disabled = list.length < 2;
    if (list.length < 2) compareSay('arXiv has only one version of this paper. You can still compare it with a file.');
  }

  async function openCompareDialog() {
    if (!Diff) return;
    const cur = openArxivPaper();
    compareSay('');
    $('compare-arxiv').hidden = !cur;
    $('compare-go').hidden = !cur;
    $('compare-go').disabled = !cur;
    if (cur) {
      $('compare-paper').textContent = cur.base;
      compareOld.innerHTML = compareNew.innerHTML = '';
      if (compareVersions && compareVersions.base === cur.base) fillVersions(compareVersions, cur);
      else {
        compareSay('Looking up the versions…');
        TeXglassArxiv.versions(cur.base).then((list) => {
          list.base = cur.base;
          compareVersions = list;
          compareSay('');
          fillVersions(list, cur);
        }, () => {
          // No list (offline, or DataCite is down): offer v1 up to the version shown, or a few.
          const n = Math.max(cur.v || 0, 2);
          const list = Array.from({ length: n }, (_, k) => ({ v: k + 1, date: '' }));
          fillVersions(list, cur);
          compareSay('Could not look up the versions; pick them by number.', true);
        });
      }
    }
    if (!compareDialog.open) {
      if (compareDialog.showModal) compareDialog.showModal();
      else compareDialog.setAttribute('open', '');
    }
  }

  if (compareDialog && Diff) {
    $('compare-open').addEventListener('click', openCompareDialog);
    $('compare-cancel').addEventListener('click', () => compareDialog.close());
    $('compare-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const cur = openArxivPaper();
      if (!cur) return;
      const a = Number(compareOld.value);
      const b = Number(compareNew.value);
      if (!a || !b || a === b) {
        compareSay('Pick two different versions.', true);
        return;
      }
      compareDialog.close();
      const [older, newer] = a < b ? [a, b] : [b, a];
      const latest = compareVersions && compareVersions.length ? compareVersions[compareVersions.length - 1].v : null;
      await compareArxiv(newer === latest && !cur.v ? cur.base : `${cur.base}v${newer}`, older);
    });
    $('compare-file').addEventListener('click', () => $('compare-file-input').click());
    $('compare-file-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      compareDialog.close();
      const text = await file.text();
      const here = fileName.textContent || 'this document';
      await startCompare(text, null, { old: file.name === here ? `${file.name} (other)` : file.name, new: here });
    });
  } else if ($('compare-open')) $('compare-open').hidden = true;

  function openArxivDialog(value) {
    if (value != null) arxivInput.value = value;
    if (Library && NotesSync) renderRecentSaved();
    if (!arxivDialog.open) {
      if (arxivDialog.showModal) arxivDialog.showModal();
      else arxivDialog.setAttribute('open', '');
    }
    arxivInput.focus();
    arxivInput.select();
  }

  // --- searching arXiv (through DataCite and fallbacks; arXiv's own API blocks web pages) ---

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

  /**
   * What the Open dialog's box asks for: 'github <words>' searches GitHub
   * ('github owner/repo', or a GitHub link, opens it), an arXiv id or link
   * imports that paper, and anything else searches arXiv.
   */
  function classifyQuery(v) {
    const gh = window.TeXglassGitHub;
    const m = /^github(?:[:\s]+|$)([\s\S]*)$/i.exec(v);
    if (m) {
      const rest = m[1].trim();
      if (gh && rest.includes('/') && !/\s/.test(rest) && gh.parseUrl(rest)) return { kind: 'gh-open', value: rest };
      return { kind: 'gh-search', value: rest };
    }
    if (gh && /github\.(?:com|dev)|githubusercontent\.com/i.test(v) && gh.parseUrl(v)) return { kind: 'gh-open', value: v };
    if (TeXglassArxiv.parseId(v)) return { kind: 'arxiv-open', value: v };
    return { kind: 'arxiv-search', value: v };
  }

  function updateArxivButton() {
    const v = arxivInput.value.trim();
    const kind = v ? classifyQuery(v).kind : 'arxiv-search';
    arxivGo.textContent = kind === 'arxiv-open' ? 'Import' : kind === 'gh-open' ? 'Open' : 'Search';
  }

  function showResults(on) {
    arxivResults.hidden = !on;
    arxivDialog.classList.toggle('has-results', on);
  }

  /** One GitHub repository in the results: click to open its main .tex file. */
  function githubResult(r) {
    const li = document.createElement('li');
    li.className = 'preprint';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preprint-open';
    btn.title = `Open the LaTeX document in ${r.name}`;
    const year = r.updated ? r.updated.slice(0, 4) : '';
    const meta = [`★ ${r.stars.toLocaleString()}`, year && `updated ${year}`, 'GitHub'].filter(Boolean).join(' · ');
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    btn.innerHTML = `<span class="preprint-title">${esc(r.name)}</span>` +
      `<span class="arxiv-result-meta">${esc(meta)}</span>` +
      (r.description ? `<span class="preprint-abstract">${mathText(r.description)}</span>` : '');
    btn.addEventListener('click', () => importGitHub(r.url));
    const link = document.createElement('a');
    link.className = 'preprint-pdf';
    link.href = r.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'GitHub';
    link.title = 'The repository on github.com';
    li.append(btn, link);
    return li;
  }

  function renderSearch() {
    const st = searchState;
    arxivResults.textContent = '';
    const frag = document.createDocumentFragment();
    for (const r of st.results) {
      if (st.source === 'github') { frag.appendChild(githubResult(r)); continue; }
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
      more.addEventListener('click', () => (st.source === 'github' ? searchGitHub(st.query, st.page + 1) : searchArxiv(st.query, st.page + 1)));
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
      if (page === 1 || !searchState || searchState.source !== 'arxiv' || searchState.query !== query) searchState = { source: 'arxiv', query, results: [] };
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

  async function searchGitHub(query, page) {
    const run = ++searchRun;
    page = page || 1;
    if (!query) {
      arxivSay('Type what to look for after github, e.g. github thesis template.', true);
      return;
    }
    if (page === 1) arxivResults.scrollTop = 0;
    arxivSay(page === 1 ? 'Searching GitHub…' : 'Loading more…');
    arxivGo.disabled = true;
    try {
      const res = await TeXglassGitHub.search(query, { page, anyLanguage: page > 1 && searchState && searchState.anyLanguage });
      if (run !== searchRun) return;
      if (page === 1 || !searchState || searchState.source !== 'github' || searchState.query !== query) searchState = { source: 'github', query, results: [] };
      const seen = new Set(searchState.results.map((r) => r.name));
      searchState.results.push(...res.results.filter((r) => !seen.has(r.name)));
      Object.assign(searchState, { page, total: res.total, more: res.more, anyLanguage: res.anyLanguage });
      renderSearch();
      const n = searchState.total;
      arxivSay(searchState.results.length
        ? `${n.toLocaleString()} ${res.anyLanguage ? '' : 'LaTeX '}repositor${n === 1 ? 'y' : 'ies'} on GitHub. Click one to open its main .tex file.`
        : 'No GitHub repositories match that search.', !searchState.results.length);
    } catch (e) {
      if (run !== searchRun) return;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      arxivSay(offline ? 'Searching needs an internet connection.' : `Search failed: ${e.message || e}`, true);
    } finally {
      if (run === searchRun) arxivGo.disabled = false;
    }
  }

  function showArxivDialog() {
    if (!searchState && !arxivBusy && !ghBusy) arxivSay('Search arXiv, or type github and words to search GitHub. Included files, the bibliography and PNG or JPEG figures come along.');
    openArxivDialog();
    updateArxivButton();
  }
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
    const q = classifyQuery(v);
    if (q.kind === 'arxiv-open') importArxiv(v);
    else if (q.kind === 'gh-open') importGitHub(q.value);
    else if (q.kind === 'gh-search') searchGitHub(q.value, 1);
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

  // --- opening files from GitHub (in the Open dialog) ----------------------------

  const ghSay = arxivSay;

  async function importGitHub(input) {
    if (ghBusy || !window.TeXglassGitHub) return false;
    if (!TeXglassGitHub.parseUrl(input)) {
      ghSay('That does not look like a GitHub link, e.g. https://github.com/owner/repo/blob/main/paper.tex.', true);
      if (!arxivDialog.open) openArxivDialog(input);
      return false;
    }
    ghBusy = true;
    arxivGo.disabled = true;
    ghSay('Downloading from GitHub…');
    showStatus('Opening from GitHub…');
    try {
      const file = await TeXglassGitHub.importFile(input);
      fileHandle = null;
      const shown = load(file.source, file.name, file.images, { links: file.links, path: `${file.owner}/${file.repo}/${file.opened || file.path}` });
      if (arxivDialog.open) arxivDialog.close();
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
      if (!arxivDialog.open) openArxivDialog(input);
      return false;
    } finally {
      ghBusy = false;
      arxivGo.disabled = false;
    }
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
        'Press \\textbf{Open} above (Ctrl+K) to search arXiv, type \\texttt{github} and words to search GitHub, ' +
        'paste an arXiv id or a GitHub link, or open a \\texttt{.tex} file from this computer. You can also drop one on this page, ' +
        'or browse \\textbf{OAI preprints}, OpenAI\'s mathematical preprints, and read one here.\n\n' +
        'Math such as $\\int_0^1 x^2\\,dx = \\tfrac13$ is rendered with KaTeX.\n\n' +
        'New here? \\href{?tour}{\\textbf{Take the tour}}: a short paper with notes on what to try, from previews on hover ' +
        'to the dependency map and stepping through a proof.',
      'welcome.tex'
    );
  }

  // The tour (examples/tour.tex): a short paper that shows the features, with
  // notes on what to try. Opened by ?tour, the welcome page and the … menu.
  function loadTour() {
    fileHandle = null;
    return fetch('examples/tour.tex')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((text) => load(text, 'tour.tex'))
      .catch(() => {
        showStatus('The tour could not be loaded.', true);
        return loadWelcome();
      });
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
    // ?file=<file:// address>: a .tex file on this computer (the browser extension, allowed to read file URLs);
    // a bare ?open shows the dialog for choosing a file or folder from this computer.
    if (params.has('tour')) return loadTour();
    const fileUrl = params.get('file');
    if (fileUrl && Local) return openFileUrl(fileUrl);
    if (params.has('open')) {
      const done = last ? loadLast() : loadWelcome();
      showLocalDialog();
      return done;
    }
    const arxiv = params.get('arxiv');
    const gh = params.get('gh') || params.get('github');
    if (arxiv && window.TeXglassArxiv) {
      if (last) loadLast();
      // &goto=Theorem 4.1 (from a cited result's preview): show that result once the paper is in
      const goto = params.get('goto');
      // &compare=v1: mark what changed since that version (src/diff.js)
      const older = params.get('compare');
      if (older && Diff) return compareArxiv(arxiv, older);
      return importArxiv(arxiv).then((ok) => (ok && goto ? render().then(() => goToNamed(goto)) : ok));
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
    // The last paper was a saved one: open that copy, figures included (offline too).
    const lastSaved = store.get('texglass:last-saved');
    if (lastSaved && last) return openSavedKey(lastSaved, { quiet: true, source: last }).then((ok) => ok || loadLast(), loadLast);
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
