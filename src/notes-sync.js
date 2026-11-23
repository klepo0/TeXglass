/*
 * The reader's highlights and notes (src/margin.js) as a portable file, and
 * their sync between devices through a private GitHub gist.
 *
 * One paper's notes are a small JSON file:
 *
 *   { "about": "...", "version": 1, "paper": "arxiv:2301.00001", "title": "...",
 *     "notes": [ { id, anchor: { quote, prefix, suffix, file, line }, color?, note?, created, updated? } ],
 *     "deleted": { "<id>": "<when>" } }
 *
 * The paper key names the paper on every device: "arxiv:<id>" (no version, so
 * notes carry over to a revision), "github:<owner>/<repo>/<path>", or, for a
 * .tex file, "tex:<file name>" plus a hash of its \title when it has one.
 * Notes are anchored by the text they mark, not by a position, so they find
 * their place again in a revised paper (see margin.js).
 *
 * The reader's reading progress on the paper's results (src/progress.js) rides
 * along in the same record, as "progress": { "<result key>": { s, q, t } }, with
 * s the status (unread, skimmed, read, understood), q the "?" flag and t when it
 * was set. Results are keyed by their \label, so progress survives a revision.
 * Two copies are merged result by result: the later setting wins.
 *
 * The reader's changes to the dependency map (src/insight.js) ride along too,
 * as "map": { pos, pin, hide, link, view, note }, each keyed like progress (a result's
 * key, "cite:…" for a cited work, "eq:(3.4)" for a numbered equation; a link
 * is "<from> > <to>", an arrow from the result used to the one using it):
 *   pos:  { key: { x, y, t } }       where the reader dragged it (no x: back in place)
 *   pin:  { key: { d, t } }          pinned: d 'self', 'uses', 'usedBy', 'both' ('' unpinned)
 *   hide: { key: { h, t } }          hidden from the map (h false: shown again)
 *   link: { "a > b": { s, t } }      s 'add' (the reader's own arrow), 'del' (a link
 *                                    of the paper taken away) or '' (as the paper has it)
 *   view: { name: { p, s, x, o, t } } a pin set: p the map's pins { key: d } (null: deleted),
 *                                    s pinned Notation rows, x ids of pinned passages,
 *                                    o the reading order (keys)
 *   note: { key: { n, o, t } }       a pin's one-line note n and place o in the reading
 *                                    order (any pinned thing: "m:…" a Notation row, "text:<id>" a passage)
 * Two copies are merged entry by entry, the later one winning, as for progress.
 *
 * Two copies of a paper's notes are merged by note id: of two versions of a
 * note the later one wins, and a deleted note stays deleted (the "deleted"
 * list remembers it), so nothing is lost when two devices edit at once.
 *
 * The gist holds every paper in one file, texglass-notes.json:
 *   { "about": "...", "version": 1, "papers": { "<key>": { title, notes, deleted } } }
 * It is created on the first sync, private, in the reader's own GitHub account.
 * No server of ours is involved: the browser (or VS Code) talks to
 * api.github.com with the reader's own token.
 *
 * Works in browsers, the VS Code extension host and Node 18+ (fetch).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassNotesSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const GIST_FILE = 'texglass-notes.json';
  const GIST_DESCRIPTION = 'TeXglass notes (highlights and notes made in TeXglass; private)';
  const API = 'https://api.github.com';
  const KEEP_DELETED_DAYS = 180; // how long a deletion is remembered, so it reaches every device

  // --- naming a paper ----------------------------------------------------------------------

  /** A short, stable hash of a string (FNV-1a, 32 bits, as 8 hex digits). */
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** The text of the first \title{...} in a LaTeX source, with spaces tidied, or ''. */
  function titleOf(source) {
    const s = String(source || '');
    const m = /\\title\s*(?:\[[^\]]*\]\s*)?\{/.exec(s);
    if (!m) return '';
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < s.length && depth; i++) {
      if (s[i] === '\\') i++;
      else if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
    }
    return s.slice(start, i - 1).replace(/%[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * The key that names a paper on every device, or null when its notes should
   * not be kept (nothing open, the welcome page).
   *   { arxiv: '2301.00001v2' } -> 'arxiv:2301.00001'
   *   { github: 'owner/repo/path/main.tex' } -> 'github:owner/repo/path/main.tex'
   *   { name: 'paper.tex', source } -> 'tex:paper.tex#<hash of its title>' (or 'tex:paper.tex')
   * A name like the web viewer's 'arXiv-2301.00001v2.tex' counts as arXiv too.
   */
  function paperKey(info) {
    const o = info || {};
    let id = o.arxiv || '';
    const name = String(o.name || '').split(/[\\/]/).pop();
    if (!id) {
      const m = /^arXiv-(.+)\.tex$/i.exec(name);
      if (m) id = m[1];
    }
    if (id) return 'arxiv:' + String(id).replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '').replace(/\//g, '-').toLowerCase();
    if (o.github) return 'github:' + String(o.github).replace(/^\/+/, '');
    if (!name || name === 'welcome.tex') return null;
    const title = titleOf(o.source);
    return 'tex:' + name + (title ? '#' + hash(title) : '');
  }

  // --- one paper's notes -------------------------------------------------------------------

  const isNote = (a) => a && typeof a.id === 'string' && a.anchor && typeof a.anchor === 'object';
  const when = (a) => Date.parse((a && (a.updated || a.created)) || '') || 0;
  const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  /** A note without its 'updated' stamp, for comparing contents. */
  function strip(a) {
    const o = Object.assign({}, a);
    delete o.updated;
    return o;
  }

  /** An empty record for a paper. */
  function empty(key, title) {
    return { paper: key || null, title: title || '', notes: [], deleted: {}, progress: {}, map: {} };
  }

  // --- reading progress --------------------------------------------------------------------

  const STATUSES = ['unread', 'skimmed', 'read', 'understood'];
  const isMark = (m) => m && typeof m === 'object' && STATUSES.includes(m.s || 'unread');

  /** A progress map with only well-formed entries. */
  function cleanProgress(p) {
    const out = {};
    if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
    for (const [k, m] of Object.entries(p)) {
      if (!k || !isMark(m)) continue;
      const e = { s: m.s || 'unread' };
      if (m.q) e.q = true;
      if (m.t) e.t = String(m.t);
      out[k] = e;
    }
    return out;
  }

  /** Two progress maps merged result by result: the later setting wins. */
  function mergeProgress(a, b) {
    const out = cleanProgress(a);
    for (const [k, m] of Object.entries(cleanProgress(b))) {
      const had = out[k];
      if (!had || (Date.parse(m.t || '') || 0) > (Date.parse(had.t || '') || 0)) out[k] = m;
    }
    return out;
  }

  /** Whether a record holds any reading progress worth keeping. */
  const hasProgress = (r) => !!(r && r.progress && Object.keys(r.progress).length);

  // --- the reader's changes to the dependency map ---------------------------------------------

  const PIN_DIRS = ['', 'self', 'uses', 'usedBy', 'both'];
  const LINK_STATES = ['', 'add', 'del'];
  const NOTE_MAX = 200; // a pin's note: one line
  /** Each part of the map's changes: how to clean one entry (null drops it). */
  const MAP_PARTS = {
    pos: (e) => (Number.isFinite(e.x) && Number.isFinite(e.y) ? { x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10 } : {}),
    pin: (e) => (PIN_DIRS.includes(e.d || '') ? { d: e.d || '' } : null),
    hide: (e) => ({ h: !!e.h }),
    link: (e, k) => (LINK_STATES.includes(e.s || '') && / > /.test(k) ? { s: e.s || '' } : null),
    // a pin set (a saved map): p the map's pins { key: d }, s the Notation tab's pinned rows,
    // x the ids of pinned passages (notes), o the reading order (keys); { p: null } once deleted
    view: (e) => {
      if (!e.p || typeof e.p !== 'object' || Array.isArray(e.p)) return { p: null };
      const p = {};
      for (const [k, d] of Object.entries(e.p)) if (k && PIN_DIRS.includes(d) && d) p[k] = d;
      const out = { p };
      for (const f of ['s', 'x', 'o']) {
        if (Array.isArray(e[f])) out[f] = Array.from(new Set(e[f].filter((k) => typeof k === 'string' && k && k.length <= 300))).slice(0, 500);
      }
      return out;
    },
    // a pin's place in the reading order (o) and its one-line note (n)
    note: (e) => {
      const n = typeof e.n === 'string' ? e.n.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '';
      return { n, o: Number.isFinite(e.o) ? e.o : null };
    },
  };

  /** The map's changes with only well-formed entries: { pos, pin, hide, link, view, note }, parts left out when empty. */
  function cleanMap(m) {
    const out = {};
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    for (const [part, clean] of Object.entries(MAP_PARTS)) {
      const src = m[part];
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      const kept = {};
      for (const [k, e] of Object.entries(src)) {
        if (!k || !e || typeof e !== 'object') continue;
        const c = clean(e, k);
        if (!c) continue;
        if (e.t) c.t = String(e.t);
        kept[k] = c;
      }
      if (Object.keys(kept).length) out[part] = kept;
    }
    return out;
  }

  /** Two copies of the map's changes merged entry by entry: the later one wins. */
  function mergeMap(a, b) {
    const out = cleanMap(a);
    const other = cleanMap(b);
    for (const part of Object.keys(MAP_PARTS)) {
      if (!other[part]) continue;
      const into = out[part] || (out[part] = {});
      for (const [k, e] of Object.entries(other[part])) {
        const had = into[k];
        if (!had || (Date.parse(e.t || '') || 0) > (Date.parse(had.t || '') || 0)) into[k] = e;
      }
    }
    return out;
  }

  /** Whether a record holds changes to the map worth keeping. */
  const hasMap = (r) => !!(r && r.map && Object.keys(cleanMap(r.map)).length);
  /** Whether a record holds anything worth keeping: notes, deletions, progress or map changes. */
  const isEmpty = (r) => !r || (!(r.notes || []).length && !Object.keys(r.deleted || {}).length && !hasProgress(r) && !hasMap(r));

  /**
   * After the reader changed the notes (margin.js save(list)): the paper's new
   * record. Notes that are new or changed get updated = now; notes that went
   * away are remembered as deleted.
   */
  function track(record, list, now) {
    const t = (now || new Date()).toISOString();
    const prev = new Map(((record && record.notes) || []).map((a) => [a.id, a]));
    const deleted = Object.assign({}, (record && record.deleted) || {});
    const notes = [];
    for (const a of (list || []).filter(isNote)) {
      const old = prev.get(a.id);
      prev.delete(a.id);
      if (old && same(old, a)) notes.push(Object.assign({}, a, old.updated ? { updated: old.updated } : {}));
      else notes.push(Object.assign({}, a, { updated: t }));
      delete deleted[a.id];
    }
    for (const [id, a] of prev) {
      // ticks of the hypothesis checker are not the margin's to remove (see setCheck)
      if (isCheck(a)) notes.push(a);
      else deleted[id] = t;
    }
    return Object.assign({}, record || empty(), { notes, deleted });
  }

  /** A tick of the hypothesis checker (src/hypotheses.js), kept with the notes so it syncs with them. */
  const isCheck = (a) => !!(a && a.kind === 'check');

  /**
   * The paper's record with one hypothesis ticked (on) or unticked. A tick is
   * a note { id, kind: 'check', anchor: { result, quote, at }, created }: the
   * margin leaves it alone, and it merges and syncs like any note. `info`:
   * { result, text, at } from the checker, to read the file by.
   */
  function setCheck(record, id, on, info, now) {
    const t = (now || new Date()).toISOString();
    const r = Object.assign({}, record || empty());
    const notes = (r.notes || []).filter((a) => a.id !== id);
    const deleted = Object.assign({}, r.deleted || {});
    const had = (r.notes || []).some((a) => a.id === id);
    if (on) {
      const i = info || {};
      notes.push({ id, kind: 'check', anchor: { result: String(i.result || ''), quote: String(i.text || '').slice(0, 300), at: String(i.at || '') }, created: t, updated: t });
      delete deleted[id];
    } else if (had) deleted[id] = t;
    return Object.assign(r, { notes, deleted });
  }

  /** The ids of the ticks in a record (or a list of notes). */
  function checks(record) {
    const list = Array.isArray(record) ? record : (record && record.notes) || [];
    return new Set(list.filter(isCheck).map((a) => a.id));
  }

  // --- clearing --------------------------------------------------------------------------------

  /** What can be cleared: the margin's notes, the reader's pins and map, their progress. */
  const CLEAR_PARTS = ['notes', 'pins', 'progress'];

  /** Whether a key names a paper (the gist also keeps the saved-papers list, "library"). */
  const isPaperKey = (k) => /^(arxiv|github|tex):/.test(String(k || ''));

  /** A map entry put back as if the reader had never touched it. */
  const NEUTRAL = {
    pos: () => ({}),
    pin: () => ({ d: '' }),
    hide: () => ({ h: false }),
    link: () => ({ s: '' }),
    view: () => ({ p: null }),
    note: () => ({ n: '', o: null }),
  };

  /**
   * The record with what the reader made cleared (Settings → Clear notes):
   *   parts.notes     highlights, notes, handwritten notes and pinned passages
   *   parts.pins      pins, pin sets, the reading order and pin notes, and every
   *                   other change to the dependency map (pinned passages are
   *                   unpinned, their highlight stays unless notes go too)
   *   parts.progress  reading progress and ticked hypotheses
   * (all three when parts is left out). Nothing is simply dropped: notes are
   * remembered as deleted and map and progress entries are set back to "as the
   * paper has it", stamped now, so the clearing wins every merge and reaches every
   * device through sync, also ones on an older TeXglass. Anything changed after
   * `now` (it came from another device meanwhile) is left alone.
   */
  function clear(record, parts, now) {
    const want = (p) => !parts || !!parts[p];
    const d = now || new Date();
    const t = d.toISOString();
    const at = d.getTime();
    const r = Object.assign(empty(), record || {});
    const newer = (e) => (Date.parse((e && e.t) || '') || 0) > at;
    const deleted = Object.assign({}, r.deleted || {});
    const notes = [];
    for (const a of (r.notes || []).filter(isNote)) {
      const gone = isCheck(a) ? want('progress') : want('notes');
      if (when(a) > at) notes.push(a);
      else if (gone) deleted[a.id] = t;
      else if (a.pin && want('pins')) {
        const b = Object.assign({}, a, { updated: t });
        delete b.pin;
        notes.push(b);
      } else notes.push(a);
    }
    let progress = cleanProgress(r.progress);
    if (want('progress')) {
      const out = {};
      for (const [k, m] of Object.entries(progress)) out[k] = newer(m) ? m : { s: 'unread', t };
      progress = out;
    }
    let map = cleanMap(r.map);
    if (want('pins')) {
      const out = {};
      for (const [part, entries] of Object.entries(map)) {
        out[part] = {};
        for (const [k, e] of Object.entries(entries)) out[part][k] = newer(e) ? e : Object.assign(NEUTRAL[part](), { t });
      }
      map = out;
    }
    return Object.assign(r, { notes, deleted, progress, map });
  }

  /**
   * How much the reader made on a paper, to say what clearing takes away:
   * { notes, pins, sets, progress, checks, map } (map: results moved, hidden or linked on the map).
   */
  function counts(record) {
    const r = record || {};
    const list = (r.notes || []).filter(isNote);
    const map = cleanMap(r.map);
    const textPins = list.filter((a) => a.pin && !isCheck(a)).length;
    return {
      notes: list.filter((a) => !isCheck(a)).length,
      pins: Object.values(map.pin || {}).filter((e) => e.d).length + textPins,
      sets: Object.values(map.view || {}).filter((e) => e.p).length,
      progress: Object.values(cleanProgress(r.progress)).filter((m) => m.s !== 'unread' || m.q).length,
      checks: list.filter(isCheck).length,
      map: ['pos', 'hide', 'link'].reduce((n, part) => n + Object.values(map[part] || {}).filter((e) => !neutral(part, e)).length, 0),
    };
  }

  /** Whether a map entry is "as the paper has it". */
  const neutral = (part, e) => JSON.stringify(Object.assign({}, e, { t: undefined })) === JSON.stringify(NEUTRAL[part]());

  /**
   * Whether a record holds nothing the reader would see: no notes, and its map
   * and progress only "as the paper has it" (left by clearing). Its deletions
   * still matter to sync, but a file of it is not worth keeping.
   */
  function isBlank(r) {
    if (!r || (r.notes || []).some(isNote)) return false;
    const c = counts(r);
    if (c.progress) return false;
    const map = cleanMap(r.map);
    return Object.entries(map).every(([part, entries]) => Object.values(entries).every((e) => neutral(part, e)));
  }

  /** Forget deletions older than KEEP_DELETED_DAYS. */
  function prune(deleted, now) {
    const limit = (now ? now.getTime() : Date.now()) - KEEP_DELETED_DAYS * 864e5;
    const out = {};
    for (const [id, t] of Object.entries(deleted || {})) if ((Date.parse(t) || 0) >= limit) out[id] = t;
    return out;
  }

  /**
   * Two records of the same paper merged by note id: the later version of a
   * note wins, and a note deleted after its last change stays deleted.
   */
  function merge(a, b, now) {
    a = a || empty();
    b = b || empty();
    const deleted = Object.assign({}, a.deleted);
    for (const [id, t] of Object.entries(b.deleted || {})) {
      if (!deleted[id] || Date.parse(t) > Date.parse(deleted[id])) deleted[id] = t;
    }
    const byId = new Map();
    const order = [];
    for (const n of [...(a.notes || []), ...(b.notes || [])].filter(isNote)) {
      const had = byId.get(n.id);
      if (!had) order.push(n.id);
      if (!had || when(n) > when(had)) byId.set(n.id, n);
    }
    const notes = [];
    for (const id of order) {
      const n = byId.get(id);
      const gone = deleted[id];
      if (gone && (Date.parse(gone) || 0) >= when(n)) continue;
      if (gone) delete deleted[id]; // changed again after it was deleted elsewhere: keep it
      notes.push(n);
    }
    return {
      paper: a.paper || b.paper || null,
      title: a.title || b.title || '',
      notes,
      deleted: prune(deleted, now),
      progress: mergeProgress(a.progress, b.progress),
      map: mergeMap(a.map, b.map),
    };
  }

  /** Whether two records hold the same notes and deletions. */
  function equal(a, b) {
    const norm = (r) => JSON.stringify({
      notes: ((r && r.notes) || []).slice().sort((x, y) => (x.id < y.id ? -1 : 1)),
      deleted: Object.keys((r && r.deleted) || {}).sort(),
      progress: Object.entries(cleanProgress(r && r.progress)).sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      map: sortedMap(r && r.map),
    });
    return norm(a) === norm(b);
  }

  /** The map's changes as sorted entries, for comparing. */
  function sortedMap(m) {
    const c = cleanMap(m);
    return Object.keys(c).sort().map((part) => [part, Object.entries(c[part]).sort((x, y) => (x[0] < y[0] ? -1 : 1))]);
  }

  // --- the file ----------------------------------------------------------------------------

  /** The JSON text of one paper's notes, for export (and VS Code's paper.texglass.json). */
  function toFile(record, about) {
    const r = record || empty();
    const out = {
      about: about || 'Highlights and notes made in TeXglass, anchored to the text of the paper. Import this file in TeXglass to see them again.',
      version: VERSION,
      paper: r.paper || undefined,
      title: r.title || undefined,
      notes: r.notes || [],
    };
    if (r.deleted && Object.keys(r.deleted).length) out.deleted = r.deleted;
    if (hasProgress(r)) out.progress = cleanProgress(r.progress);
    if (hasMap(r)) out.map = cleanMap(r.map);
    return JSON.stringify(out, null, 2) + '\n';
  }

  /**
   * The papers in a notes file's text: { key: record }. Reads one paper's file
   * (the key is its "paper", or `fallbackKey`), a bare list of notes, and the
   * gist's file with many papers. Throws on text that is not a notes file.
   */
  function parseFile(text, fallbackKey) {
    const data = JSON.parse(text);
    const out = {};
    const one = (key, d) => {
      const notes = (Array.isArray(d) ? d : (d && Array.isArray(d.notes) ? d.notes : [])).filter(isNote);
      const deleted = d && !Array.isArray(d) && d.deleted && typeof d.deleted === 'object' ? Object.assign({}, d.deleted) : {};
      const title = d && !Array.isArray(d) && typeof d.title === 'string' ? d.title : '';
      const progress = d && !Array.isArray(d) ? cleanProgress(d.progress) : {};
      const map = d && !Array.isArray(d) ? cleanMap(d.map) : {};
      return { paper: key || null, title, notes, deleted, progress, map };
    };
    if (data && !Array.isArray(data) && data.papers && typeof data.papers === 'object') {
      for (const [k, d] of Object.entries(data.papers)) out[k] = one(k, d);
      return out;
    }
    if (Array.isArray(data) || (data && (Array.isArray(data.notes) || (data.progress && typeof data.progress === 'object') || (data.map && typeof data.map === 'object')))) {
      const key = (!Array.isArray(data) && typeof data.paper === 'string' && data.paper) || fallbackKey || '';
      out[key] = one(key || null, data);
      return out;
    }
    throw new Error('This is not a TeXglass notes file.');
  }

  /** The gist's file text for many papers. Papers with neither notes nor deletions are left out. */
  function toStore(papers) {
    const out = {};
    for (const k of Object.keys(papers || {}).sort()) {
      const r = papers[k];
      if (isEmpty(r)) continue;
      out[k] = { title: r.title || undefined, notes: r.notes || [] };
      if (Object.keys(r.deleted || {}).length) out[k].deleted = r.deleted;
      if (hasProgress(r)) out[k].progress = cleanProgress(r.progress);
      if (hasMap(r)) out[k].map = cleanMap(r.map);
    }
    return JSON.stringify({
      about: 'Highlights and notes made in TeXglass, by paper. Kept here by TeXglass to sync them between your devices.',
      version: VERSION,
      papers: out,
    }, null, 1) + '\n';
  }

  // --- the gist ----------------------------------------------------------------------------

  /**
   * A private gist holding texglass-notes.json, reached with the reader's token
   * (a GitHub token allowed to use gists). opts.fetch replaces fetch (tests);
   * opts.gistId: the gist found before, to skip looking for it.
   */
  function gist(token, opts) {
    const o = opts || {};
    const doFetch = o.fetch || (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
    let id = o.gistId || null;

    async function call(method, path, body) {
      let res;
      try {
        res = await doFetch(API + path, {
          method,
          headers: Object.assign({
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer ' + token,
            'X-GitHub-Api-Version': '2022-11-28',
          }, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        });
      } catch (e) {
        throw new Error('Could not reach GitHub. Check your connection.');
      }
      if (res.status === 401) throw Object.assign(new Error('GitHub did not accept the token. Sign in again.'), { auth: true });
      if (res.status === 403 || res.status === 404) {
        const err = new Error(path.startsWith('/gists/') && res.status === 404
          ? 'The notes gist is gone.'
          : 'GitHub refused (' + res.status + '). The token needs permission to use gists.');
        err.status = res.status;
        if (res.status === 403) err.auth = true;
        throw err;
      }
      if (!res.ok) throw new Error('GitHub answered ' + res.status + '.');
      return res.status === 204 ? null : res.json();
    }

    /** The id of the notes gist: found among the reader's gists, or made now. */
    async function find() {
      if (id) return id;
      for (let page = 1; page <= 10; page++) {
        const list = await call('GET', '/gists?per_page=100&page=' + page);
        const hit = (list || []).find((g) => g.files && g.files[GIST_FILE]);
        if (hit) return (id = hit.id);
        if (!list || list.length < 100) break;
      }
      const made = await call('POST', '/gists', {
        description: GIST_DESCRIPTION,
        public: false,
        files: { [GIST_FILE]: { content: toStore({}) } },
      });
      return (id = made.id);
    }

    /** Every paper in the gist: { key: record }. */
    async function read() {
      let g;
      try {
        g = await call('GET', '/gists/' + (await find()));
      } catch (e) {
        if (e.status !== 404 || !id) throw e;
        id = null; // deleted on GitHub: look again (or make a new one)
        g = await call('GET', '/gists/' + (await find()));
      }
      const f = g.files && g.files[GIST_FILE];
      if (!f) return {};
      let text = f.content || '';
      if (f.truncated && f.raw_url) {
        const res = await doFetch(f.raw_url, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
        text = await res.text();
      }
      try {
        return parseFile(text);
      } catch (e) {
        return {};
      }
    }

    /** Replace the gist's file with these papers. */
    async function write(papers) {
      await call('PATCH', '/gists/' + (await find()), { files: { [GIST_FILE]: { content: toStore(papers) } } });
    }

    /**
     * Merge `local` (one paper's record, or { key: record } when `key` is null)
     * with the gist and write back what changed. Resolves to the merged
     * record(s), to keep locally.
     */
    async function sync(key, local) {
      const all = await read();
      const mine = key == null ? local || {} : { [key]: local };
      let changed = false;
      const out = {};
      for (const [k, r] of Object.entries(mine)) {
        const merged = merge(all[k], Object.assign({}, r, { paper: k }));
        if (!equal(merged, all[k] || empty())) changed = true;
        all[k] = out[k] = merged;
      }
      if (changed) await write(all);
      return key == null ? out : out[key];
    }

    return { find, read, write, sync, id: () => id };
  }

  return { VERSION, GIST_FILE, STATUSES, CLEAR_PARTS, paperKey, isPaperKey, clear, counts, isBlank, titleOf, hash, empty, track, setCheck, checks, isCheck, merge, mergeProgress, cleanProgress, mergeMap, cleanMap, isEmpty, equal, toFile, parseFile, toStore, gist };
});
