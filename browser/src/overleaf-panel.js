/*
 * TeXglass for Overleaf: the preview page (overleaf.html), shown in a panel
 * on Overleaf project pages (see overleaf.js).
 *
 * It gets the open file's text from overleaf-page.js, which reads Overleaf's
 * editor, and renders it as the web viewer does: in a worker, replacing only
 * the blocks that changed, so it keeps up with typing. It also
 *   - follows the editor: the preview scrolls to the part of the file that
 *     is at the top of the editor;
 *   - marks the block that holds the editor's cursor;
 *   - moves the editor's cursor to what you click: a word or the start of a
 *     block; a formula with Ctrl/Cmd+click or a double-click, since a plain
 *     click on a formula copies its LaTeX, as in the VS Code preview;
 *   - folds sections and proofs (click a heading or the arrow; "Proofs" folds
 *     them all) and previews references and citations on hover, with the
 *     cited paper's abstract when it can be looked up (src/cite.js);
 *   - shows where notation comes from when resting on a formula, and "What
 *     does this use?" beside each result (src/insight.js);
 *   - has the web viewer's reading aids: a side panel with tabs for the
 *     contents, the notation index and the map of which results use which,
 *     Find (Ctrl+F)
 *     and Go to (Ctrl+G, "Lemma 4.1", "(3.2)", "§2"), and a light or dark
 *     theme, and the handwritten-notes look. Moving around the preview with them, or scrolling it, holds it
 *     there until the editor scrolls again;
 *   - with "Files", downloads the project's zip from Overleaf and
 *     pulls in the files that the open file \inputs, the main file's preamble
 *     (for macros) when the open file is a chapter, references from .bib files
 *     and PNG/JPEG/SVG figures (see overleaf-project.js).
 *
 * It only ever reads the document. Overleaf's own PDF stays the final word.
 */
