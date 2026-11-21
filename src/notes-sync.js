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
    return { paper: key || null, title: title || '', notes: [], deleted: {}, progress: {} };
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
  /** Whether a record holds anything worth keeping: notes, deletions or progress. */
  const isEmpty = (r) => !r || (!(r.notes || []).length && !Object.keys(r.deleted || {}).length && !hasProgress(r));

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
    };
  }

  /** Whether two records hold the same notes and deletions. */
  function equal(a, b) {
    const norm = (r) => JSON.stringify({
      notes: ((r && r.notes) || []).slice().sort((x, y) => (x.id < y.id ? -1 : 1)),
      deleted: Object.keys((r && r.deleted) || {}).sort(),
      progress: Object.entries(cleanProgress(r && r.progress)).sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    });
    return norm(a) === norm(b);
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
      return { paper: key || null, title, notes, deleted, progress };
    };
    if (data && !Array.isArray(data) && data.papers && typeof data.papers === 'object') {
      for (const [k, d] of Object.entries(data.papers)) out[k] = one(k, d);
      return out;
    }
    if (Array.isArray(data) || (data && (Array.isArray(data.notes) || (data.progress && typeof data.progress === 'object')))) {
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

  return { VERSION, GIST_FILE, STATUSES, paperKey, titleOf, hash, empty, track, setCheck, checks, isCheck, merge, mergeProgress, cleanProgress, isEmpty, equal, toFile, parseFile, toStore, gist };
});
