/*
 * TeXglass for Overleaf: runs in the Overleaf page itself (the content
 * script's "MAIN" world), where Overleaf's editor lives.
 *
 * Overleaf's editor is CodeMirror 6. This script finds its EditorView and
 * sends the preview (the extension's overleaf.html, in a frame that
 * overleaf.js adds to the page) what it needs:
 *
 *   { type: 'doc', text, name }   the open file, each time it changes (typing,
 *                                 a collaborator's edit, switching files)
 *   { type: 'scroll', top }       the offset of the first line in view
 *   { type: 'cursor', at }        the offset of the cursor
 *   { type: 'files', zip }        the project's zip, when the preview asks
 *
 * and does what the preview asks:
 *
 *   { type: 'jump', at }          put the cursor there and scroll to it
 *   { type: 'load-files' }        download the project's zip (Overleaf's own
 *                                 "Download as zip", with the reader's login)
 *   { type: 'hello' }             send everything again
 *
 * It never changes the document: the only thing it does to the editor is
 * move the cursor when the reader clicks the preview.
 *
 * Finding the editor without relying on Overleaf's page layout:
 *   - CodeMirror keeps a handle on the .cm-content element (cmTile, or cmView
 *     in older versions), so any .cm-editor on the page leads to its EditorView;
 *   - Overleaf also announces each new editor with an 'UNSTABLE_editor:extensions'
 *     event that lets extensions add to it; a small plugin there records the view.
 * Changes are noticed by comparing the editor's document object, which
 * CodeMirror replaces on every change, a few times a second.
 */
