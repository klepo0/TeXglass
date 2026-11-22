/*
 * TeXglass for VS Code: a live preview of LaTeX files beside the editor.
 *
 * The preview follows the active LaTeX editor, like VS Code's Markdown
 * preview. Conversion runs in a worker thread (render-worker.js); the webview
 * (media/preview.js) updates only the blocks that changed, and the two sides
 * keep their scroll positions in step through the source lines of each block.
 *
 * The same code runs in the browser (github.dev, vscode.dev), bundled into
 * dist/web.js with TEXGLASS_WEB set. There files are read through
 * vscode.workspace.fs, and conversion runs in the extension host itself,
 * which is a web worker there.
 */
'use strict';
/* global TEXGLASS_WEB */
const vscode = require('vscode');
const WEB = typeof TEXGLASS_WEB !== 'undefined' && TEXGLASS_WEB;
const path = require('path'); // path-browserify in the web build
const fs = WEB ? null : require('fs');
const { Worker } = WEB ? {} : require('worker_threads');
const os = WEB ? null : require('os');
const { convert } = WEB ? require('./convert.js') : {};
const { assemble, locate, findRoot } = require('./project.js');
const { withFiles } = require('./vfs.js');
const { imageResolver, figureNames } = require('./images.js');
const TeXglassExport = require('./shared/export.js');
const TeXglassEpub = require('./shared/epub.js');
const TeXglassFeatures = require('./shared/features.js');
const NotesSync = require('./shared/notes-sync.js');

/** Hosts the citation previews may ask (see shared/cite.js). */
const LOOKUP_HOSTS = new Set(['api.datacite.org', 'api.crossref.org']);

/** GET a JSON document from a lookup host, with a timeout; rejects with { status } on an HTTP error. */
function fetchJson(url) {
  let u;
  try { u = new URL(url); } catch (e) { return Promise.reject(new Error('Bad URL')); }
  if (u.protocol !== 'https:' || !LOOKUP_HOSTS.has(u.hostname)) return Promise.reject(new Error('Not allowed'));
  const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  if (typeof fetch === 'function') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    return fetch(u.href, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw httpError(res.status);
        return res.json();
      })
      .finally(() => clearTimeout(timer));
  }
  // VS Code before 1.82 runs Node 16, which has no fetch.
  return new Promise((resolve, reject) => {
    const req = require('https').get(u.href, { headers: { Accept: 'application/json', 'User-Agent': 'TeXglass' }, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(httpError(res.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}
const INK_FILTERS = require('./ink.js');

/**
 * An arXiv paper's source, fetched from arxiv.org/src (shared/arxiv.js) and
 * converted to HTML, for previews of the results a document cites. Kept for a
 * while, so hovering more citations of the paper costs nothing.
 */
const citedPapers = new Map(); // arXiv id -> Promise of HTML
function citedPaper(converter, input) {
  const Arxiv = require('./shared/arxiv.js');
  const id = Arxiv.parseId(String(input || ''));
  if (!id) return Promise.reject(new Error('Not an arXiv id'));
  let p = citedPapers.get(id);
  if (!p) {
    if (typeof fetch !== 'function' || typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('this version of VS Code cannot fetch from arXiv'));
    }
    p = Arxiv.importPaper(id)
      .then((paper) => converter.render({ text: paper.source, plain: true }))
      .then((r) => {
        if (!r.result) throw new Error(r.error ? String(r.error).split('\n')[0] : 'conversion failed');
        return r.result.html;
      });
    citedPapers.set(id, p);
    p.catch(() => { if (citedPapers.get(id) === p) citedPapers.delete(id); });
    while (citedPapers.size > 6) citedPapers.delete(citedPapers.keys().next().value);
  }
  return p;
}

const VIEW_TYPE = 'texglass.preview';

function isTex(doc) {
  return !!doc && (doc.languageId === 'latex' || doc.languageId === 'tex' || /\.(tex|ltx|latex)$/i.test(doc.fileName));
}

// --- conversion -----------------------------------------------------------------

/** One worker thread, shared by all previews. Restarted if it dies. */
class Converter {
  constructor(extensionPath) {
    this.script = path.join(extensionPath, 'render-worker.js');
    this.worker = null;
    this.nextId = 0;
    this.waiting = new Map();
  }

  start() {
    this.worker = new Worker(this.script);
    this.worker.on('message', (m) => {
      const done = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (done) done(m);
    });
    const fail = (err) => {
      for (const done of this.waiting.values()) done({ error: String((err && err.stack) || err) });
      this.waiting.clear();
      this.worker = null;
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => code && fail(new Error(`The converter stopped (exit code ${code}).`)));
  }

  render(job) {
    if (WEB) {
      // Let the editor's own work go first, then convert here.
      return new Promise((resolve) => setTimeout(() => {
        try {
          resolve({ result: convert(job) });
        } catch (e) {
          resolve({ error: String((e && e.stack) || e) });
        }
      }, 0));
    }
    if (!this.worker) this.start();
    return new Promise((resolve) => {
      const id = ++this.nextId;
      this.waiting.set(id, resolve);
      this.worker.postMessage(Object.assign({ id }, job));
    });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

/** Line numbers (0-based) of offsets in text with \n line endings. */
function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/**
 * Where in a block's source a click in its rendering falls: the formula that
 * was clicked, else the clicked word nearest the same fraction of the way
 * through, else just that fraction.
 */
function findInBlock(text, m) {
  if (m.tex !== undefined) {
    for (const n of [30, 15, 8, 4]) {
      const needle = m.tex.slice(0, n);
      if (needle.length < Math.min(n, m.tex.length)) continue;
      const k = needle ? text.indexOf(needle) : -1;
      if (k >= 0) return k;
    }
    return 0;
  }
  const fraction = typeof m.fraction === 'number' ? m.fraction : 0;
  const word = (m.head || '') + (m.tail || '');
  if (word.length >= 2) {
    let best = -1;
    let bestDist = Infinity;
    for (let k = text.indexOf(word); k >= 0; k = text.indexOf(word, k + 1)) {
      const dist = Math.abs(k / text.length - fraction);
      if (dist < bestDist) {
        best = k;
        bestDist = dist;
      }
    }
    if (best >= 0) return best + m.head.length;
  }
  return Math.round(fraction * text.length);
}

/** Set a context key that decides which buttons the preview's title bar shows. */
/** Whether a click on a formula in the preview copies its LaTeX. */
function readingProgress() {
  return vscode.workspace.getConfiguration('texglass').get('readingProgress', true) !== false;
}

function studyTools() {
  return vscode.workspace.getConfiguration('texglass').get('studyTools', true) !== false;
}

/** The file next to a .tex that keeps the reader's highlights and notes: paper.tex -> paper.texglass.json. */
function notesUri(uri) {
  const p = uri.path;
  const base = /\.(tex|ltx|latex)$/i.test(p) ? p.replace(/\.(tex|ltx|latex)$/i, '') : p;
  return uri.with({ path: base + '.texglass.json' });
}

/** The notes in a sidecar file's text, or [] if it has none. */
function parseNotes(text) {
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data && Array.isArray(data.notes) ? data.notes : [];
    return list.filter((a) => a && typeof a.id === 'string' && a.anchor && typeof a.anchor === 'object');
  } catch (e) {
    return [];
  }
}

// --- the reader's notes on every machine -------------------------------------------------
// Besides paper.texglass.json, each paper's notes are kept in the extension's
// global state under its paper key (see shared/notes-sync.js), which VS Code's
// Settings Sync carries to the reader's other machines; and, once they turn it
// on, in a private gist on their GitHub account (signed in through VS Code's own
// GitHub sign-in). Copies are merged by note id.
const NOTES_STATE = 'texglass.notes';

/** Every paper's notes kept in global state: { key: record }. */
function notesStore(context) {
  return Object.assign({}, context.globalState.get(NOTES_STATE, {}));
}

/** Keep one paper's notes in global state. */
function keepNotes(context, key, record) {
  if (!key) return Promise.resolve();
  const all = notesStore(context);
  if (NotesSync.isEmpty(record)) delete all[key];
  else all[key] = { title: record.title || undefined, notes: record.notes, deleted: record.deleted || {}, progress: record.progress || {}, map: record.map || {} };
  return context.globalState.update(NOTES_STATE, all);
}

/** A GitHub session that may use gists: asked for (ask) or only if there already is one. */
async function gistSession(ask) {
  try {
    return await vscode.authentication.getSession('github', ['gist'], ask ? { createIfNone: true } : { silent: true });
  } catch (e) {
    if (ask) vscode.window.showWarningMessage(`TeXglass could not sign in to GitHub: ${e.message || e}`);
    return null;
  }
}

/** The notes gist, if syncing is on and there is a session (ask: sign in now). */
async function notesGist(context, ask) {
  if (!ask && !context.globalState.get('texglass.gistSync', false)) return null;
  const session = await gistSession(ask);
  if (!session) return null;
  return NotesSync.gist(session.accessToken, { gistId: context.globalState.get('texglass.gistId', null) });
}

// Once GitHub sync is on it runs by itself (on opening a paper, a moment after
// each change), so a status bar item says so while a preview is open, with when
// it last synced; clicking it offers Sync now (rarely needed) or Stop.
let syncItem = null;
let syncHasPreview = () => false;

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

/** One line on the state of GitHub sync. */
function syncStateLine(context) {
  const err = context.globalState.get('texglass.gistError', '');
  if (err) return `Syncing automatically · last try failed: ${err}`;
  const ago = syncedAgo(context.globalState.get('texglass.gistSynced', ''));
  return 'Syncing automatically' + (ago ? ` · last synced ${ago}` : '');
}

function updateSyncItem(context) {
  if (!syncItem) return;
  if (!context.globalState.get('texglass.gistSync', false) || !syncHasPreview()) {
    syncItem.hide();
    return;
  }
  const err = context.globalState.get('texglass.gistError', '');
  syncItem.text = err ? '$(warning) Notes not synced' : '$(sync) Notes sync on';
  syncItem.tooltip = `TeXglass highlights and notes: ${syncStateLine(context)} with a private gist on your GitHub account. ` +
    'They sync on their own when you open a paper and a few seconds after each change, so there is nothing to do. Click to sync now or stop.';
  syncItem.show();
}

/** Remember how the last gist sync went (err: its message, or '' when it worked). */
async function recordSync(context, err) {
  await context.globalState.update('texglass.gistError', err || '');
  if (!err) await context.globalState.update('texglass.gistSynced', new Date().toISOString());
  updateSyncItem(context);
}

function notationHover() {
  return vscode.workspace.getConfiguration('texglass').get('notationHover', true) !== false;
}

/** Every reading aid's setting, by its id in shared/features.js: { refPreviews: true, ... }. */
function featureSettings() {
  const config = vscode.workspace.getConfiguration('texglass');
  const out = {};
  for (const f of TeXglassFeatures.LIST) {
    if (f.id === 'handwriting') out[f.id] = config.get('previewStyle', 'standard') === 'handwritten';
    else out[f.id] = config.get(f.vscode, true) !== false;
  }
  return out;
}

/** Change one reading aid's setting (from the preview's Settings panel). */
function setFeatureSetting(id, on) {
  const f = TeXglassFeatures.LIST.find((x) => x.id === id);
  if (!f) return undefined;
  if (id === 'handwriting') return setConfig('previewStyle', on ? 'handwritten' : 'standard');
  return setConfig(f.vscode, !!on);
}

function clickToCopy() {
  return vscode.workspace.getConfiguration('texglass').get('clickToCopyMath', true) !== false;
}

/** Where the contents go: 'left' or 'right' of the document. */
/** The preview's look (standard or handwritten notes) and the notes' paper,
 *  handwriting and handwritten-math settings, as <html> data attributes. */
function previewLook() {
  const config = vscode.workspace.getConfiguration('texglass');
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    look: config.get('previewStyle', 'standard') === 'handwritten' ? 'notes' : 'standard',
    paper: pick(config.get('notes.paper', 'grid'), ['grid', 'lined', 'plain'], 'grid'),
    hand: pick(config.get('notes.handwriting', 'kalam'), ['kalam', 'caveat', 'patrick-hand', 'architects-daughter'], 'kalam'),
    handMath: config.get('notes.handwrittenMath', true) === false ? 'off' : 'on',
    ink: pick(config.get('notes.ink', 'ballpoint'), ['ballpoint', 'fountain', 'black'], 'ballpoint'),
    inkTexture: config.get('notes.realisticInk', true) === false ? 'off' : 'on',
  };
}

function contentsPosition() {
  return vscode.workspace.getConfiguration('texglass').get('contentsPosition', 'left') === 'right' ? 'right' : 'left';
}

/** Change a setting where it is set now: the workspace if it overrides it there, else for the user. */
function setConfig(key, value) {
  const config = vscode.workspace.getConfiguration('texglass');
  const info = config.inspect(key);
  const target = info && info.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  return config.update(key, value, target);
}

function setContext(key, value) {
  vscode.commands.executeCommand('setContext', key, value);
}

const caseless = typeof process !== 'undefined' && (process.platform === 'win32' || process.platform === 'darwin');
const normPath = (p) => (caseless ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * Whether a document lives on a file system that can only be read through
 * vscode.workspace.fs: a GitHub repo in github.dev (vscode-vfs:), any folder
 * in the browser, a remote repository on the desktop. Untitled documents are
 * previewed on their own.
 */
const isVirtual = (uri) => uri.scheme !== 'untitled' && (WEB || uri.scheme !== 'file');

async function readText(uri) {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).replace(/\r\n?/g, '\n');
  } catch (e) {
    return null;
  }
}

/** The .tex files in a folder of a virtual file system, as paths. */
async function listTexVirtual(dirUri) {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    return entries
      .filter(([n, type]) => type & vscode.FileType.File && /\.tex$/i.test(n))
      .slice(0, 200)
      .map(([n]) => path.posix.join(dirUri.path, n));
  } catch (e) {
    return [];
  }
}

/** The open document for a path on the same virtual file system as `uri`, if any. */
function openDocsLike(uri) {
  const docs = new Map();
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme === uri.scheme && d.uri.authority === uri.authority) docs.set(d.uri.path, d);
  }
  return docs;
}

