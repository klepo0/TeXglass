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
 *   - moves the editor's cursor to what you click: a formula, a word, or the
 *     start of a block;
 *   - has the web viewer's reading aids: a table of contents, Find (Ctrl+F)
 *     and Go to (Ctrl+G, "Lemma 4.1", "(3.2)", "§2"), and a light or dark
 *     theme. Moving around the preview with them, or scrolling it, holds it
 *     there until the editor scrolls again;
 *   - with "Files", downloads the project's zip from Overleaf and
 *     pulls in the files that the open file \inputs, the main file's preamble
 *     (for macros) when the open file is a chapter, references from .bib files
 *     and PNG/JPEG/SVG figures (see overleaf-project.js).
 *
 * It only ever reads the document. Overleaf's own PDF stays the final word.
 */
/* global TeXglass, TeXglassOverleaf, TeXglassZoom, TeXglassScroll */
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
        const n = result.warnings.length;
        say(n ? `${n} warning${n > 1 ? 's' : ''}` : '', n > 0);
        status.title = result.warnings.join('\n');
        patch(result.blocks.length ? result.blocks : ['<p class="empty-doc">This file is empty.</p>']);
        lastToc = result.toc || [];
        updateToc();
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
        if (t) {
          hold();
          TeXglassScroll.to(pane, t, { align: 'center' });
          t.classList.remove('flash');
          void t.offsetWidth;
          t.classList.add('flash');
        }
      } else {
        a.target = '_blank';
        a.rel = 'noopener';
      }
      return;
    }
    if (String(window.getSelection())) return;
    const block = e.target.closest('.src-block');
    if (!block || block.parentElement !== preview) return;
    const at = composed.toOpen(offsetOf(block, e.target, e.clientX, e.clientY));
    post({ type: 'jump', at });
  });

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
      tocList.innerHTML = items
        .map((t) => `<li class="toc-d${Math.min(3, t.level - top)}"><a href="#${t.id}" data-id="${t.id}">${t.num ? `<span class="toc-num">${TeXglass.escapeHtml(t.num)}</span>` : ''}<span class="toc-title">${t.title}</span></a></li>`)
        .join('');
      tocLinks = Array.from(tocList.querySelectorAll('a'));
    }
    showToc();
    spyToc();
  }

  function showToc() {
    const has = tocLinks.length > 0;
    tocPane.hidden = !(tocWanted && has);
    tocToggle.disabled = !has;
    tocToggle.title = has ? 'Show or hide the table of contents' : 'This file has no sections';
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

  // --- find and go to ----------------------------------------------------------------

  // Ctrl+F searches the preview; Ctrl+G goes to "Lemma 4.1", "(3.2)", "§2" (src/find.js).
  if (window.TeXglassFind) {
    const finder = TeXglassFind.attach({ root: preview, scroller: pane, onJump: hold });
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