(function () {
  'use strict';
  if (window.__texglassOverleaf) return;
  window.__texglassOverleaf = true;

  const TAG = 'texglass-overleaf';
  const FRAME_ID = 'texglass-overleaf-frame';
  const announced = new Set();

  window.addEventListener('UNSTABLE_editor:extensions', (e) => {
    try {
      const d = e.detail || {};
      const CM = d.CodeMirror;
      if (CM && CM.ViewPlugin && Array.isArray(d.extensions)) {
        d.extensions.push(CM.ViewPlugin.define((v) => {
          announced.add(v);
          return { destroy() { announced.delete(v); } };
        }));
      }
    } catch (err) { /* Overleaf changed this hook; the DOM search below still works */ }
  });

  const isView = (v) => !!(v && v.state && v.state.doc && typeof v.state.doc.toString === 'function' &&
    typeof v.dispatch === 'function' && v.dom && v.scrollDOM);

  /**
   * The EditorView of a .cm-editor, as EditorView.findFromDOM finds it:
   * recent CodeMirror versions keep a tile on .cm-content (cmTile, whose root
   * has the view), older ones a content view (cmView, whose rootView has it).
   */
  function viewOf(editor) {
    const content = editor.querySelector('.cm-content');
    if (!content) return null;
    const tile = content.cmTile;
    const cv = content.cmView;
    const candidates = [
      tile && tile.root && tile.root.view, tile && tile.view,
      cv && cv.rootView && cv.rootView.view, cv && cv.view, cv && cv.editorView,
    ];
    for (const v of candidates) if (isView(v)) return v;
    return null;
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r.width * r.height : 0;
  }

  /** The editor showing the open file: the biggest one on screen. */
  function findView() {
    const views = new Set();
    for (const v of announced) if (isView(v) && v.dom.isConnected) views.add(v);
    for (const ed of document.querySelectorAll('.cm-editor')) {
      const v = viewOf(ed);
      if (v) views.add(v);
    }
    let best = null;
    let bestArea = 0;
    for (const v of views) {
      const a = area(v.dom);
      if (a > bestArea) { best = v; bestArea = a; }
    }
    return best;
  }

  // --- the open file's name ---------------------------------------------------------

  const label = (el) => (el.getAttribute('aria-label') || '').trim() ||
    ((el.querySelector('.item-name-button, .name, button span') || el).textContent || '').trim();

  /** Its path in the project, from the file tree's selected item and the folders around it. */
  function fileName() {
    const sel = document.querySelector('.file-tree [role="treeitem"][aria-selected="true"], [role="tree"] [role="treeitem"][aria-selected="true"], .file-tree li.selected');
    if (sel) {
      const parts = [label(sel)];
      let el = sel.parentElement && sel.parentElement.closest('[role="treeitem"]');
      while (el) {
        parts.unshift(label(el));
        el = el.parentElement && el.parentElement.closest('[role="treeitem"]');
      }
      const path = parts.filter(Boolean).join('/');
      if (path) return path;
    }
    const crumbs = document.querySelector('.ol-cm-breadcrumbs, [class*="breadcrumbs"]');
    if (crumbs) {
      const parts = Array.from(crumbs.children).map((c) => c.textContent.trim()).filter((t) => t && !/^[›>/]$/.test(t));
      if (parts.length) return parts.join('/');
    }
    return '';
  }

  // --- talking to the preview ---------------------------------------------------------

  let helloFrom = null; // the preview's window, once it has said hello

  /** The preview's frame, once it has loaded and said hello (before that, its window is a blank page). */
  function frame() {
    const f = document.getElementById(FRAME_ID);
    return f && f.contentWindow && f.contentWindow === helloFrom ? f : null;
  }

  function send(msg, transfer) {
    const f = frame();
    if (!f) return false;
    let origin;
    try {
      origin = new URL(f.src).origin;
    } catch (e) {
      return false;
    }
    f.contentWindow.postMessage(Object.assign({ texglass: TAG }, msg), origin, transfer || []);
    return true;
  }

  let view = null;
  let lastDoc = null;
  let lastName = null;
  let lastCursor = -1;
  let lastTop = -1;
  let lastFind = 0;

  function current() {
    const now = Date.now();
    if (!view || !view.dom.isConnected || now - lastFind > 2000) {
      lastFind = now;
      const v = findView();
      if (v !== view) {
        view = v;
        lastDoc = null;
        lastTop = -1;
      }
    }
    return view;
  }

  /** The offset of the first line in view. */
  function topOffset(v) {
    try {
      const top = v.scrollDOM.getBoundingClientRect().top - v.documentTop;
      return v.lineBlockAtHeight(Math.max(0, top)).from;
    } catch (e) {
      return 0;
    }
  }

  function sendScroll(force) {
    const v = current();
    if (!v) return;
    const top = topOffset(v);
    if (force || top !== lastTop) {
      lastTop = top;
      send({ type: 'scroll', top });
    }
  }

  function tick(force) {
    const f = frame();
    if (!f || f.dataset.open !== '1') return;
    const v = current();
    if (!v) {
      if (force || lastDoc !== false) send({ type: 'no-editor' });
      lastDoc = false;
      return;
    }
    const doc = v.state.doc;
    const name = fileName();
    if (force || doc !== lastDoc || name !== lastName) {
      lastDoc = doc;
      lastName = name;
      send({ type: 'doc', text: doc.toString(), name });
    }
    const at = v.state.selection.main.head;
    if (force || at !== lastCursor) {
      lastCursor = at;
      send({ type: 'cursor', at });
    }
    sendScroll(force);
  }

  setInterval(() => tick(false), 200);

  // Scrolling the editor moves the preview along, once per frame.
  let scrollFrame = 0;
  document.addEventListener('scroll', (e) => {
    if (!view || e.target !== view.scrollDOM || scrollFrame) return;
    const f = frame();
    if (!f || f.dataset.open !== '1') return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      sendScroll(false);
    });
  }, { capture: true, passive: true });

  function jump(at) {
    const v = current();
    if (!v) return;
    const pos = Math.max(0, Math.min(v.state.doc.length, at | 0));
    const EV = v.constructor;
    try {
      v.dispatch({ selection: { anchor: pos }, effects: EV.scrollIntoView(pos, { y: 'center' }) });
    } catch (e) {
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    }
    v.focus();
  }

  async function loadFiles() {
    const m = location.pathname.match(/^\/project\/([0-9a-f]+)/i);
    if (!m) return send({ type: 'files-error', message: 'This page is not an Overleaf project.' });
    try {
      const res = await fetch(`/project/${m[1]}/download/zip`, { credentials: 'same-origin' });
      if (!res.ok) return send({ type: 'files-error', message: `Overleaf answered ${res.status} for the project's zip.` });
      const zip = await res.arrayBuffer();
      send({ type: 'files', zip }, [zip]);
    } catch (e) {
      send({ type: 'files-error', message: `Could not download the project's files (${e.message}).` });
    }
  }

  window.addEventListener('message', (e) => {
    const f = document.getElementById(FRAME_ID);
    const d = e.data;
    if (!f || !e.source || e.source !== f.contentWindow || !d || d.texglass !== TAG) return;
    if (d.type === 'hello') {
      helloFrom = e.source;
      tick(true);
    }
    else if (d.type === 'jump' && typeof d.at === 'number') jump(d.at);
    else if (d.type === 'load-files') loadFiles();
  });
})();
