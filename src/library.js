/*
 * The reader's library: papers saved for offline reading.
 *
 * A saved paper is kept whole on this device, in IndexedDB (database
 * "texglass-library", store "papers"): its LaTeX source with \input files
 * already inlined, its figures as Blobs, and where it came from, so it opens
 * with no connection, figures and all.
 *
 *   { key, title, name, source, images: { path: Blob }, arxiv?, gh?, saved, bytes }
 *
 * The key is the paper's notes key (src/notes-sync.js paperKey): "arxiv:<id>",
 * "github:<owner>/<repo>/<path>" or "tex:<name>#<hash>".
 *
 * The list of saved papers (not their contents) can follow the reader to their
 * other devices through the notes gist. It rides there as one more record, under
 * the key "library", whose "notes" are the saved papers:
 *
 *   { id: "<paper key>", kind: "saved", anchor: { title, arxiv?, gh? }, created, updated }
 *
 * so it merges like notes do: a paper saved on two devices is saved once, and a
 * paper removed on one device is removed from the list everywhere (each device
 * keeps or drops its own copy). A paper saved on another device shows in the
 * list with a Download button when it came from arXiv or GitHub.
 *
 * Works in browsers; the list functions also in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassLibrary = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIST_KEY = 'library';
  const DB = 'texglass-library';
  const STORE = 'papers';

  // --- the synced list ---------------------------------------------------------------------

  /** An empty list record (shaped like a paper's notes record, see notes-sync.js). */
  function emptyList() {
    return { paper: LIST_KEY, title: 'Saved papers', notes: [], deleted: {}, progress: {} };
  }

  const isEntry = (n) => n && typeof n.id === 'string' && n.kind === 'saved' && n.anchor && typeof n.anchor === 'object';

  /** What the list keeps of a saved paper: enough to show it and download it again. */
  function anchorOf(info) {
    const a = { title: String((info && info.title) || '').slice(0, 300) };
    if (info && info.arxiv) a.arxiv = String(info.arxiv);
    if (info && info.gh && typeof info.gh === 'string') a.gh = info.gh;
    return a;
  }

  /** The list with this paper on it ({ key, title, arxiv?, gh? }). */
  function addEntry(list, info, now) {
    const t = (now || new Date()).toISOString();
    const r = Object.assign(emptyList(), list || {});
    const had = (r.notes || []).find((n) => n.id === info.key);
    const anchor = anchorOf(info);
    if (had && JSON.stringify(had.anchor) === JSON.stringify(anchor)) return r;
    const notes = (r.notes || []).filter((n) => n.id !== info.key);
    notes.push({ id: info.key, kind: 'saved', anchor, created: (had && had.created) || t, updated: t });
    const deleted = Object.assign({}, r.deleted);
    delete deleted[info.key];
    return Object.assign(r, { notes, deleted });
  }

  /** The list without this paper (remembered as removed, so that reaches other devices). */
  function removeEntry(list, key, now) {
    const t = (now || new Date()).toISOString();
    const r = Object.assign(emptyList(), list || {});
    if (!(r.notes || []).some((n) => n.id === key)) return r;
    return Object.assign(r, {
      notes: r.notes.filter((n) => n.id !== key),
      deleted: Object.assign({}, r.deleted, { [key]: t }),
    });
  }

  /** The papers on the list, most recently saved first: [{ key, title, arxiv?, gh?, saved }]. */
  function entries(list) {
    return ((list && list.notes) || []).filter(isEntry)
      .map((n) => Object.assign({ key: n.id, saved: n.created }, n.anchor))
      .sort((a, b) => (Date.parse(b.saved) || 0) - (Date.parse(a.saved) || 0));
  }

  // --- naming and sizing -------------------------------------------------------------------

  /**
   * A paper's \title as a line of text for the list: footnotes, \thanks and line
   * breaks dropped, simple font commands unwrapped; $math$ is left for the page
   * to render.
   */
  function plainTitle(title) {
    let s = String(title || '');
    // drop \thanks{…}, \footnote{…} and their (balanced) argument
    for (;;) {
      const m = /\\(?:thanks|footnote|footnotemark|label)\s*(?:\[[^\]]*\]\s*)?\{/.exec(s);
      if (!m) break;
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < s.length && depth; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === '{') depth++;
        else if (s[i] === '}') depth--;
      }
      s = s.slice(0, m.index) + s.slice(i);
    }
    // outside $…$: line breaks and font commands go, braces too
    return s.split(/(\$[^$]*\$)/).map((part, i) => {
      if (i % 2) return part;
      return part
        .replace(/\\\\(\[[^\]]*\])?|\\newline\b/g, ' ')
        .replace(/\\(?:textbf|textit|emph|textsc|textrm|textsf|texttt|mbox|text|bf|it|sc|rm|large|Large|LARGE|huge|Huge|bfseries|itshape|scshape|normalfont)\b\s*/g, '')
        .replace(/~/g, ' ')
        .replace(/\\&/g, '&')
        .replace(/[{}]/g, '');
    }).join('').replace(/\s+/g, ' ').trim();
  }

  /** The bytes a saved paper takes: its source and its figures. */
  function sizeOf(rec) {
    let n = String((rec && rec.source) || '').length;
    for (const b of Object.values((rec && rec.images) || {})) n += (b && b.size) || 0;
    return n;
  }

  /** 1234567 -> '1.2 MB'. */
  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  // --- the papers on this device (IndexedDB) -----------------------------------------------

  /**
   * The saved papers on this device. Resolves to null where IndexedDB is not
   * available (private windows in some browsers, the Node tests).
   */
  function open(idb) {
    const factory = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!factory) return Promise.resolve(null);
    return new Promise((resolve) => {
      let req;
      try {
        req = factory.open(DB, 1);
      } catch (e) {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(wrap(req.result));
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  function wrap(db) {
    const run = (mode, fn) => new Promise((resolve, reject) => {
      let out;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || new Error('Could not use the saved papers.'));
      tx.onabort = () => reject(tx.error || new Error('Could not save: the device may be out of space.'));
    });
    return {
      /** Keep a paper (replacing an older copy). */
      put: (rec) => run('readwrite', (s) => s.put(Object.assign({}, rec, { bytes: sizeOf(rec) }))),
      /** One saved paper, or undefined. */
      get: (key) => run('readonly', (s) => s.get(key)),
      /** Every saved paper on this device. */
      all: () => run('readonly', (s) => s.getAll()).then((list) => list || []),
      /** The keys of the saved papers on this device. */
      keys: () => run('readonly', (s) => s.getAllKeys()).then((list) => list || []),
      remove: (key) => run('readwrite', (s) => s.delete(key)),
    };
  }

  return { LIST_KEY, emptyList, addEntry, removeEntry, entries, plainTitle, sizeOf, formatSize, open };
});