/** The text of a file: from its editor if it is open (unsaved changes included), else from disk. */
function readSource(p) {
  const want = normPath(p);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && normPath(d.uri.fsPath) === want);
  if (doc) return doc.getText();
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

/** The main file of the project `uri` belongs to (see findRoot in project.js). */
async function rootOf(uri, text) {
  // Look for the main file no higher than the workspace folder.
  const top = vscode.workspace.getWorkspaceFolder(uri);
  if (isVirtual(uri)) {
    const docs = openDocsLike(uri);
    const root = await withFiles(
      (get) => findRoot(uri.path, text, (d) => get('#' + d) || [], (p) => (docs.has(p) ? docs.get(p).getText() : get(p)), path.posix, top && top.uri.path),
      (key) => (key[0] === '#' ? listTexVirtual(uri.with({ path: key.slice(1) })) : readText(uri.with({ path: key }))),
      new Map()
    );
    return root === uri.path ? uri : uri.with({ path: root });
  }
  if (uri.scheme !== 'file') return uri;
  const listTex = (dir) => {
    try {
      return fs.readdirSync(dir).filter((n) => /\.tex$/i.test(n)).slice(0, 200).map((n) => path.join(dir, n));
    } catch (e) {
      return [];
    }
  };
  const root = findRoot(uri.fsPath, text, listTex, readSource, path, top && top.uri.fsPath);
  return root === uri.fsPath || !fs.existsSync(root) ? uri : vscode.Uri.file(root);
}

/**
 * The document as TeXglass sees it: the file with its \\input files and
 * bibliography pulled in. Open editors win over the files on disk, so the
 * preview shows unsaved changes in any of them. `deps` are the files it read,
 * as the preview's keys for them (see Preview.keyOf). `cache` remembers what
 * was read from a virtual file system.
 */
async function assembleDocument(uri, cache) {
  if (isVirtual(uri)) {
    const docs = openDocsLike(uri);
    const project = await withFiles(
      (get) => assemble(uri.path, (p) => (docs.has(p) ? docs.get(p).getText() : get(p)), path.posix),
      (p) => readText(uri.with({ path: p })),
      cache
    );
    if (!project) return { error: `Could not read ${uri.path}.` };
    return project;
  }
  if (uri.scheme !== 'file') {
    let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    try {
      if (!doc) doc = await vscode.workspace.openTextDocument(uri);
    } catch (e) {
      return { error: `Could not open ${uri}: ${e.message || e}` };
    }
    const text = doc.getText().replace(/\r\n?/g, '\n');
    const key = uri.toString();
    return { text, files: [key], texts: { [key]: text }, segments: [{ start: 0, end: text.length, file: 0, at: 0 }], deps: [], warnings: [] };
  }
  const project = assemble(uri.fsPath, readSource);
  if (!project) return { error: `Could not read ${uri.fsPath}.` };
  project.deps = project.deps.map(normPath);
  return project;
}

/**
 * Figures of a document on a virtual file system: { \\includegraphics name:
 * the file's Uri, or null }. Files are looked up with stat, in parallel, and
 * remembered in `cache`.
 */
async function findFigureFiles(uri, text, cache) {
  const names = figureNames(text);
  const figures = {};
  if (!names.length) return figures;
  const dir = path.posix.dirname(uri.path);
  const at = (rel) => uri.with({ path: path.posix.join(dir, rel) });
  await withFiles(
    (get) => {
      const find = imageResolver(text, (rel) => get('?' + rel) === true, (rel) => rel);
      for (const n of names) figures[n] = find(n);
    },
    (key) => vscode.workspace.fs.stat(at(key.slice(1))).then((st) => (st.type & vscode.FileType.File) !== 0, () => false),
    cache
  );
  for (const n of names) figures[n] = figures[n] ? at(figures[n]) : null;
  return figures;
}

const BLOCK_HEAD = /^<div class="src-block" data-s="(\d+)" data-e="(\d+)">/;

// --- the preview panel --------------------------------------------------------------

class Preview {
  constructor(context, converter, panel, uri) {
    this.context = context;
    this.converter = converter;
    this.panel = panel;
    this.uri = uri;
    this.renderedText = null;
    this.busy = false;
    this.again = false;
    this.timer = null;
    this.ready = false;
    this.lastEditorScroll = 0;
    this.lastPreviewScroll = 0;
    this.disposables = [];
    this.cache = new Map(); // files read from a virtual file system

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.setup();
  }

