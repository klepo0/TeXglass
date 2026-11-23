/*
 * Collections: pins gathered from several papers, for a talk or a literature
 * review ("Results on mixing times": Theorem 2 of one paper, Lemma 4.1 of
 * another). A collection is named; each of its items names a paper and a
 * pinned result, equation, figure or proof in it:
 *
 *   { id, c (the collection), paper (its notes key), title, arxiv?, gh?,
 *     key (the pin's key in that paper), name ("Theorem 2"), note, o (order) }
 *
 * All collections live in one list that follows the reader to their other
 * devices through the notes gist, like the saved-papers list (src/library.js):
 * one more record, under the key "collections", whose "notes" are the items:
 *
 *   { id: "<collection>|<paper key>|<pin key>", kind: "collect", anchor: { … }, created, updated }
 *
 * so it merges like notes do: an item added on two devices is there once, and
 * one taken out on one device is gone everywhere.
 *
 * Works in browsers (window.TeXglassCollections) and in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassCollections = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIST_KEY = 'collections';

  /** An empty list record (shaped like a paper's notes record, see notes-sync.js). */
  function emptyList() {
    return { paper: LIST_KEY, title: 'Collections', notes: [], deleted: {}, progress: {} };
  }
  const isItem = (n) => n && typeof n.id === 'string' && n.kind === 'collect' && n.anchor && typeof n.anchor.c === 'string' && typeof n.anchor.key === 'string';
  const idOf = (c, paper, key) => `${c}|${paper}|${key}`;
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  /**
   * The list with these items in collection c (added at its end, in this order).
   * items: [{ paper, title, arxiv?, gh?, key, name, note }]. Items already in it
   * keep their place, with the name and note brought up to date.
   */
  function add(list, c, items, now) {
    c = clip(c, 80);
    const r = Object.assign(emptyList(), list || {});
    if (!c || !items || !items.length) return r;
    const t = (now || new Date()).toISOString();
    const notes = (r.notes || []).slice();
    const deleted = Object.assign({}, r.deleted);
    let last = notes.filter(isItem).filter((n) => n.anchor.c === c).reduce((m, n) => Math.max(m, Number(n.anchor.o) || 0), 0);
    for (const it of items) {
      if (!it || !it.paper || !it.key) continue;
      const id = idOf(c, it.paper, it.key);
      const i = notes.findIndex((n) => n.id === id);
      const had = i >= 0 ? notes[i] : null;
      const anchor = { c, paper: String(it.paper), title: clip(it.title, 300), key: String(it.key), name: clip(it.name, 120), note: clip(it.note, 200), o: had ? had.anchor.o : ++last };
      if (it.arxiv) anchor.arxiv = String(it.arxiv);
      if (it.gh && typeof it.gh === 'string') anchor.gh = it.gh;
      if (had && JSON.stringify(had.anchor) === JSON.stringify(anchor)) continue;
      const n = { id, kind: 'collect', anchor, created: (had && had.created) || t, updated: t };
      if (had) notes[i] = n; else notes.push(n);
      delete deleted[id];
    }
    return Object.assign(r, { notes, deleted });
  }

  /** The list without these items (by id; remembered as removed, so that reaches other devices). */
  function remove(list, ids, now) {
    const t = (now || new Date()).toISOString();
    const r = Object.assign(emptyList(), list || {});
    const gone = new Set((ids || []).filter((id) => (r.notes || []).some((n) => n.id === id)));
    if (!gone.size) return r;
    const deleted = Object.assign({}, r.deleted);
    for (const id of gone) deleted[id] = t;
    return Object.assign(r, { notes: r.notes.filter((n) => !gone.has(n.id)), deleted });
  }

  /** The list without a whole collection. */
  function removeCollection(list, c, now) {
    return remove(list, items(list, c).map((x) => x.id), now);
  }

  /** One collection's items, in its order: [{ id, c, paper, title, arxiv?, gh?, key, name, note, o }]. */
  function items(list, c) {
    return ((list && list.notes) || []).filter(isItem).filter((n) => n.anchor.c === c)
      .map((n) => Object.assign({ id: n.id }, n.anchor))
      .sort((a, b) => (Number(a.o) || 0) - (Number(b.o) || 0));
  }

  /** The item with this id, or null. */
  function byId(list, id) {
    const n = ((list && list.notes) || []).find((x) => x.id === id && isItem(x));
    return n ? Object.assign({ id: n.id }, n.anchor) : null;
  }

  /** The collections: [{ name, size, papers (how many papers) }], by name. */
  function names(list) {
    const by = new Map();
    for (const n of ((list && list.notes) || []).filter(isItem)) {
      const x = by.get(n.anchor.c) || { name: n.anchor.c, size: 0, papers: new Set() };
      x.size++;
      x.papers.add(n.anchor.paper);
      by.set(n.anchor.c, x);
    }
    return Array.from(by.values()).sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ name: x.name, size: x.size, papers: x.papers.size }));
  }

  return { LIST_KEY, emptyList, add, remove, removeCollection, items, byId, names, idOf };
});