/* global TeXglass, TeXglassOverleaf, TeXglassZoom, TeXglassScroll, TeXglassInsight */
(function () {
  'use strict';

  const TAG = 'texglass-overleaf';
  const OVERLEAF = /^https:\/\/([a-z0-9-]+\.)*overleaf\.com$/i;
  const $ = (id) => document.getElementById(id);
  const preview = $('preview');
  const pane = $('preview-pane');
  const status = $('status');
  const fileName = $('file-name');
  const note = $('note');
  const followButton = $('follow');
  const filesButton = $('files');
  const popover = $('ref-popover');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  let parentOrigin = null; // Overleaf's origin, once it has written to us
  let openText = null; // the editor's text
  let openName = '';
  let composed = null; // TeXglassOverleaf.compose(...) for what the preview shows
  let project = null; // { texts, images, urls } from the project's zip
  let follow = store.get('texglass:overleaf-follow') !== 'off';
  let editorTop = 0; // offset of the first line in the editor's view
  // Set when the reader moves around the preview themselves (scrolling it, the
  // contents, Find, Go to, a reference): the preview stays put until the
  // editor scrolls again.
  let held = false;
  const hold = () => { held = true; };
  let lastToc = [];
  let cursor = -1;
  let insight = null; // notation on hover, notation index, dependency map (src/insight.js)
  let cites = null; // citation previews (src/cite.js)

  function post(msg) {
    // 'hello' carries nothing; everything else waits until Overleaf has spoken.
    const origin = parentOrigin || (msg.type === 'hello' || msg.type === 'close' ? '*' : null);
    if (origin && window.parent !== window) window.parent.postMessage(Object.assign({ texglass: TAG }, msg), origin);
  }

  function say(text, warn) {
    status.textContent = text || '';
    status.classList.toggle('warn', !!warn);
  }

  function showNote(html) {
    note.hidden = !html;
    note.innerHTML = html || '';
  }

  // --- rendering -------------------------------------------------------------

  // As in the web viewer (app.js): convert in a worker, or here if there is none.
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
      if (window.Worker && katexScript) {
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
    const here = (source, images) => TeXglass.render(source, {
      sourceMap: true,
      resolveImage: images && window.TeXglassArxiv ? window.TeXglassArxiv.imageResolver(images, source) : undefined,
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

  let busy = false;
  let again = false;
  let shown = []; // [{ html, nodes }] per top-level block

  function render() {
    if (busy) { again = true; return; }
    busy = true;
    again = false;
    const c = TeXglassOverleaf.compose({ text: openText || '', name: openName }, project);
    const slow = setTimeout(() => say('Rendering…'), 400);
    convert(c.text, project ? project.urls : null)
      .then((result) => {
        composed = c;
        if (insight && result.defs) insight.setDefinitions(result.defs);
        const n = result.warnings.length;
        say(n ? `${n} warning${n > 1 ? 's' : ''}` : '', n > 0);
        status.title = result.warnings.join('\n');
        patch(result.blocks.length ? result.blocks : ['<p class="empty-doc">This file is empty.</p>']);
        applyFolds();
        lastToc = result.toc || [];
        updateToc();
        if (insight) insight.invalidate(); // read the page again when next needed
        if (cites) cites.decorate(preview); // "Open in TeXglass" on bibliography entries on arXiv
        explain(c);
      }, (e) => {
        composed = c;
        say('Render failed', true);
        patch([`<pre class="render-error">${TeXglass.escapeHtml(e.message || String(e))}</pre>`]);
      })
      .catch((e) => console.error(e))
      .then(() => {
        clearTimeout(slow);
        busy = false;
        try {
          markCursor();
          if (follow && !held) showOffset(editorTop);
        } finally {
          if (again) render();
        }
      });
  }

  /** Say what the preview is missing, and how to get it. */
  function explain(c) {
    if (!project) {
      const inputs = TeXglassOverleaf.inputsOf(openText);
      const part = openText && !/\\documentclass/.test(openText.replace(/(^|[^\\])%.*$/gm, '$1'));
      if (inputs.length || (part && /\\[a-zA-Z]/.test(openText))) {
        const what = inputs.length
          ? `This file pulls in ${inputs.length} other file${inputs.length > 1 ? 's' : ''}`
          : 'This file is part of a larger document; its macros may be defined in the main file';
        showNote(`${what}. <button type="button" data-act="files">Load the project's files</button> to include them.`);
        return;
      }
      showNote('');
      return;
    }
    const bits = [];
    if (c.main && c.main !== c.path) bits.push(`with the preamble of ${escape(c.main)}`);
    if (c.inlined.length) bits.push(`${c.inlined.length} file${c.inlined.length > 1 ? 's' : ''} pulled in`);
    if (c.missing.length) bits.push(`not found: ${c.missing.map(escape).join(', ')}`);
    showNote(bits.length ? `Project files as of ${project.time}: ${bits.join('; ')}. <button type="button" data-act="files">Reload</button>` : '');
  }

  const escape = (s) => TeXglass.escapeHtml(String(s));

  const BLOCK_HEAD = /^<div class="src-block" data-s="(\d+)" data-e="(\d+)">/;
  const bodyOf = (html) => (html.startsWith('<div class="src-block"') ? html.slice(html.indexOf('>') + 1) : html);

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

  /** Show `blocks`, keeping the DOM of the ones that did not change (as app.js does). */
  function patch(blocks) {
    const old = shown;
    const same = (entry, html) => entry.html === html || bodyOf(entry.html) === bodyOf(html);
    let p = 0;
    while (p < old.length && p < blocks.length && same(old[p], blocks[p])) p++;
    let q = 0;
    while (q < old.length - p && q < blocks.length - p && same(old[old.length - 1 - q], blocks[blocks.length - 1 - q])) q++;
    const keep = (entry, html) => {
      if (entry.html === html) return;
      const m = BLOCK_HEAD.exec(html);
      const el = m && entry.nodes.find((n) => n.nodeType === 1 && n.classList.contains('src-block'));
      if (el) { el.dataset.s = m[1]; el.dataset.e = m[2]; }
      entry.html = html;
    };
    for (let k = 0; k < p; k++) keep(old[k], blocks[k]);
    for (let k = 1; k <= q; k++) keep(old[old.length - k], blocks[blocks.length - k]);
    for (const entry of old.slice(p, old.length - q)) entry.nodes.forEach((n) => n.remove());
    const fresh = toEntries(blocks.slice(p, blocks.length - q));
    const tail = old.slice(old.length - q);
    const ref = (tail.find((e) => e.nodes.length) || { nodes: [null] }).nodes[0];
    fresh.forEach((e) => e.nodes.forEach((n) => preview.insertBefore(n, ref)));
    shown = old.slice(0, p).concat(fresh, tail);
  }

  // --- folding sections and proofs (as in the web viewer and VS Code) -------------------

  // Folds are remembered by their text, so they survive re-renders and edits elsewhere.
  const folded = new Set();
  try { JSON.parse(store.get('texglass:overleaf-folds') || '[]').forEach((k) => folded.add(k)); } catch (e) { /* ignore */ }
  const saveFolds = () => store.set('texglass:overleaf-folds', JSON.stringify(Array.from(folded).slice(-500)));
  const foldProofs = $('fold-proofs');

  const HEADING = ':scope > h1.part, :scope > h1.chapter, :scope > h2.section, :scope > h3.subsection, :scope > h4.subsubsection';

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
    foldProofs.setAttribute('aria-pressed', String(allFolded));
    foldProofs.title = proofs === 0 ? 'This file has no proofs' : allFolded ? 'Unfold every proof' : 'Fold every proof';
    foldProofs.disabled = proofs === 0;
  }

  function setFold(key, on) {
    if (on) folded.add(key);
    else folded.delete(key);
    saveFolds();
  }

  /** Unfold whatever hides `el`, so it can be shown. */
  function reveal(el) {
    let changed = false;
    const proof = el.closest('.proof.folded');
    if (proof) {
      setFold(proof.querySelector('.fold-toggle').dataset.key, false);
      changed = true;
    }
    const block = el.closest('#preview > *');
    if (block && block.classList.contains('fold-hidden')) {
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

  // Before the click that moves the editor's cursor: toggles, headings and folded proofs fold instead.
  preview.addEventListener('click', (e) => {
    const btn = e.target.closest('.fold-toggle');
    const onFormula = !!e.target.closest('.math[data-tex]');
    const mod = e.ctrlKey || e.metaKey;
    const foldedProof = !btn && !onFormula && !mod && e.target.closest('.proof.folded');
    const heading = !btn && !onFormula && !mod && !e.target.closest('a') && e.target.closest('#preview > .src-block > h1, #preview > .src-block > h2, #preview > .src-block > h3, #preview > .src-block > h4');
    const target = btn || (foldedProof && foldedProof.querySelector('.fold-toggle')) || (heading && heading.querySelector(':scope > .fold-toggle'));
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setFold(target.dataset.key, !folded.has(target.dataset.key));
    applyFolds();
  });

  foldProofs.addEventListener('click', () => {
    const toggles = Array.from(preview.querySelectorAll('.proof > p:first-child > .fold-toggle'));
    const fold = !toggles.every((t) => folded.has(t.dataset.key));
    toggles.forEach((t) => setFold(t.dataset.key, fold));
    applyFolds();
  });

  // --- following the editor ------------------------------------------------------

  const blocks = () => Array.from(preview.querySelectorAll(':scope > .src-block'));

  /** The block that shows offset `c` of the composed text, or the first one after it. */
  function blockAt(c) {
    let found = null;
    for (const b of blocks()) {
      if (Number(b.dataset.e) > c) return { block: b, inside: Number(b.dataset.s) <= c };
      found = b;
    }
    return found ? { block: found, inside: true } : null;
  }

  /** Scroll the preview so that offset `o` of the open file is at the top. */
  function showOffset(o) {
    if (!composed) return;
    const c = composed.fromOpen(o);
    let n = 0;
    const step = () => {
      const hit = blockAt(c);
      if (!hit) return;
      const b = hit.block;
      const s = Number(b.dataset.s);
      const e = Number(b.dataset.e);
      const frac = hit.inside && e > s ? Math.min(1, (c - s) / (e - s)) : 0;
      const top = b.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      pane.scrollTop = Math.max(0, top + frac * b.offsetHeight - 12);
      // Off-screen blocks have estimated heights until shown; settle over a few frames.
      if (++n < 3) requestAnimationFrame(step);
    };
    step();
  }

  function markCursor() {
    const old = preview.querySelector(':scope > .src-block.ol-cursor');
    let now = null;
    if (composed && cursor >= 0) {
      const hit = blockAt(composed.fromOpen(cursor));
      if (hit && hit.inside) now = hit.block;
    }
    if (old !== now) {
      if (old) old.classList.remove('ol-cursor');
      if (now) now.classList.add('ol-cursor');
    }
  }

  function setFollow(on) {
    follow = on;
    followButton.setAttribute('aria-pressed', String(on));
    store.set('texglass:overleaf-follow', on ? 'on' : 'off');
    if (on) showOffset(editorTop);
  }
  followButton.addEventListener('click', () => setFollow(!follow));
  setFollow(follow);

  // --- clicking the preview moves the editor's cursor -------------------------------

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }

  /** Where in the composed text a click on `block` at (x, y) on `target` points: a formula, a word, or the block. */
  function offsetOf(block, target, x, y) {
    const s = Number(block.dataset.s);
    const e = Number(block.dataset.e);
    const src = composed.text.slice(s, e);
    const math = target.closest('.math[data-tex]');
    if (math && block.contains(math)) {
      const tex = math.dataset.tex;
      let i = src.indexOf(tex);
      if (i < 0) i = src.indexOf(tex.trim().slice(0, 24));
      if (i >= 0) return s + i;
    }
    const caret = caretAt(x, y);
    if (caret && caret.node && caret.node.nodeType === 3 && block.contains(caret.node)) {
      const text = caret.node.data;
      let a = caret.offset;
      let b = caret.offset;
      const letter = /[\p{L}\p{N}]/u;
      while (a > 0 && letter.test(text[a - 1])) a--;
      while (b < text.length && letter.test(text[b])) b++;
      const word = text.slice(a, b);
      if (word.length >= 2) {
        // The word's place in the block's text, to pick the right one of several.
        const range = document.createRange();
        range.setStart(block, 0);
        range.setEnd(caret.node, a);
        const before = range.toString().length;
        const rel = before / Math.max(1, block.textContent.length);
        const hits = [];
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
        for (const m of src.matchAll(re)) hits.push(m.index);
        if (hits.length) {
          hits.sort((i, j) => Math.abs(i / src.length - rel) - Math.abs(j / src.length - rel));
          return s + hits[0] + (caret.offset - a);
        }
      }
    }
    // The start of the block, past its leading blank lines.
    return s + (src.length - src.replace(/^\s+/, '').length);
  }

  preview.addEventListener('click', (e) => {
    if (!composed || e.button !== 0) return;
    const a = e.target.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) {
        e.preventDefault();
        const t = document.getElementById(decodeURIComponent(href.slice(1)));
        if (t) jumpTo(t);
      } else {
        a.target = '_blank';
        a.rel = 'noopener';
      }
      return;
    }
    // A plain click on a formula copies it (copytex.js); Ctrl/Cmd+click or a double-click goes to its source.
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && e.target.closest('.math[data-tex]')) return;
    if (!mod && String(window.getSelection())) return;
    jumpToSource(e);
  });
  preview.addEventListener('dblclick', (e) => {
    if (!composed || e.target.closest('a, .fold-toggle, .uses-btn')) return;
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges(); // the double-click selected a word
    jumpToSource(e);
  });

  function jumpToSource(e) {
    const block = e.target.closest('.src-block');
    if (!block || block.parentElement !== preview) return;
    // Text pulled in from another file (\input, or a chapter's main file) goes to that file.
    const c = offsetOf(block, e.target, e.clientX, e.clientY);
    const src = composed.sourceAt(c);
    if (src.file && src.file !== composed.path) post({ type: 'jump', at: src.at, file: src.file });
    else post({ type: 'jump', at: composed.toOpen(c) });
  }

  /** Go to `target` in the preview (a reference, the contents, Go to), unfolding what hides it. */
  function jumpTo(target) {
    hidePopover();
    reveal(target);
    hold();
    TeXglassScroll.to(pane, target, { align: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // Click a formula to copy its LaTeX; the delay lets a double-click (go to the source) cancel it.
  if (window.TeXglassCopyTex) TeXglassCopyTex.attach({ roots: [preview, popover], delay: 250 });

  // --- reference previews (as in the web viewer and VS Code) --------------------------

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
      const h = node.cloneNode(true);
      h.querySelectorAll('.fold-toggle').forEach((b) => b.remove());
      body.innerHTML = `<p><strong>${h.innerHTML}</strong></p>`;
    } else {
      const clone = node.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      clone.querySelectorAll('.fold-toggle').forEach((b) => b.remove());
      clone.classList.remove('folded');
      clone.querySelectorAll('.folded').forEach((el) => el.classList.remove('folded'));
      body.appendChild(clone);
    }
    // What the result uses and where it is used (src/insight.js).
    const used = insight && insight.usedByNote(target);
    if (used) body.appendChild(used);
    // A citation: the cited paper's title and abstract, looked up now (never while rendering).
    const cited = cites && cites.noteFor(target, { onChange: () => { if (popoverLink === a && !popover.hidden) placePopover(a, body); } });
    if (cited) body.appendChild(cited);
    popover.replaceChildren(body);
    popover.hidden = false;
    placePopover(a, body);
  }
  function placePopover(a, body) {
    const r = a.getBoundingClientRect();
    let width = Math.min(560, window.innerWidth - 32);
    popover.style.width = width + 'px';
    let extra = 0;
    body.querySelectorAll('.math-display, .tg-diagram').forEach((el) => {
      extra = Math.max(extra, el.scrollWidth - el.clientWidth);
    });
    if (extra > 0) {
      width = Math.min(width + extra + 2, window.innerWidth - 32);
      popover.style.width = width + 'px';
    }
    popover.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
    const h = popover.offsetHeight;
    popover.style.top = (r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h : r.bottom) + 'px';
  }
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.ref, .cite a');
    if (!a) return;
    const target = document.getElementById((a.getAttribute('href') || '').slice(1));
    if (!target || target.contains(a)) return;
    showPopover(a, target);
  });
  preview.addEventListener('mouseout', (e) => {
    const a = e.target.closest('a.ref, .cite a');
    if (!a || popover.hidden || a.contains(e.relatedTarget)) return;
    if (popover.contains(e.relatedTarget)) return;
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
  pane.addEventListener('scroll', () => { if (!popover.hidden) hidePopover(); }, { passive: true });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !popover.hidden) hidePopover(); });

  // --- project files -------------------------------------------------------------

  function loadFiles() {
    filesButton.disabled = true;
    say('Downloading the project…');
    post({ type: 'load-files' });
  }

  async function gotFiles(zip) {
    try {
      const raw = await TeXglassOverleaf.unzip(zip, TeXglassOverleaf.wanted);
      const { texts, images } = TeXglassOverleaf.sortFiles(raw);
      if (project) project.urlList.forEach((u) => URL.revokeObjectURL(u));
      const urls = {};
      const urlList = [];
      for (const [p, blob] of Object.entries(images)) urlList.push((urls[p] = URL.createObjectURL(blob)));
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      project = { texts, urls, urlList, time };
      filesButton.textContent = 'Reload';
      say('');
      render();
    } catch (e) {
      say(`Could not read the project's zip: ${e.message}`, true);
    } finally {
      filesButton.disabled = false;
    }
  }

  filesButton.addEventListener('click', loadFiles);
  note.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="files"]')) loadFiles();
  });

  // Scrolling the preview by hand holds it where the reader put it.
  ['wheel', 'touchstart', 'keydown'].forEach((t) => pane.addEventListener(t, hold, { passive: true }));
  pane.addEventListener('pointerdown', (e) => { if (e.target === pane) hold(); }); // the scrollbar

  // --- table of contents -----------------------------------------------------------------

  const tocPane = $('toc-pane');
  const tocList = $('toc-list');
  const tocToggle = $('toc-toggle');
  const narrow = window.matchMedia('(max-width: 760px)');
  let tocWanted = !narrow.matches && store.get('texglass:overleaf-toc') === 'on';
  let tocKey = '';
  let tocLinks = [];

  function updateToc() {
    // The bibliography gets an entry too, as in the web viewer.
    const items = lastToc.slice();
    const bib = preview.querySelector('.bibliography > h2');
    if (bib && items.length && !items.some((t) => t.id === (bib.id || 'references'))) {
      bib.id = bib.id || 'references';
      items.push({ level: Math.min(...items.map((t) => t.level)), num: '', title: TeXglass.escapeHtml(bib.textContent), id: bib.id });
    }
    const key = JSON.stringify(items);
    if (key !== tocKey) {
      tocKey = key;
      const top = items.length ? Math.min(...items.map((t) => t.level)) : 0;
      tocList.innerHTML = items.length
        ? items
          .map((t) => `<li class="toc-d${Math.min(3, t.level - top)}"><a href="#${t.id}" data-id="${t.id}">${t.num ? `<span class="toc-num">${TeXglass.escapeHtml(t.num)}</span>` : ''}<span class="toc-title">${t.title}</span></a></li>`)
          .join('')
        : '<li class="toc-empty">This file has no sections.</li>';
      tocLinks = Array.from(tocList.querySelectorAll('a'));
    }
    showToc();
    spyToc();
  }

  function showToc() {
    // With the Notation and Map tabs the panel has something to show even without sections.
    const has = tocLinks.length > 0 || (!!insight && preview.childElementCount > 0);
    tocPane.hidden = !(tocWanted && has);
    tocToggle.disabled = !has;
    tocToggle.title = has ? 'Show or hide the side panel: contents, notation index and the map of which results use which' : 'This file is empty';
    tocToggle.setAttribute('aria-pressed', String(tocWanted && has));
    document.documentElement.style.setProperty('--ol-top', document.querySelector('.ol-toolbar').getBoundingClientRect().bottom + 'px');
  }

  /** Mark the section at the top of the preview. */
  function spyToc() {
    if (tocPane.hidden || !tocLinks.length) return;
    const limit = pane.getBoundingClientRect().top + 48;
    let current = null;
    for (const a of tocLinks) {
      const h = document.getElementById(a.dataset.id);
      if (!h || !h.offsetParent) continue;
      if (h.getBoundingClientRect().top <= limit) current = a;
      else break;
    }
    if (current === tocList.querySelector('a.active')) return;
    tocLinks.forEach((a) => a.classList.toggle('active', a === current));
    if (current) {
      const r = current.getBoundingClientRect();
      const pr = tocPane.getBoundingClientRect();
      if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) tocPane.scrollTop += r.top - pr.top - pr.height / 3;
    }
  }

  let spyFrame = 0;
  pane.addEventListener('scroll', () => {
    if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; spyToc(); });
  }, { passive: true });

  tocList.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.dataset.id);
    if (!target) return;
    reveal(target);
    hold();
    TeXglassScroll.to(pane, target);
    tocLinks.forEach((l) => l.classList.toggle('active', l === a));
    if (narrow.matches) { tocWanted = false; showToc(); }
  });

  tocToggle.addEventListener('click', () => {
    tocWanted = !tocWanted;
    if (!narrow.matches) store.set('texglass:overleaf-toc', tocWanted ? 'on' : 'off');
    showToc();
    spyToc();
  });
  // When the panel is narrow the contents are a drawer: a click elsewhere or Escape closes it.
  document.addEventListener('pointerdown', (e) => {
    if (narrow.matches && tocWanted && !tocPane.contains(e.target) && !tocToggle.contains(e.target)) { tocWanted = false; showToc(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && narrow.matches && tocWanted) { tocWanted = false; showToc(); }
  });
  window.addEventListener('resize', showToc);

  // The contents go on the left of the document, or on the right.
  const tocSide = $('toc-side');
  function setTocSide(right) {
    document.body.classList.toggle('toc-right', right);
    const label = right ? 'Move the contents to the left' : 'Move the contents to the right';
    tocSide.setAttribute('aria-label', label);
    tocSide.title = label;
  }
  setTocSide(store.get('texglass:overleaf-toc-side') === 'right');
  tocSide.addEventListener('click', () => {
    const right = !document.body.classList.contains('toc-right');
    store.set('texglass:overleaf-toc-side', right ? 'right' : 'left');
    setTocSide(right);
  });

  // --- citation previews, notation and dependencies (as in the web viewer) ------------

  // Resting on a citation shows its entry, then the cited paper's title and abstract
  // once looked up; a paper on arXiv opens in the extension's own viewer.
  cites = window.TeXglassCite
    ? window.TeXglassCite.create({
      openArxiv: (id) => window.open(new URL('index.html?arxiv=' + encodeURIComponent(id), location.href).href, '_blank', 'noopener'),
    })
    : null;

  // Resting on a formula shows where its notation comes from, and each result gets a
  // "What does this use?" button. All of it is read from the page when first needed,
  // never while rendering, so typing in Overleaf stays as quick as before.
  insight = window.TeXglassInsight
    ? TeXglassInsight.attach({
      root: preview,
      jump: (el) => jumpTo(el),
      renderTex: (texs, defs) => (TeXglass.renderSnippets ? TeXglass.renderSnippets(defs, texs) : null),
      hover: store.get('texglass:notationHover') !== 'off',
      onHoverChange: (on) => store.set('texglass:notationHover', on ? 'on' : 'off'),
    })
    : null;
  // The side panel's tabs (Contents, Notation, Map) and its divider. The panel's tab and
  // width are kept apart from the full viewer's, since this panel is usually narrower.
  if (insight) {
    const sideStore = {
      get: (k) => store.get(k.replace('texglass:', 'texglass:overleaf-')),
      set: (k, v) => store.set(k.replace('texglass:', 'texglass:overleaf-'), v),
    };
    TeXglassInsight.sidePanel({
      pane: tocPane,
      head: tocPane.querySelector('.toc-pane-head'),
      list: tocList,
      insight,
      store: sideStore,
      onJump: () => { hold(); if (narrow.matches) { tocWanted = false; showToc(); } },
      onTab: (tab) => { if (tab === 'toc') spyToc(); },
    });
  }

  // --- find and go to ----------------------------------------------------------------

  // Ctrl+F searches the preview; Ctrl+G goes to "Lemma 4.1", "(3.2)", "§2" (src/find.js).
  if (window.TeXglassFind) {
    const finder = TeXglassFind.attach({ root: preview, scroller: pane, reveal, onJump: () => { hold(); hidePopover(); } });
    TeXglassFind.bindKeys(window, finder);
    $('find').addEventListener('click', () => finder.open('find'));
  } else {
    $('find').hidden = true;
  }

  // --- light and dark theme ----------------------------------------------------------
  //
  // Follows the system until switched; the choice is shared with the viewer
  // bundled in the extension (same storage).

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
    window.addEventListener('storage', (e) => {
      if (e.key !== 'texglass:theme') return;
      if (e.newValue === 'light' || e.newValue === 'dark') rootEl.dataset.theme = e.newValue;
      else delete rootEl.dataset.theme;
      updateThemeButton();
    });
    updateThemeButton();
  }

  // --- handwritten notes look ---------------------------------------------------------
  //
  // Notes on squared paper, or chalk on a board in the dark theme (vscode/media/notes.css,
  // as in the web viewer and VS Code). Shared with the extension's viewer, like the theme.

  const handButton = $('hand-toggle');
  function setHandwritten(on, save) {
    if (on && window.TeXglassInk && !document.querySelector('.tg-ink-filters')) document.body.insertAdjacentHTML('afterbegin', window.TeXglassInk);
    if (on) rootEl.dataset.look = 'notes';
    else delete rootEl.dataset.look;
    handButton.setAttribute('aria-pressed', String(on));
    const label = on ? 'Show as a typeset page' : 'Show as handwritten notes';
    handButton.setAttribute('aria-label', label);
    handButton.title = on ? label : 'Show as handwritten notes (chalk on a board in the dark theme)';
    if (save) store.set('texglass:look', on ? 'notes' : 'standard');
  }
  handButton.addEventListener('click', () => setHandwritten(rootEl.dataset.look !== 'notes', true));
  setHandwritten(store.get('texglass:look') === 'notes', false);
  window.addEventListener('storage', (e) => {
    if (e.key === 'texglass:look') setHandwritten(e.newValue === 'notes', false);
  });

  // --- zoom and close ----------------------------------------------------------------

  if (window.TeXglassZoom) {
    const zoom = TeXglassZoom.create({
      pane,
      document: preview,
      onChange(z) { store.set('texglass:overleaf-zoom', String(z)); },
    });
    zoom.set(TeXglassZoom.parse(store.get('texglass:overleaf-zoom')), true);
    $('zoom-out').addEventListener('click', () => zoom.step(-1));
    $('zoom-in').addEventListener('click', () => zoom.step(1));
  }
  $('close').addEventListener('click', () => post({ type: 'close' }));

  // --- text width --------------------------------------------------------------------
  //
  // Grips on both edges of the text: dragging one widens or narrows the column (it stays
  // centred), double-click goes back to the usual width, and dragging to the panel's edge
  // lets the text fill the panel. Remembered (in px at 100% zoom, so zooming scales it).

  const TEXT_KEY = 'texglass:overleaf-text-width';
  const TEXT_MIN = 240; // px on screen
  const zoomNow = () => parseFloat(getComputedStyle(rootEl).getPropertyValue('--zoom')) || 1;
  const grips = ['left', 'right'].map((side) => {
    const g = document.createElement('div');
    g.className = 'text-resizer text-resizer-' + side;
    g.dataset.side = side;
    g.setAttribute('role', 'separator');
    g.setAttribute('aria-orientation', 'vertical');
    g.setAttribute('aria-label', 'Text width');
    g.tabIndex = 0;
    g.title = 'Drag to change the text width · double-click for the usual width';
    pane.appendChild(g);
    return g;
  });

  /** Apply a width: a number (px at 100% zoom), 'full', or null for the usual width. */
  function setTextWidth(w, save) {
    const full = w === 'full';
    if (typeof w === 'number' && isFinite(w)) rootEl.style.setProperty('--ol-text-width', Math.round(w) + 'px');
    else rootEl.style.removeProperty('--ol-text-width');
    document.body.classList.toggle('ol-text-full', full);
    if (save) store.set(TEXT_KEY, full ? 'full' : typeof w === 'number' ? String(Math.round(w)) : '');
    placeGrips();
  }

  /** The width the text would get for a drag to `px` on screen: a number, or 'full'. */
  function widthFor(px) {
    const room = pane.clientWidth;
    if (px >= room - 24) return 'full'; // close to the panel's edges: fill it
    return Math.max(Math.min(TEXT_MIN, room), px) / zoomNow();
  }

  function placeGrips() {
    const r = preview.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    const right = p.left + pane.clientLeft + pane.clientWidth; // the scrollbar is not text
    const show = r.width > 0 && !preview.hidden;
    grips.forEach((g) => {
      g.hidden = !show;
      if (!show) return;
      // Inside the text's padding, so the grip never covers the scrollbar or the side panel.
      const x = g.dataset.side === 'left' ? Math.max(r.left, p.left) : Math.min(r.right, right) - 10;
      g.style.left = Math.round(x) + 'px';
      g.style.top = Math.round(p.top) + 'px';
      g.style.height = Math.round(p.height) + 'px';
      g.setAttribute('aria-valuenow', String(Math.round(r.width)));
    });
  }

  grips.forEach((g) => {
    const sign = g.dataset.side === 'left' ? -1 : 1;
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const width = preview.getBoundingClientRect().width;
      document.body.classList.add('text-resizing');
      // The column stays centred, so each edge moves by half the change.
      const move = (ev) => setTextWidth(widthFor(width + 2 * sign * (ev.clientX - start)), false);
      const up = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        document.body.classList.remove('text-resizing');
        const full = document.body.classList.contains('ol-text-full');
        setTextWidth(full ? 'full' : preview.getBoundingClientRect().width / zoomNow(), true);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
    g.addEventListener('dblclick', () => setTextWidth(null, true));
    g.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = (e.key === 'ArrowRight') === (sign > 0);
      setTextWidth(widthFor(preview.getBoundingClientRect().width + (grow ? 40 : -40)), true);
    });
  });

  const savedWidth = store.get(TEXT_KEY);
  setTextWidth(savedWidth === 'full' ? 'full' : parseFloat(savedWidth) > 0 ? parseFloat(savedWidth) : null, false);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => placeGrips());
    ro.observe(pane);
    ro.observe(preview);
  }
  window.addEventListener('resize', placeGrips);
  window.addEventListener('storage', (e) => {
    if (e.key !== TEXT_KEY) return;
    const v = e.newValue;
    setTextWidth(v === 'full' ? 'full' : parseFloat(v) > 0 ? parseFloat(v) : null, false);
  });

  // --- messages from the Overleaf page --------------------------------------------------

  let renderTimer = null;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window.parent || !OVERLEAF.test(e.origin) || !d || d.texglass !== TAG) return;
    parentOrigin = e.origin;
    if (d.type === 'doc' && typeof d.text === 'string') {
      const switched = d.name !== openName;
      openText = d.text.replace(/\r\n?/g, '\n');
      openName = d.name || '';
      fileName.textContent = openName.split('/').pop();
      fileName.title = openName;
      clearTimeout(renderTimer);
      if (switched) {
        preview.replaceChildren();
        shown = [];
        render();
      } else renderTimer = setTimeout(render, 120);
    } else if (d.type === 'scroll' && typeof d.top === 'number') {
      editorTop = d.top;
      held = false;
      if (follow) showOffset(editorTop);
    } else if (d.type === 'cursor' && typeof d.at === 'number') {
      cursor = d.at;
      markCursor();
    } else if (d.type === 'files' && d.zip) {
      gotFiles(d.zip);
    } else if (d.type === 'jump-failed') {
      say(`Could not open ${d.file} in Overleaf's editor`, true);
    } else if (d.type === 'files-error') {
      filesButton.disabled = false;
      say(d.message || 'Could not download the project.', true);
    } else if (d.type === 'no-editor' && openText == null) {
      showNote('Open a .tex file in Overleaf\'s editor to see it here.');
    }
  });

  function start() {
    showNote('Waiting for Overleaf\'s editor…');
    post({ type: 'hello' });
    // Ask again in case the page script started after us.
    let tries = 0;
    const timer = setInterval(() => {
      if (openText != null || ++tries > 20) {
        clearInterval(timer);
        if (openText == null) showNote('Could not find Overleaf\'s editor on this page. Open a .tex file in the editor, or reload the page.');
        return;
      }
      post({ type: 'hello' });
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