  get document() {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri.toString());
  }

  setup() {
    const { panel } = this;
    const folder = vscode.Uri.joinPath(this.uri, '..');
    const roots = [this.context.extensionUri, folder];
    for (const f of vscode.workspace.workspaceFolders || []) roots.push(f.uri);
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.title = `Preview ${path.basename(this.uri.fsPath || this.uri.path)}`;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
    this.ready = false;
    this.renderedText = null;
    this.cache = new Map();
    this.watchNotes();
    panel.webview.html = this.html();
  }

  // --- the reader's highlights and notes, in paper.texglass.json next to the .tex ---

  watchNotes() {
    if (this.notesWatcher) this.notesWatcher.dispose();
    this.notesWatcher = null;
    this.notesText = undefined;
    this.notesKey = null;
    this.notesRecord = null;
    try {
      const file = notesUri(this.uri);
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(file, '..'), path.posix.basename(file.path)));
      const reload = () => this.loadNotes();
      w.onDidChange(reload);
      w.onDidCreate(reload);
      w.onDidDelete(reload);
      this.notesWatcher = w;
    } catch (e) {
      // No watching here (some virtual file systems): read it when the preview opens.
    }
  }

  /** The key that names this paper on every machine (shared/notes-sync.js). */
  async paperKey() {
    if (this.notesKey) return this.notesKey;
    let text = '';
    const d = this.document;
    if (d) text = d.getText();
    else {
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri));
      } catch (e) {
        text = '';
      }
    }
    this.notesKey = NotesSync.paperKey({ name: path.posix.basename(this.uri.path), source: text }) || 'tex:' + path.posix.basename(this.uri.path);
    return this.notesKey;
  }

  async loadNotes() {
    let text = '';
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(notesUri(this.uri)));
    } catch (e) {
      text = '';
    }
    if (this.disposed || text === this.notesText) return; // our own write coming back
    const removed = !text && !!this.notesText; // the reader deleted the file: their notes go too
    this.notesText = text;
    const key = await this.paperKey();
    if (removed && this.notesRecord) {
      this.notesRecord = Object.assign({}, this.notesRecord, { progress: {} });
      this.post({ type: 'annotations', list: [] });
      this.post({ type: 'progress', map: {} });
      this.post({ type: 'map-edits', map: {} });
      this.notesRecord.map = {};
      return this.saveNotes([]);
    }
    let rec = NotesSync.empty(key);
    try {
      if (text) rec = Object.assign(Object.values(NotesSync.parseFile(text, key))[0] || rec, { paper: key });
    } catch (e) {
      rec = Object.assign(NotesSync.empty(key), { notes: parseNotes(text) });
    }
    // Notes made on this paper on another machine (Settings Sync) come in too.
    const kept = notesStore(this.context)[key];
    const merged = NotesSync.merge(rec, kept ? Object.assign({}, kept, { paper: key }) : null);
    this.notesRecord = merged;
    this.post({ type: 'annotations', list: merged.notes });
    this.post({ type: 'progress', map: merged.progress || {} });
    this.post({ type: 'map-edits', map: merged.map || {} });
    if (!NotesSync.equal(merged, rec) && !NotesSync.isEmpty(merged)) await this.writeNotes(merged);
    await keepNotes(this.context, key, merged);
    this.syncGist();
  }

  /** The reader changed the notes in the preview. */
  async saveNotes(list) {
    const key = await this.paperKey();
    this.notesRecord = Object.assign(NotesSync.track(this.notesRecord || NotesSync.empty(key), Array.isArray(list) ? list : []), { paper: key });
    await this.writeNotes(this.notesRecord);
    await keepNotes(this.context, key, this.notesRecord);
    clearTimeout(this.gistTimer);
    this.gistTimer = setTimeout(() => this.syncGist(), 2500);
  }

  /** The reader changed a reading status in the preview (src/progress.js). */
  async saveProgress(map) {
    const key = await this.paperKey();
    const rec = this.notesRecord || NotesSync.empty(key);
    this.notesRecord = Object.assign({}, rec, { paper: key, progress: NotesSync.mergeProgress(rec.progress, map) });
    await this.writeNotes(this.notesRecord);
    await keepNotes(this.context, key, this.notesRecord);
    clearTimeout(this.gistTimer);
    this.gistTimer = setTimeout(() => this.syncGist(), 2500);
  }

  /** The reader changed the dependency map in the preview: kept with the notes, so it syncs with them. */
  async saveMapEdits(map) {
    const key = await this.paperKey();
    const rec = this.notesRecord || NotesSync.empty(key);
    this.notesRecord = Object.assign({}, rec, { paper: key, map: NotesSync.mergeMap(rec.map, map) });
    await this.writeNotes(this.notesRecord);
    await keepNotes(this.context, key, this.notesRecord);
    clearTimeout(this.gistTimer);
    this.gistTimer = setTimeout(() => this.syncGist(), 2500);
  }

  /** The reader ticked (or unticked) a hypothesis: kept with the notes, so it syncs with them. */
  async saveCheck(id, on, info) {
    const key = await this.paperKey();
    this.notesRecord = Object.assign(NotesSync.setCheck(this.notesRecord || NotesSync.empty(key), id, on, info), { paper: key });
    await this.writeNotes(this.notesRecord);
    await keepNotes(this.context, key, this.notesRecord);
    clearTimeout(this.gistTimer);
    this.gistTimer = setTimeout(() => this.syncGist(), 2500);
  }

  /** Bring in notes from elsewhere (a file, the gist) for this paper. */
  async takeNotes(record) {
    const key = await this.paperKey();
    const before = this.notesRecord || NotesSync.empty(key);
    const merged = NotesSync.merge(before, Object.assign({}, record, { paper: key }));
    if (NotesSync.equal(merged, before)) return 0;
    this.notesRecord = merged;
    this.post({ type: 'annotations', list: merged.notes });
    this.post({ type: 'progress', map: merged.progress || {} });
    this.post({ type: 'map-edits', map: merged.map || {} });
    await this.writeNotes(merged);
    await keepNotes(this.context, key, merged);
    return merged.notes.length - before.notes.length;
  }

  /** Sync this paper's notes with the gist, if that is on. Quiet unless asked. */
  syncGist(loud) {
    const run = async () => {
      if (this.disposed) return;
      const g = await notesGist(this.context, false);
      if (!g) return;
      const key = await this.paperKey();
      try {
        const rec = await g.sync(key, this.notesRecord || NotesSync.empty(key));
        if (g.id()) await this.context.globalState.update('texglass.gistId', g.id());
        if (!this.disposed && key === this.notesKey) await this.takeNotes(rec);
        await recordSync(this.context, '');
        if (loud) vscode.window.setStatusBarMessage('TeXglass: notes synced with GitHub', 3000);
      } catch (e) {
        await recordSync(this.context, String(e.message || e));
        if (loud || e.auth) vscode.window.showWarningMessage(`TeXglass could not sync the notes: ${e.message || e}`);
      }
    };
    this.gistSyncing = (this.gistSyncing || Promise.resolve()).then(run, run);
    return this.gistSyncing;
  }

  /** Write paperk.texglass.json (or remove it once no notes are left). */
  async writeNotes(record) {
    const file = notesUri(this.uri);
    try {
      if (NotesSync.isEmpty(Object.assign({}, record, { deleted: {} }))) {
        // No notes or reading progress left: no file either (if there was one).
        if (this.notesText) await vscode.workspace.fs.delete(file);
        this.notesText = '';
        return;
      }
      const text = NotesSync.toFile(record,
        'Highlights and notes made in the TeXglass preview, anchored to the text of ' + path.posix.basename(this.uri.path) + '.');
      if (text === this.notesText) return;
      this.notesText = text;
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
    } catch (e) {
      vscode.window.showWarningMessage(`TeXglass could not save the notes to ${path.posix.basename(file.path)}: ${e.message || e}`);
    }
  }

  /** A note's text as HTML, with its maths, using the document's own macros. */
  async renderNote(id, text) {
    let html = null;
    try {
      const doc = this.project ? this.project.text : '';
      const at = doc.indexOf('\\begin{document}');
      const preamble = at >= 0 ? doc.slice(0, at) : '';
      const m = await this.converter.render({ text: `${preamble}\\begin{document}\n${String(text)}\n\\end{document}`, plain: true });
      if (m.result) html = m.result.html;
    } catch (e) {
      html = null;
    }
    this.post({ type: 'note-html', id, html });
  }

  /** Show another document in this panel. */
  setDocument(uri) {
    if (uri.toString() === this.uri.toString()) return;
    this.uri = uri;
    this.setup();
  }

  html() {
    const webview = this.panel.webview;
    const res = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data: blob:`,
      // KaTeX positions glyphs with inline style attributes.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      // pdf.js (for PDF figures) is a module loaded when needed, and its worker starts from a blob
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
      `worker-src blob:`,
    ].join('; ');
    const look = previewLook();
    return `<!doctype html>
<html lang="en" data-look="${look.look}" data-paper="${look.paper}" data-hand="${look.hand}" data-hand-math="${look.handMath}" data-ink="${look.ink}" data-ink-texture="${look.inkTexture}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${res('node_modules', 'katex', 'dist', 'katex.min.css')}">
<link rel="stylesheet" href="${res('shared', 'styles.css')}">
<link rel="stylesheet" href="${res('media', 'preview.css')}">
<link rel="stylesheet" href="${res('media', 'notes.css')}">
</head>
<body>
${INK_FILTERS}
<main class="panes"><nav class="toc-pane" id="toc-pane" aria-label="Table of contents" hidden><div class="toc-pane-head"><div class="toc-pane-title">Contents</div><button id="toc-side" class="toc-side" type="button" aria-label="Move the contents to the right" title="Move the contents to the right"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg></button></div><ol id="toc-list" class="toc-list"></ol></nav><section class="pane" id="preview-pane"><article id="preview" class="document"></article></section></main>
<div id="ref-popover" class="ref-popover" hidden></div>
<div id="status" class="texglass-status" hidden></div>
<div id="zoom-float" class="zoom-float" role="group" aria-label="Zoom" hidden><button id="zoom-out" type="button" aria-label="Zoom out" title="Zoom out (Ctrl+−)">−</button><button id="zoom-level" class="zoom-level" type="button" title="Reset the zoom to 100% (Ctrl+0)">100%</button><button id="zoom-in" type="button" aria-label="Zoom in" title="Zoom in (Ctrl++)">+</button></div>
<script nonce="${nonce}" src="${res('shared', 'find.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'diagrams.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'epub.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'zoom.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'scroll.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'popover.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'copytex.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'margin.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'insight.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'pick.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'progress.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'steps.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'hypotheses.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'cited.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'cite.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'features.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'textwidth.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'eps.js')}"></script>
<script nonce="${nonce}" src="${res('shared', 'pdf.js')}"></script>
<script nonce="${nonce}" src="${res('media', 'preview.js')}"></script>
</body>
</html>`;
  }

  /** Re-render soon (as you type) or now. */
  update(soon) {
    clearTimeout(this.timer);
    if (soon) this.timer = setTimeout(() => this.render(), 150);
    else this.render();
  }

  async render() {
    if (!this.ready) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    const project = await this.assembleProject();
    if (this.disposed || !project) return;
    if (project.error) {
      this.post({ type: 'error', text: project.error });
      return;
    }
    if (project.text === this.renderedText) return;
    this.busy = true;
    const text = project.text;
    const virtual = isVirtual(this.uri);
    const isFile = !virtual && this.uri.scheme === 'file';
    const dir = isFile ? path.dirname(this.uri.fsPath) : null;
    const base = isFile ? this.panel.webview.asWebviewUri(vscode.Uri.file(dir)).toString() : null;
    const slow = setTimeout(() => this.post({ type: 'status', text: 'Rendering…' }), 400);
    try {
      const uri = this.uri.toString();
      const figures = virtual ? await this.findFigures(text) : undefined;
      const m = await this.converter.render(virtual ? { text, figures } : { text, dir, base });
      if (this.disposed || uri !== this.uri.toString() || !this.ready) return;
      if (m.error) {
        this.post({ type: 'error', text: m.error });
      } else {
        const r = m.result;
        const lineOf = project.files.map((f) => lineIndex(project.texts[f] || ''));
        const lines = r.blocks.map((html) => {
          const h = BLOCK_HEAD.exec(html);
          if (!h) return null;
          const a = locate(project, Number(h[1]));
          const b = locate(project, Math.max(Number(h[1]), Number(h[2]) - 1));
          const line = lineOf[a.file](a.offset);
          return [line, b.file === a.file ? Math.max(line, lineOf[a.file](b.offset)) : line, a.file];
        });
        this.project = project;
        this.renderedText = text;
        // The source files by number, as the notes name them: relative to the main file's folder.
        const slash = (f) => String(f || '').replace(/\\/g, '/');
        const mainDir = path.posix.dirname(slash(project.files[0]));
        const files = project.files.map((f) => {
          const p = slash(f);
          return mainDir && p.startsWith(mainDir + '/') ? p.slice(mainDir.length + 1) : path.posix.basename(p);
        });
        // The paper's macros, for notation on hover and the notation index; sent again only when they change.
        const defsJson = JSON.stringify(r.defs || null);
        const defs = defsJson !== this.defsJson ? r.defs || null : undefined;
        this.defsJson = defsJson;
        this.defs = r.defs || null;
        this.post({ type: 'render', blocks: r.blocks, lines, toc: r.toc, warnings: project.warnings.concat(r.warnings), defs, files });
        this.flushLine();
        if (r.title) this.panel.title = `Preview ${r.title.length > 40 ? r.title.slice(0, 39) + '…' : r.title}`;
      }
    } finally {
      clearTimeout(slow);
      this.busy = false;
      if (this.again && !this.disposed) {
        this.again = false;
        this.render();
      }
    }
  }

  /** The document with its \\input files and bibliography (see assembleDocument). */
  async assembleProject() {
    const project = await assembleDocument(this.uri, this.cache);
    if (project && project.deps) this.deps = new Set(project.deps);
    return project;
  }

  /** Figures on a virtual file system: { \\includegraphics name: webview URL }. */
  async findFigures(text) {
    const figures = await findFigureFiles(this.uri, text, this.cache);
    for (const n of Object.keys(figures)) figures[n] = figures[n] ? this.panel.webview.asWebviewUri(figures[n]).toString() : null;
    return figures;
  }

  /** How this preview's project names a file: its path (normalized on disk), or null if it cannot be part of it. */
  keyOf(uri) {
    if (isVirtual(this.uri)) return uri.scheme === this.uri.scheme && uri.authority === this.uri.authority ? uri.path : null;
    if (uri.scheme === 'file') return normPath(uri.fsPath);
    return uri.toString();
  }

  /** The file a project path names. */
  uriOf(name) {
    if (isVirtual(this.uri)) return this.uri.with({ path: name });
    return this.uri.scheme === 'file' ? vscode.Uri.file(name) : vscode.Uri.parse(name);
  }

  /** Whether the preview shows (part of) this file, or would change with it. */
  depends(uri) {
    const key = this.keyOf(uri);
    return !!this.deps && key != null && this.deps.has(key);
  }

  /** Forget what was read of a file on a virtual file system, after it changed. */
  forget(uri) {
    const key = this.keyOf(uri);
    if (key != null) this.cache.delete(key);
  }

  hasFile(uri) {
    return this.fileIndex(uri) >= 0;
  }

  fileIndex(uri) {
    if (!this.project) return -1;
    const key = this.keyOf(uri);
    if (key == null) return -1;
    const norm = isVirtual(this.uri) || this.uri.scheme !== 'file' ? (f) => f : normPath;
    return this.project.files.findIndex((f) => norm(f) === key);
  }

  post(message) {
    if (!this.disposed) this.panel.webview.postMessage(message);
  }

  /**
   * HTML made ready for an e-book in the preview, which is a browser page:
   * figures as data: URLs (PDF and EPS ones drawn first) and diagrams drawn
   * (src/epub.js drawDiagrams). Null if the preview does not answer.
   */
  prepareEpub(html) {
    return new Promise((resolve) => {
      if (!this.epubWaiting) this.epubWaiting = new Map();
      const id = (this.epubId = (this.epubId || 0) + 1);
      const timer = setTimeout(() => { this.epubWaiting.delete(id); resolve(null); }, 120000);
      this.epubWaiting.set(id, (h) => { clearTimeout(timer); resolve(h); });
      this.post({ type: 'epub-prepare', id, html });
    });
  }

  onMessage(m) {
    switch (m.type) {
      case 'epub-prepared': {
        const done = this.epubWaiting && this.epubWaiting.get(m.id);
        if (done) { this.epubWaiting.delete(m.id); done(typeof m.html === 'string' ? m.html : null); }
        break;
      }
      case 'print-request': // Print on the bar of a selection or of "What does this use?"
        vscode.commands.executeCommand('texglass.print');
        break;
      case 'print': // what shows in the preview, after 'print-view'
        if (WEB) break;
        vscode.commands.executeCommand('texglass.exportHtml', this.uri, undefined, true,
          m.view && Array.isArray(m.view.keep) ? { n: m.view.n, keep: m.view.keep } : undefined);
        break;
      case 'ready': {
        this.ready = true;
        this.post({ type: 'doc', uri: this.uri.toString() });
        this.post({
          type: 'prefs',
          folds: this.context.globalState.get('texglass.folds', []),
          toc: this.context.globalState.get('texglass.toc', true),
          sideTab: this.context.globalState.get('texglass.sideTab', 'toc'),
          sideWidth: this.context.globalState.get('texglass.sideWidth', null),
          notationOrder: this.context.globalState.get('texglass.notationOrder', null),
          notationUsedPinned: this.context.globalState.get('texglass.notationUsedPinned', false),
          mapLocked: this.context.globalState.get('texglass.mapLocked', false),
          marginWidth: this.context.globalState.get('texglass.marginWidth', null),
          marginCollapsed: this.context.globalState.get('texglass.marginCollapsed', false),
          textWidth: this.context.globalState.get('texglass.textWidth', ''),
          notePad: this.context.globalState.get('texglass.notePad', null),
        });
        setContext('texglass.tocOpen', this.context.globalState.get('texglass.toc', true));
        setContext('texglass.hasProofs', false);
        this.post({ type: 'zoom', level: this.context.workspaceState.get('texglass.zoom', 1) });
        this.post({ type: 'toc-side', value: contentsPosition() });
        this.post({ type: 'theme', value: vscode.workspace.getConfiguration('texglass').get('previewTheme', 'auto') });
        this.post({ type: 'click-to-copy', on: clickToCopy() });
        this.post({ type: 'study', on: studyTools() });
        this.post({ type: 'reading-progress', on: readingProgress() });
        this.notesText = undefined;
        this.loadNotes();
        this.post({ type: 'notation-hover', on: notationHover() });
        this.post({ type: 'features', prefs: featureSettings() });
        this.renderedText = null;
        this.defsJson = null;
        this.render().then(() => {
          if (this.pendingLine) return this.flushLine();
          const ed = this.editor();
          if (ed && ed.visibleRanges.length) this.syncFromEditor(ed);
        });
        break;
      }
      case 'reveal':
        this.reveal(m.file || 0, m.line);
        break;
      case 'reveal-at':
        this.revealAt(m);
        break;
      case 'scroll':
        this.syncFromPreview(m.line, m.file || 0);
        break;
      case 'folds':
        // Keep the most recent ones, like the web viewer.
        this.context.globalState.update('texglass.folds', m.keys.slice(-500));
        break;
      case 'toc':
        this.context.globalState.update('texglass.toc', m.on);
        setContext('texglass.tocOpen', m.on);
        break;
      case 'zoomed':
        this.context.workspaceState.update('texglass.zoom', m.level);
        break;
      case 'set-toc-side':
        setConfig('contentsPosition', m.value === 'right' ? 'right' : 'left');
        break;
      case 'set-theme':
        vscode.workspace.getConfiguration('texglass').update('previewTheme', m.value, vscode.ConfigurationTarget.Global);
        break;
      case 'proofs':
        setContext('texglass.hasProofs', m.has);
        setContext('texglass.proofsFolded', m.folded);
        break;
      case 'shown':
        this.shown = m; // what the webview shows, for the tests
        break;
      case 'copy-tex':
        // The extension host's clipboard works wherever the webview's may not.
        if (typeof m.text === 'string') vscode.env.clipboard.writeText(m.text);
        break;
      case 'annotations':
        this.saveNotes(m.list);
        break;
      case 'progress':
        if (m.map && typeof m.map === 'object') this.saveProgress(m.map);
        break;
      case 'map-edits':
        // pins, hidden results, own links, layout and saved maps (shared/insight.js)
        if (m.map && typeof m.map === 'object') this.saveMapEdits(m.map);
        break;
      case 'check':
        // a hypothesis ticked in a preview of a cited result (shared/hypotheses.js)
        if (typeof m.id === 'string') this.saveCheck(m.id, !!m.on, m.info);
        break;
      case 'render-note':
        this.renderNote(m.id, m.text);
        break;
      case 'render-tex':
        // Symbols for the notation index, drawn with the document's macros.
        if (Array.isArray(m.texs)) {
          this.converter.render({ snippets: m.texs.slice(0, 500).map(String), defs: this.defs }).then((r) => {
            this.post({ type: 'tex-rendered', id: m.id, html: r.result ? r.result.html : null });
          });
        }
        break;
      case 'side-pref':
        // the side panel's tab and width, kept for every preview
        if (m.key === 'texglass:side-tab') this.context.globalState.update('texglass.sideTab', String(m.value));
        if (m.key === 'texglass:side-width') this.context.globalState.update('texglass.sideWidth', Number(m.value) || null);
        if (m.key === 'texglass:notation-used-pinned') this.context.globalState.update('texglass.notationUsedPinned', !!m.value);
        if (m.key === 'texglass:map-locked') this.context.globalState.update('texglass.mapLocked', !!m.value);
        if (m.key === 'texglass:notation-order' && /^(section|kind|az)$/.test(String(m.value))) this.context.globalState.update('texglass.notationOrder', String(m.value));
        if (m.key === 'texglass:margin-width') this.context.globalState.update('texglass.marginWidth', Number(m.value) || null);
        if (m.key === 'texglass:margin-collapsed') this.context.globalState.update('texglass.marginCollapsed', !!m.value);
        if (m.key === 'texglass:text-width' && /^(|full|\d{2,5})$/.test(String(m.value))) this.context.globalState.update('texglass.textWidth', String(m.value));
        if (m.key === 'texglass:note-pad') {
          const at = m.value && Number.isFinite(m.value.right) && Number.isFinite(m.value.bottom)
            ? { right: m.value.right, bottom: m.value.bottom } : null;
          this.context.globalState.update('texglass.notePad', at);
        }
        break;
      case 'set-notation-hover':
        setConfig('notationHover', !!m.on);
        break;
      case 'set-feature':
        // a switch in the preview's Settings panel
        if (typeof m.id === 'string') setFeatureSetting(m.id, !!m.on);
        break;
      case 'open-settings':
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:klepo1.texglass');
        break;
      case 'open-link':
        if (/^https?:|^mailto:/.test(m.href)) vscode.env.openExternal(vscode.Uri.parse(m.href));
        break;
      case 'fetch-json':
        // Citation previews: the webview asks, the extension fetches (only from the paper databases).
        fetchJson(m.url).then(
          (json) => this.post({ type: 'json', id: m.id, ok: true, json }),
          (e) => this.post({ type: 'json', id: m.id, ok: false, error: String((e && e.message) || e), status: (e && e.status) || 0 })
        );
        break;
      case 'cited-paper':
        // "[12, Theorem 4.1]": the cited paper's source, from arXiv, converted for the webview to find the theorem in.
        citedPaper(this.converter, m.arxiv).then(
          (html) => this.post({ type: 'cited-paper', id: m.id, ok: true, html }),
          (e) => this.post({ type: 'cited-paper', id: m.id, ok: false, error: String((e && e.message) || e) })
        );
        break;
      case 'open-arxiv':
        // A cited paper on arXiv: open it in the TeXglass web viewer (at a cited result, given goto).
        if (/^[\w.\/-]+$/.test(String(m.id || ''))) {
          const goto = typeof m.goto === 'string' && m.goto.length < 80 ? `&goto=${encodeURIComponent(m.goto)}` : '';
          vscode.env.openExternal(vscode.Uri.parse(`https://klepo0.github.io/TeXglass/?arxiv=${encodeURIComponent(m.id)}${goto}`));
        }
        break;
      default:
    }
  }

  /** A visible editor showing the main file or one it pulls in (the active one first), or one for file number `file`. */
  editor(file) {
    const eds = [vscode.window.activeTextEditor].concat(vscode.window.visibleTextEditors).filter(Boolean);
    if (file !== undefined) return eds.find((e) => this.fileIndex(e.document.uri) === file);
    return eds.find((e) => this.fileIndex(e.document.uri) >= 0) || eds.find((e) => e.document.uri.toString() === this.uri.toString());
  }

  /** Go to the spot in the source that was clicked in the preview (see whereClicked in preview.js). */
  async revealAt(m) {
    const project = this.project;
    if (!project) return;
    const text = project.text;
    const s = Math.min(m.s, text.length);
    const at = locate(project, s + findInBlock(text.slice(s, Math.min(m.e, text.length)), m));
    const file = project.files[at.file];
    const source = project.texts[file] || '';
    // Offsets are in the text with \n line endings, so count lines there.
    const line = lineIndex(source)(at.offset);
    const col = at.offset - (source.lastIndexOf('\n', at.offset - 1) + 1);
    return this.reveal(at.file, line, col);
  }

  /** Put the cursor at `line` of source file number `file`, opening it if needed. */
  async reveal(file, line, col) {
    // The preview stays where it was clicked: moving the editor here must not
    // scroll it (back to the top, for a file that was just opened).
    this.holdPreview();
    let ed = this.editor(file);
    if (!ed) ed = await this.openFile(file, false);
    else ed = await vscode.window.showTextDocument(ed.document, ed.viewColumn);
    if (!ed) return;
    const pos = ed.document.validatePosition(new vscode.Position(Math.max(0, line), col || 0));
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.holdPreview();
  }

  /** Show source file number `file` where the document's editor is (or beside the preview). */
  async openFile(file, preserveFocus) {
    const name = this.project ? this.project.files[file] : null;
    const uri = !name ? this.uri : this.uriOf(name);
    const doc = await vscode.workspace.openTextDocument(uri);
    const other = this.editor();
    const viewColumn = other ? other.viewColumn : this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    const options = { viewColumn, preserveFocus };
    // Opened by scrolling: a preview tab, so a long document does not leave a tab per file.
    if (preserveFocus) options.preview = true;
    return vscode.window.showTextDocument(doc, options);
  }

  /**
   * Forward sync: show line `line` of the file at `uri` in the middle of the
   * preview, marked. Waits for the preview to be ready if it has just opened.
   */
  showLine(uri, line) {
    this.pendingLine = { uri: uri.toString(), line };
    this.flushLine();
  }

  flushLine() {
    const p = this.pendingLine;
    if (!p || !this.ready || !this.project || this.renderedText == null) return;
    this.pendingLine = null;
    const file = this.fileIndex(vscode.Uri.parse(p.uri));
    if (file < 0) return;
    this.holdPreview(1000); // the editor's own scroll sync must not undo it
    this.post({ type: 'show-line', line: p.line, file });
  }

  /** Keep the editor from scrolling the preview for a moment. */
  holdPreview(ms = 400) {
    this.holdUntil = Math.max(this.holdUntil || 0, Date.now() + ms);
  }

  syncEnabled() {
    return vscode.workspace.getConfiguration('texglass').get('scrollSync', true);
  }

  syncFromEditor(ed) {
    if (!this.syncEnabled() || Date.now() - this.lastPreviewScroll < 300 || Date.now() < (this.holdUntil || 0)) return;
    const file = this.fileIndex(ed.document.uri);
    if (file < 0 || !ed.visibleRanges.length) return;
    this.lastEditorScroll = Date.now();
    this.post({ type: 'scroll-to', line: ed.visibleRanges[0].start.line, file });
  }

  async syncFromPreview(line, file) {
    if (!this.syncEnabled() || Date.now() - this.lastEditorScroll < 300) return;
    this.lastPreviewScroll = Date.now();
    this.pendingScroll = { line, file };
    if (this.opening) return; // the file being opened takes the latest line once it shows
    let ed = this.editor(file);
    if (!ed && this.editor()) {
      // The preview has scrolled into a file pulled in with \input: show it in
      // place of the one the editor had, keeping the focus on the preview.
      this.opening = true;
      this.holdPreview(800);
      try {
        ed = await this.openFile(file, true);
      } catch (err) {
        ed = null;
      } finally {
        this.opening = false;
      }
      this.holdPreview();
      if (!ed || this.disposed) return;
      ({ line, file } = this.pendingScroll);
      if (this.fileIndex(ed.document.uri) !== file) return this.syncFromPreview(line, file);
    }
    if (!ed) return;
    this.lastPreviewScroll = Date.now();
    const l = Math.max(0, Math.min(Math.floor(line), ed.document.lineCount - 1));
    ed.revealRange(new vscode.Range(l, 0, l, 0), vscode.TextEditorRevealType.AtTop);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    if (this.notesWatcher) this.notesWatcher.dispose();
    if (this.onDispose) this.onDispose();
  }
}

// --- export to HTML ----------------------------------------------------------------

/** A file inside the extension, as bytes: through the file system, or fetched in the browser. */
async function readExtensionFile(context, ...parts) {
  const uri = vscode.Uri.joinPath(context.extensionUri, ...parts);
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (e) {
    if (typeof fetch !== 'function') throw e;
    const res = await fetch(uri.toString(true));
    if (!res.ok) throw new Error(`${res.status} ${uri}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

function base64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Where a figure is, seen from the folder the page is written to: a relative path when it can be. */
function figureUrlFrom(outDir, file) {
  if (file.scheme === outDir.scheme && file.authority === outDir.authority) {
    const rel = path.posix.relative(outDir.path, file.path);
    if (!/^[a-z]:/i.test(rel)) return rel.split('/').map(encodeURIComponent).join('/');
  }
  return file.scheme === 'file' ? file.toString() : null;
}

/**
 * Write the document `uri` belongs to as one standalone HTML page, with the
 * math rendered and the theorems numbered as in the preview. Asks where to
 * save it, next to the .tex file by default, unless `out` says.
 *
 * With `print`, the page goes to a temporary folder instead and opens in the
 * browser, which shows its print dialog at once: the stylesheet's print rules
 * lay it out like a paper, and "Save as PDF" there makes the PDF. (VS Code's
 * own webviews cannot print.)
 */
/**
 * With the handwritten notes look on, what an exported or printed page needs
 * to keep it: the <html> attributes, notes.css with its fonts inside it, and
 * the ink filters (not for printing). Null with the standard look, or if the fonts cannot be read.
 */
async function notesForExport(context, print) {
  const look = previewLook();
  if (look.look !== 'notes') return null;
  try {
    const decode = (b) => new TextDecoder().decode(b);
    let css = decode(await readExtensionFile(context, 'media', 'notes.css'));
    const fonts = new Map();
    for (const [, name] of css.matchAll(/url\(fonts\/([\w-]+\.woff2)\)/g)) fonts.set(name, null);
    await Promise.all(Array.from(fonts.keys(), async (n) => fonts.set(n, base64(await readExtensionFile(context, 'media', 'fonts', n)))));
    css = css.replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (_, n) => `url(data:font/woff2;base64,${fonts.get(n)})`);
    return {
      rootAttrs: { 'data-look': 'notes', 'data-paper': look.paper, 'data-hand': look.hand, 'data-hand-math': look.handMath, 'data-ink': look.ink, 'data-ink-texture': look.inkTexture },
      extraCss: css,
      // Printed ink is always flat (see notes.css), so a page made to print needs no filters.
      bodyStart: look.inkTexture === 'on' && !print ? INK_FILTERS : '',
    };
  } catch (e) {
    return null;
  }
}

async function exportHtml(context, converter, uri, out, print, view) {
  const project = await assembleDocument(uri, new Map());
  if (!project || project.error) {
    vscode.window.showErrorMessage(project ? project.error : `Could not read ${uri}.`);
    return null;
  }
  const name = path.posix.basename(uri.path);
  const suggested = uri.scheme === 'untitled' ? undefined : vscode.Uri.joinPath(uri, '..', TeXglassExport.fileName(name));
  if (print && !out) {
    const dir = path.join(os.tmpdir(), 'texglass-print');
    fs.mkdirSync(dir, { recursive: true });
    out = vscode.Uri.file(path.join(dir, TeXglassExport.fileName(name)));
  }
  if (!out) out = await vscode.window.showSaveDialog({
    defaultUri: suggested,
    filters: { HTML: ['html', 'htm'] },
    saveLabel: 'Export',
    title: 'Export to HTML',
  });
  if (!out) return null;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: print ? 'TeXglass: preparing to print…' : 'TeXglass: exporting to HTML…' }, async () => {
    const text = project.text;
    const outDir = vscode.Uri.joinPath(out, '..');
    let job;
    if (isVirtual(uri)) {
      const figures = await findFigureFiles(uri, text, new Map());
      for (const n of Object.keys(figures)) figures[n] = figures[n] ? figureUrlFrom(outDir, figures[n]) : null;
      job = { text, figures, plain: true };
    } else if (uri.scheme === 'file') {
      const dir = path.dirname(uri.fsPath);
      const base = figureUrlFrom(outDir, vscode.Uri.file(dir)) || vscode.Uri.file(dir).toString();
      job = { text, dir, base: base === '' ? '.' : base, plain: true };
    } else {
      job = { text, figures: {}, plain: true };
    }
    const m = await converter.render(job);
    if (m.error) {
      vscode.window.showErrorMessage('TeXglass could not convert the document: ' + m.error.split('\n')[0]);
      return null;
    }
    const decode = (b) => new TextDecoder().decode(b);
    const css = decode(await readExtensionFile(context, 'shared', 'styles.css'));
    let katexCss = null;
    if (vscode.workspace.getConfiguration('texglass').get('exportEmbedFonts', true)) {
      try {
        katexCss = await TeXglassExport.embedKatexFonts(
          decode(await readExtensionFile(context, 'node_modules', 'katex', 'dist', 'katex.min.css')),
          async (font) => base64(await readExtensionFile(context, 'node_modules', 'katex', 'dist', 'fonts', font))
        );
      } catch (e) {
        katexCss = null; // link KaTeX's stylesheet instead
      }
    }
    let diagramsJs = '';
    if (/class="tg-diagram/.test(m.result.html)) {
      try { diagramsJs = decode(await readExtensionFile(context, 'shared', 'diagrams.js')); } catch (e) { /* arrows are then missing */ }
    }
    const notes = await notesForExport(context, !!print);
    const html = TeXglassExport.page({
      body: m.result.html, title: m.result.title || name, css, katexCss, diagramsJs, print: !!print,
      view: print && view ? view : undefined,
      ...(notes || {}),
      // Paper prints light; on screen an exported page follows the reader's system.
      theme: notes && print ? 'light' : undefined,
    });
    await vscode.workspace.fs.writeFile(out, new TextEncoder().encode(html));
    if (print) {
      if (!(await vscode.env.openExternal(out))) vscode.window.showErrorMessage(`TeXglass could not open ${out.fsPath} in a browser.`);
      return out;
    }
    const actions = out.scheme === 'file' && !WEB ? ['Open in Browser'] : [];
    vscode.window.showInformationMessage(`Exported ${path.posix.basename(out.path)}`, ...actions).then((pick) => {
      if (pick === 'Open in Browser') vscode.env.openExternal(out);
    });
    return out;
  });
}

/**
 * Export the document as an EPUB e-book (src/epub.js). With the document open
 * in the preview, the preview draws its diagrams and its PDF and EPS figures
 * first, so the book shows them in any e-reader; otherwise the book draws
 * the diagrams with a script (Apple Books, Thorium, Calibre run it) and
 * leaves PDF and EPS figures out. preview is the open preview, if any.
 */
async function exportEpub(context, converter, uri, out, preview) {
  const project = await assembleDocument(uri, new Map());
  if (!project || project.error) {
    vscode.window.showErrorMessage(project ? project.error : `Could not read ${uri}.`);
    return null;
  }
  const name = path.posix.basename(uri.path);
  if (!out) out = await vscode.window.showSaveDialog({
    defaultUri: uri.scheme === 'untitled' ? undefined : vscode.Uri.joinPath(uri, '..', TeXglassEpub.fileName(name)),
    filters: { EPUB: ['epub'] },
    saveLabel: 'Export',
    title: 'Export to EPUB',
  });
  if (!out) return null;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TeXglass: exporting to EPUB…' }, async () => {
    const text = project.text;
    const pv = preview && preview.ready && !preview.disposed && preview.uri.toString() === uri.toString() ? preview : null;
    let figures = {};
    try { figures = uri.scheme === 'untitled' ? {} : await findFigureFiles(uri, text, new Map()); } catch (e) { figures = {}; }
    // Figures by a name the book's builder asks for again: a webview URL for
    // the preview to fetch, or the file's own URI to read here.
    const byUrl = new Map();
    const names = {};
    for (const [n, f] of Object.entries(figures)) {
      if (!f) { names[n] = null; continue; }
      const url = pv ? pv.panel.webview.asWebviewUri(f).toString() : f.toString();
      byUrl.set(url, f);
      names[n] = url;
    }
    const m = await converter.render({ text, figures: names, plain: true });
    if (m.error) {
      vscode.window.showErrorMessage('TeXglass could not convert the document: ' + m.error.split('\n')[0]);
      return null;
    }
    let body = m.result.html;
    let drawn = false;
    if (pv) {
      const ready = await pv.prepareEpub(body);
      if (ready != null) { body = ready; drawn = true; }
    }
    const decode = (b) => new TextDecoder().decode(b);
    const katexDir = ['node_modules', 'katex', 'dist'];
    let diagramsJs = '';
    if (!drawn && /class="tg-diagram/.test(body)) {
      try { diagramsJs = decode(await readExtensionFile(context, 'shared', 'diagrams.js')); } catch (e) { /* arrows are then missing */ }
    }
    const { bytes, warnings } = await TeXglassEpub.build({
      body,
      title: m.result.title || name,
      toc: m.result.toc,
      katexCss: decode(await readExtensionFile(context, ...katexDir, 'katex.min.css')),
      readFont: (font) => readExtensionFile(context, ...katexDir, 'fonts', font),
      readImage: async (src) => {
        const f = byUrl.get(src);
        return f ? { data: await vscode.workspace.fs.readFile(f) } : null;
      },
      diagramsDrawn: drawn,
      diagramsJs,
    });
    await vscode.workspace.fs.writeFile(out, bytes);
    const left = warnings.filter((w) => w.startsWith('Left out a figure')).length;
    const note = left ? ` ${left} figure${left === 1 ? ' was' : 's were'} left out${pv ? '' : ' (open the preview first to include PDF and EPS figures)'}.` : '';
    vscode.window.showInformationMessage(`Exported ${path.posix.basename(out.path)}.${note}`);
    return out;
  });
}

// --- activation -------------------------------------------------------------------

/**
 * Until version 0.3.0 the extension was called TeXdown and its settings were
 * texdown.scrollSync and texdown.previewTheme. Copy any the user had set to
 * the texglass.* names, once for the user settings and once per workspace, so
 * that clearing a new setting later does not bring the old value back. The old
 * entries stay in settings.json: VS Code refuses to write keys that no
 * installed extension declares.
 */
const OLD_SETTINGS = ['scrollSync', 'previewTheme'];

async function migrateOldSettings(context) {
  const oldConfig = vscode.workspace.getConfiguration('texdown');
  const config = vscode.workspace.getConfiguration('texglass');
  const levels = [
    { memento: context.globalState, target: vscode.ConfigurationTarget.Global, value: 'globalValue' },
  ];
  if (vscode.workspace.workspaceFolders) {
    levels.push({ memento: context.workspaceState, target: vscode.ConfigurationTarget.Workspace, value: 'workspaceValue' });
  }
  for (const level of levels) {
    if (level.memento.get('texglass.settingsMigrated')) continue;
    for (const key of OLD_SETTINGS) {
      const was = oldConfig.inspect(key);
      const now = config.inspect(key);
      if (was && was[level.value] !== undefined && (!now || now[level.value] === undefined)) {
        try {
          await config.update(key, was[level.value], level.target);
        } catch (e) { /* settings not writable here: keep the default */ }
      }
    }
    await level.memento.update('texglass.settingsMigrated', true);
  }
}

function activate(context) {
  migrateOldSettings(context).catch(() => {});
  // Each paper's notes travel with VS Code's Settings Sync, when the reader has it on.
  if (context.globalState.setKeysForSync) context.globalState.setKeysForSync([NOTES_STATE]);
  const converter = new Converter(context.extensionPath);
  context.subscriptions.push(converter);
  let preview = null;

  const attach = (p) => {
    preview = p;
    updateSyncItem(context);
    p.onDispose = () => {
      if (preview === p) preview = null;
      updateSyncItem(context);
    };
  };
  syncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  syncItem.name = 'TeXglass notes sync';
  syncItem.command = 'texglass.notesSyncStatus';
  syncHasPreview = () => !!preview;
  const syncTick = setInterval(() => updateSyncItem(context), 60000); // keep "last synced" fresh
  context.subscriptions.push(syncItem, { dispose: () => clearInterval(syncTick) });

  async function open(uri, column) {
    if (!uri) {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !isTex(ed.document)) {
        vscode.window.showInformationMessage('Open a .tex file to preview it with TeXglass.');
        return;
      }
      uri = ed.document.uri;
    }
    // Previewing a chapter shows the whole document it belongs to.
    try {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const text = doc ? doc.getText() : isVirtual(uri) ? await readText(uri) : uri.scheme === 'file' ? readSource(uri.fsPath) : null;
      uri = await rootOf(uri, text || '');
    } catch (e) {
      /* keep the file itself */
    }
    if (preview) {
      preview.setDocument(uri);
      preview.panel.reveal(column, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Preview', { viewColumn: column, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    attach(new Preview(context, converter, panel, uri));
  }

  // Forward sync: the preview jumps to where the cursor is. It opens the
  // preview first if needed; in a file pulled in with \input it shows the
  // whole document, at that file's line.
  async function showCursor() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isTex(ed.document)) {
      vscode.window.showInformationMessage('Put the cursor in a .tex file to show that spot in the TeXglass preview.');
      return;
    }
    const { uri } = ed.document;
    const line = ed.selection.active.line;
    if (preview && preview.hasFile(uri)) preview.panel.reveal(preview.panel.viewColumn, true);
    else await open(uri, preview ? preview.panel.viewColumn || vscode.ViewColumn.Beside : vscode.ViewColumn.Beside);
    if (preview) preview.showLine(uri, line);
  }

  function setScrollSync(on) {
    const config = vscode.workspace.getConfiguration('texglass');
    // Change it where it is set now: the workspace if it overrides it there, else for the user.
    const info = config.inspect('scrollSync');
    const target = info && info.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    return config.update('scrollSync', on, target).then(() => {
      vscode.window.setStatusBarMessage(on ? 'TeXglass: the preview scrolls with the editor' : 'TeXglass: the preview scrolls on its own', 2500);
      // Line the preview up again straight away.
      const ed = preview && preview.editor();
      if (on && ed) preview.syncFromEditor(ed);
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('texglass.openPreviewToSide', (uri) => open(uri instanceof vscode.Uri ? uri : null, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('texglass.openPreview', (uri) => open(uri instanceof vscode.Uri ? uri : null, vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('texglass.showCursor', showCursor),
    // The button in the preview's title bar turns scrolling in step on or off.
    vscode.commands.registerCommand('texglass.enableScrollSync', () => setScrollSync(true)),
    vscode.commands.registerCommand('texglass.disableScrollSync', () => setScrollSync(false)),
    // The Contents and Hide/Show proofs buttons in the preview's title bar.
    vscode.commands.registerCommand('texglass.find', () => preview && preview.post({ type: 'find', mode: 'find' })),
    vscode.commands.registerCommand('texglass.selectResults', () => {
      if (preview) preview.post({ type: 'pick' });
      else vscode.window.showInformationMessage('Open a TeXglass preview first (Ctrl+K V in a .tex file).');
    }),
    vscode.commands.registerCommand('texglass.goTo', () => preview && preview.post({ type: 'find', mode: 'goto' })),
    // Back to where the preview was before a jump, and forward again (Alt+Left / Alt+Right).
    vscode.commands.registerCommand('texglass.back', () => preview && preview.post({ type: 'history', dir: -1 })),
    vscode.commands.registerCommand('texglass.forward', () => preview && preview.post({ type: 'history', dir: 1 })),
    vscode.commands.registerCommand('texglass.findNext', () => preview && preview.post({ type: 'find-step', dir: 1 })),
    vscode.commands.registerCommand('texglass.findPrevious', () => preview && preview.post({ type: 'find-step', dir: -1 })),
    vscode.commands.registerCommand('texglass.showNotation', () => preview && preview.post({ type: 'insight', tab: 'notation' })),
    vscode.commands.registerCommand('texglass.showDependencies', () => preview && preview.post({ type: 'insight', tab: 'deps' })),
    vscode.commands.registerCommand('texglass.showLargerMap', () => preview && preview.post({ type: 'larger-map' })),
    // The preview's Settings panel: switch reading aids on or off (texglass.* settings).
    vscode.commands.registerCommand('texglass.showSettings', () => {
      if (preview) preview.post({ type: 'show-settings' });
      else vscode.commands.executeCommand('workbench.action.openSettings', '@ext:klepo1.texglass');
    }),
    // A quiet link at the end of the preview's … menu: TeXglass's Buy Me a Coffee page.
    vscode.commands.registerCommand('texglass.support', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://buymeacoffee.com/texglass'))),
    vscode.commands.registerCommand('texglass.toggleContents', () => preview && preview.post({ type: 'toggle-toc' })),
    // Zoom the document in the preview (Ctrl/Cmd +, - and 0 while it has focus).
    vscode.commands.registerCommand('texglass.zoomIn', () => preview && preview.post({ type: 'zoom-step', dir: 1 })),
    vscode.commands.registerCommand('texglass.zoomOut', () => preview && preview.post({ type: 'zoom-step', dir: -1 })),
    vscode.commands.registerCommand('texglass.resetZoom', () => preview && preview.post({ type: 'zoom-step', dir: 0 })),
    vscode.commands.registerCommand('texglass.toggleContentsPosition', () =>
      setConfig('contentsPosition', contentsPosition() === 'right' ? 'left' : 'right')),
    vscode.commands.registerCommand('texglass.hideProofs', () => preview && preview.post({ type: 'fold-proofs', fold: true })),
    vscode.commands.registerCommand('texglass.showProofs', () => preview && preview.post({ type: 'fold-proofs', fold: false })),
    vscode.commands.registerCommand('texglass.toggleHandwriting', () =>
      setConfig('previewStyle', previewLook().look === 'notes' ? 'standard' : 'handwritten')),
    vscode.commands.registerCommand('texglass.toggleStudyTools', () => setConfig('studyTools', !studyTools())),
    // Jump between the notes in the margin (N and Shift+N while the preview has focus).
    vscode.commands.registerCommand('texglass.nextMarginNote', () => preview && preview.post({ type: 'margin-jump', dir: 1 })),
    vscode.commands.registerCommand('texglass.previousMarginNote', () => preview && preview.post({ type: 'margin-jump', dir: -1 })),
    // The reader's notes: to a file and back, and synced through a private gist.
    vscode.commands.registerCommand('texglass.exportNotes', async () => {
      if (!preview) return vscode.window.showInformationMessage('Open a TeXglass preview first (Ctrl+K V in a .tex file).');
      const key = await preview.paperKey();
      const rec = preview.notesRecord || NotesSync.empty(key);
      if (NotesSync.isEmpty(rec)) return vscode.window.showInformationMessage('This paper has no highlights, notes or reading progress yet.');
      const base = path.posix.basename(preview.uri.path).replace(/\.(tex|ltx|latex)$/i, '');
      const home = os && os.homedir ? os.homedir() : null;
      const dir = home && fs && fs.existsSync(path.join(home, 'Downloads')) ? vscode.Uri.file(path.join(home, 'Downloads')) : vscode.Uri.joinPath(preview.uri, '..');
      const to = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(dir, `${base}-notes.texglass.json`),
        filters: { 'TeXglass notes': ['json'] },
        saveLabel: 'Export notes',
      });
      if (!to) return;
      await vscode.workspace.fs.writeFile(to, new TextEncoder().encode(NotesSync.toFile(Object.assign({}, rec, { paper: key }))));
      vscode.window.showInformationMessage(`Exported ${rec.notes.length} note${rec.notes.length === 1 ? '' : 's'} to ${path.posix.basename(to.path)}.`);
    }),
    vscode.commands.registerCommand('texglass.importNotes', async () => {
      if (!preview) return vscode.window.showInformationMessage('Open a TeXglass preview first (Ctrl+K V in a .tex file).');
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'TeXglass notes': ['json'] }, openLabel: 'Import notes' });
      if (!picked || !picked[0]) return;
      const key = await preview.paperKey();
      let papers;
      try {
        papers = NotesSync.parseFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(picked[0])), key);
      } catch (e) {
        return vscode.window.showWarningMessage('That file is not a TeXglass notes file.');
      }
      const keys = Object.keys(papers);
      // One paper's file goes on this paper; a file of many papers (the gist's) fills in each.
      if (keys.length > 1) {
        for (const k of keys) {
          if (k === key) continue;
          const had = notesStore(context)[k];
          await keepNotes(context, k, NotesSync.merge(had ? Object.assign({ paper: k }, had) : NotesSync.empty(k), Object.assign({}, papers[k], { paper: k })));
        }
      }
      const mine = keys.length === 1 ? papers[keys[0]] : papers[key];
      const added = mine ? await preview.takeNotes(mine) : 0;
      preview.syncGist();
      vscode.window.showInformationMessage(keys.length > 1
        ? `Imported notes for ${keys.length} papers, ${added} new in this one.`
        : `Imported ${added} new note${added === 1 ? '' : 's'}.`);
    }),
    vscode.commands.registerCommand('texglass.syncNotes', async () => {
      const g = await notesGist(context, true);
      if (!g) return;
      const was = context.globalState.get('texglass.gistSync', false);
      await context.globalState.update('texglass.gistSync', true);
      try {
        const local = {};
        for (const [k, r] of Object.entries(notesStore(context))) local[k] = Object.assign({ paper: k }, r);
        const merged = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TeXglass: syncing notes with GitHub…' }, () => g.sync(null, local));
        if (g.id()) await context.globalState.update('texglass.gistId', g.id());
        for (const [k, r] of Object.entries(merged)) await keepNotes(context, k, r);
        if (preview) await preview.syncGist(true);
        await recordSync(context, '');
        const n = Object.keys(merged).length;
        vscode.window.showInformationMessage(was
          ? `TeXglass notes synced (${n} paper${n === 1 ? '' : 's'}). They already sync automatically, so you don't need this command.`
          : `TeXglass notes now sync automatically with a private gist on your GitHub account (texglass-notes.json, ${n} paper${n === 1 ? '' : 's'}): when you open a paper and a few seconds after each change. You don't need to run this command again.`);
      } catch (e) {
        await recordSync(context, String(e.message || e));
        vscode.window.showWarningMessage(`TeXglass could not sync the notes: ${e.message || e}`);
      }
    }),
    // The status bar item: sync now (rarely needed) or stop.
    vscode.commands.registerCommand('texglass.notesSyncStatus', async () => {
      const pick = await vscode.window.showQuickPick([
        { label: '$(check) Keep syncing automatically', description: 'nothing to do', id: 'ok' },
        { label: '$(sync) Sync now', description: 'not needed, it happens on its own', id: 'now' },
        { label: '$(circle-slash) Stop syncing with GitHub', id: 'stop' },
      ], { placeHolder: `TeXglass notes: ${syncStateLine(context)}` });
      if (pick && pick.id === 'now') vscode.commands.executeCommand('texglass.syncNotes');
      if (pick && pick.id === 'stop') vscode.commands.executeCommand('texglass.stopSyncingNotes');
    }),
    vscode.commands.registerCommand('texglass.stopSyncingNotes', async () => {
      await context.globalState.update('texglass.gistSync', false);
      updateSyncItem(context);
      vscode.window.showInformationMessage('TeXglass no longer syncs notes with GitHub. They stay next to each .tex file, and in the gist as they were.');
    }),
    vscode.commands.registerCommand('texglass.toggleTheme', () => {
      if (preview) preview.post({ type: 'toggle-theme' });
      else vscode.window.showInformationMessage('Open a TeXglass preview first (Ctrl+K V in a .tex file).');
    }),
    // Export the document as a standalone .html file: the one given (Explorer),
    // else the LaTeX file being edited, else the one the preview shows.
    // Other extensions and tasks may pass where to write it as a second argument.
    vscode.commands.registerCommand('texglass.exportHtml', async (uri, out, print, view) => {
      if (!(uri instanceof vscode.Uri)) {
        const ed = vscode.window.activeTextEditor;
        if (ed && isTex(ed.document)) uri = ed.document.uri;
        else if (preview) uri = preview.uri;
        else {
          vscode.window.showInformationMessage(print ? 'Open a .tex file to print it.' : 'Open a .tex file to export it to HTML.');
          return null;
        }
      }
      if (!(preview && uri.toString() === preview.uri.toString())) {
        // A chapter exports the whole document it belongs to, as the preview shows it.
        try {
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
          const text = doc ? doc.getText() : isVirtual(uri) ? await readText(uri) : uri.scheme === 'file' ? readSource(uri.fsPath) : null;
          uri = await rootOf(uri, text || '');
        } catch (e) { /* keep the file itself */ }
      }
      return exportHtml(context, converter, uri, out instanceof vscode.Uri ? out : undefined, print === true, view && typeof view === 'object' ? view : undefined);
    }),
    // Export the document as an EPUB e-book, chosen as for Export to HTML.
    vscode.commands.registerCommand('texglass.exportEpub', async (uri, out) => {
      if (!(uri instanceof vscode.Uri)) {
        const ed = vscode.window.activeTextEditor;
        if (ed && isTex(ed.document)) uri = ed.document.uri;
        else if (preview) uri = preview.uri;
        else {
          vscode.window.showInformationMessage('Open a .tex file to export it to EPUB.');
          return null;
        }
      }
      if (!(preview && uri.toString() === preview.uri.toString())) {
        try {
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
          const text = doc ? doc.getText() : isVirtual(uri) ? await readText(uri) : uri.scheme === 'file' ? readSource(uri.fsPath) : null;
          uri = await rootOf(uri, text || '');
        } catch (e) { /* keep the file itself */ }
      }
      return exportEpub(context, converter, uri, out instanceof vscode.Uri ? out : undefined, preview);
    }),
    // Print the document, or save it as a PDF, laid out like a paper. On the
    // desktop it opens in the browser (webviews cannot print); in vscode.dev and
    // github.dev, where the preview is a page of the browser, it prints the preview.
    vscode.commands.registerCommand('texglass.print', async (uri, out) => {
      if (WEB) {
        if (preview) preview.post({ type: 'print' });
        else vscode.window.showInformationMessage('Open a TeXglass preview first (Ctrl+K V in a .tex file), then print it.');
        return null;
      }
      // The document the preview shows: print what the preview shows (only
      // the selected results, or what "Hide the rest" leaves). The preview
      // answers with a 'print' message.
      if (preview && preview.ready && !(uri instanceof vscode.Uri) && !(out instanceof vscode.Uri)) {
        const ed = vscode.window.activeTextEditor;
        let target = preview.uri;
        if (ed && isTex(ed.document) && ed.document.uri.toString() !== preview.uri.toString()) {
          try { target = await rootOf(ed.document.uri, ed.document.getText()); } catch (e) { target = ed.document.uri; }
        }
        if (target.toString() === preview.uri.toString()) {
          preview.post({ type: 'print-view' });
          return null;
        }
      }
      return vscode.commands.executeCommand('texglass.exportHtml', uri, out, true);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (preview && e.affectsConfiguration('texglass.contentsPosition')) {
        preview.post({ type: 'toc-side', value: contentsPosition() });
      }
      if (preview && e.affectsConfiguration('texglass.readingProgress')) {
        preview.post({ type: 'reading-progress', on: readingProgress() });
      }
      if (preview && e.affectsConfiguration('texglass.studyTools')) {
        preview.post({ type: 'study', on: studyTools() });
      }
      if (preview && e.affectsConfiguration('texglass')) {
        preview.post({ type: 'features', prefs: featureSettings() });
      }
      if (preview && e.affectsConfiguration('texglass.notationHover')) {
        preview.post({ type: 'notation-hover', on: notationHover() });
      }
      if (preview && e.affectsConfiguration('texglass.clickToCopyMath')) {
        preview.post({ type: 'click-to-copy', on: clickToCopy() });
      }
      if (preview && (e.affectsConfiguration('texglass.previewStyle') || e.affectsConfiguration('texglass.notes'))) {
        preview.post({ type: 'look', ...previewLook() });
      }
      if (preview && e.affectsConfiguration('texglass.previewTheme')) {
        preview.post({ type: 'theme', value: vscode.workspace.getConfiguration('texglass').get('previewTheme', 'auto') });
      }
    }),
    vscode.commands.registerCommand('texglass.toggleScrollSync', () =>
      setScrollSync(!vscode.workspace.getConfiguration('texglass').get('scrollSync', true))),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!preview || !e.contentChanges.length) return;
      const d = e.document;
      if (d.uri.toString() === preview.uri.toString() || preview.depends(d.uri)) preview.update(true);
    }),
    // Files on disk that the preview pulls in: \input files, .bib and .bbl.
    (() => {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib,bbl,ltx}');
      const changed = (uri) => {
        if (!preview) return;
        preview.forget(uri);
        if (preview.depends(uri)) preview.update(true);
      };
      watcher.onDidChange(changed);
      watcher.onDidCreate(changed);
      watcher.onDidDelete(changed);
      return watcher;
    })(),
    // The preview follows the LaTeX file you are editing, unless that file is
    // part of the document it shows already.
    vscode.window.onDidChangeActiveTextEditor(async (ed) => {
      if (!preview || !ed || !isTex(ed.document)) return;
      if (preview.hasFile(ed.document.uri)) {
        preview.syncFromEditor(ed);
        return;
      }
      const root = await rootOf(ed.document.uri, ed.document.getText());
      if (preview) preview.setDocument(root);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (preview && preview.fileIndex(e.textEditor.document.uri) >= 0) preview.syncFromEditor(e.textEditor);
    }),
    // Bring back a preview that was open when VS Code was closed.
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        if (!state || !state.uri) {
          panel.dispose();
          return;
        }
        if (preview) preview.panel.dispose();
        attach(new Preview(context, converter, panel, vscode.Uri.parse(state.uri)));
      },
    })
  );

  return { _preview: () => preview }; // for the tests
}

function deactivate() {}

module.exports = { activate, deactivate, lineIndex, findInBlock };
