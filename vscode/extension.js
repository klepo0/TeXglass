/*
 * TeXdown for VS Code: a live preview of LaTeX files beside the editor.
 *
 * The preview follows the active LaTeX editor, like VS Code's Markdown
 * preview. Conversion runs in a worker thread (render-worker.js); the webview
 * (media/preview.js) updates only the blocks that changed, and the two sides
 * keep their scroll positions in step through the source lines of each block.
 */
'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { assemble, locate, findRoot } = require('./project.js');
const { Worker } = require('worker_threads');

const VIEW_TYPE = 'texdown.preview';

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
function setContext(key, value) {
  vscode.commands.executeCommand('setContext', key, value);
}

const normPath = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));

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
function rootOf(uri, text) {
  if (uri.scheme !== 'file') return uri;
  const listTex = (dir) => {
    try {
      return fs.readdirSync(dir).filter((n) => /\.tex$/i.test(n)).slice(0, 200).map((n) => path.join(dir, n));
    } catch (e) {
      return [];
    }
  };
  const root = findRoot(uri.fsPath, text, listTex, readSource);
  return root === uri.fsPath || !fs.existsSync(root) ? uri : vscode.Uri.file(root);
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
    panel.webview.html = this.html();
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
      `img-src ${webview.cspSource} https: data:`,
      // KaTeX positions glyphs with inline style attributes.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${res('node_modules', 'katex', 'dist', 'katex.min.css')}">
<link rel="stylesheet" href="${res('shared', 'styles.css')}">
<link rel="stylesheet" href="${res('media', 'preview.css')}">
</head>
<body>
<main class="panes"><nav class="toc-pane" id="toc-pane" aria-label="Table of contents" hidden><div class="toc-pane-title">Contents</div><ol id="toc-list" class="toc-list"></ol></nav><section class="pane" id="preview-pane"><article id="preview" class="document"></article></section></main>
<div id="ref-popover" class="ref-popover" hidden></div>
<div id="status" class="texdown-status" hidden></div>
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
    const isFile = this.uri.scheme === 'file';
    const dir = isFile ? path.dirname(this.uri.fsPath) : null;
    const base = isFile ? this.panel.webview.asWebviewUri(vscode.Uri.file(dir)).toString() : null;
    const slow = setTimeout(() => this.post({ type: 'status', text: 'Rendering…' }), 400);
    try {
      const uri = this.uri.toString();
      const m = await this.converter.render({ text, dir, base });
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
        this.post({ type: 'render', blocks: r.blocks, lines, toc: r.toc, warnings: project.warnings.concat(r.warnings) });
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

  /**
   * The document as TeXdown sees it: the file with its \input files and
   * bibliography pulled in. Open editors win over the files on disk, so the
   * preview shows unsaved changes in any of them.
   */
  async assembleProject() {
    if (this.uri.scheme !== 'file') {
      let doc = this.document;
      try {
        if (!doc) doc = await vscode.workspace.openTextDocument(this.uri);
      } catch (e) {
        return { error: `Could not open ${this.uri}: ${e.message || e}` };
      }
      const text = doc.getText().replace(/\r\n?/g, '\n');
      const key = this.uri.toString();
      return { text, files: [key], texts: { [key]: text }, segments: [{ start: 0, end: text.length, file: 0, at: 0 }], deps: [], warnings: [] };
    }
    const project = assemble(this.uri.fsPath, readSource);
    if (!project) return { error: `Could not read ${this.uri.fsPath}.` };
    this.deps = new Set(project.deps.map(normPath));
    return project;
  }

  /** Whether the preview shows (part of) this file, or would change with it. */
  depends(fsPath) {
    return !!this.deps && this.deps.has(normPath(fsPath));
  }

  hasFile(fsPath) {
    return !!this.project && this.project.files.some((f) => normPath(f) === normPath(fsPath));
  }

  fileIndex(uri) {
    if (!this.project) return -1;
    const key = uri.scheme === 'file' ? normPath(uri.fsPath) : uri.toString();
    return this.project.files.findIndex((f) => (uri.scheme === 'file' ? normPath(f) : f) === key);
  }

  post(message) {
    if (!this.disposed) this.panel.webview.postMessage(message);
  }

  onMessage(m) {
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        this.post({ type: 'doc', uri: this.uri.toString() });
        this.post({ type: 'prefs', folds: this.context.globalState.get('texdown.folds', []), toc: this.context.globalState.get('texdown.toc', true) });
        setContext('texdown.tocOpen', this.context.globalState.get('texdown.toc', true));
        setContext('texdown.hasProofs', false);
        this.post({ type: 'theme', value: vscode.workspace.getConfiguration('texdown').get('previewTheme', 'auto') });
        this.renderedText = null;
        this.render().then(() => {
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
        this.context.globalState.update('texdown.folds', m.keys.slice(-500));
        break;
      case 'toc':
        this.context.globalState.update('texdown.toc', m.on);
        setContext('texdown.tocOpen', m.on);
        break;
      case 'set-theme':
        vscode.workspace.getConfiguration('texdown').update('previewTheme', m.value, vscode.ConfigurationTarget.Global);
        break;
      case 'proofs':
        setContext('texdown.hasProofs', m.has);
        setContext('texdown.proofsFolded', m.folded);
        break;
      case 'shown':
        this.shown = m; // what the webview shows, for the tests
        break;
      case 'open-link':
        if (/^https?:|^mailto:/.test(m.href)) vscode.env.openExternal(vscode.Uri.parse(m.href));
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
    const name = this.project ? this.project.files[file] : null;
    const uri = !name ? this.uri : this.uri.scheme === 'file' ? vscode.Uri.file(name) : vscode.Uri.parse(name);
    let ed = this.editor(file);
    if (!ed) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const other = this.editor();
      ed = await vscode.window.showTextDocument(doc, { viewColumn: other ? other.viewColumn : vscode.ViewColumn.One });
    } else {
      ed = await vscode.window.showTextDocument(ed.document, ed.viewColumn);
    }
    const pos = ed.document.validatePosition(new vscode.Position(Math.max(0, line), col || 0));
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  syncEnabled() {
    return vscode.workspace.getConfiguration('texdown').get('scrollSync', true);
  }

  syncFromEditor(ed) {
    if (!this.syncEnabled() || Date.now() - this.lastPreviewScroll < 300) return;
    const file = this.fileIndex(ed.document.uri);
    if (file < 0 || !ed.visibleRanges.length) return;
    this.lastEditorScroll = Date.now();
    this.post({ type: 'scroll-to', line: ed.visibleRanges[0].start.line, file });
  }

  syncFromPreview(line, file) {
    if (!this.syncEnabled() || Date.now() - this.lastEditorScroll < 300) return;
    const ed = this.editor(file);
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
    if (this.onDispose) this.onDispose();
  }
}

// --- activation -------------------------------------------------------------------

function activate(context) {
  const converter = new Converter(context.extensionPath);
  context.subscriptions.push(converter);
  let preview = null;

  const attach = (p) => {
    preview = p;
    p.onDispose = () => {
      if (preview === p) preview = null;
    };
  };

  function open(uri, column) {
    if (!uri) {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !isTex(ed.document)) {
        vscode.window.showInformationMessage('Open a .tex file to preview it with TeXdown.');
        return;
      }
      uri = ed.document.uri;
    }
    // Previewing a chapter shows the whole document it belongs to.
    try {
      uri = rootOf(uri, readSource(uri.fsPath) || '');
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

  function setScrollSync(on) {
    const config = vscode.workspace.getConfiguration('texdown');
    // Change it where it is set now: the workspace if it overrides it there, else for the user.
    const info = config.inspect('scrollSync');
    const target = info && info.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    return config.update('scrollSync', on, target).then(() => {
      vscode.window.setStatusBarMessage(on ? 'TeXdown: the preview scrolls with the editor' : 'TeXdown: the preview scrolls on its own', 2500);
      // Line the preview up again straight away.
      const ed = preview && preview.editor();
      if (on && ed) preview.syncFromEditor(ed);
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('texdown.openPreviewToSide', (uri) => open(uri instanceof vscode.Uri ? uri : null, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('texdown.openPreview', (uri) => open(uri instanceof vscode.Uri ? uri : null, vscode.ViewColumn.Active)),
    // The button in the preview's title bar turns scrolling in step on or off.
    vscode.commands.registerCommand('texdown.enableScrollSync', () => setScrollSync(true)),
    vscode.commands.registerCommand('texdown.disableScrollSync', () => setScrollSync(false)),
    // The Contents and Hide/Show proofs buttons in the preview's title bar.
    vscode.commands.registerCommand('texdown.toggleContents', () => preview && preview.post({ type: 'toggle-toc' })),
    vscode.commands.registerCommand('texdown.hideProofs', () => preview && preview.post({ type: 'fold-proofs', fold: true })),
    vscode.commands.registerCommand('texdown.showProofs', () => preview && preview.post({ type: 'fold-proofs', fold: false })),
    vscode.commands.registerCommand('texdown.toggleTheme', () => {
      if (preview) preview.post({ type: 'toggle-theme' });
      else vscode.window.showInformationMessage('Open a TeXdown preview first (Ctrl+K V in a .tex file).');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (preview && e.affectsConfiguration('texdown.previewTheme')) {
        preview.post({ type: 'theme', value: vscode.workspace.getConfiguration('texdown').get('previewTheme', 'auto') });
      }
    }),
    vscode.commands.registerCommand('texdown.toggleScrollSync', () =>
      setScrollSync(!vscode.workspace.getConfiguration('texdown').get('scrollSync', true))),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!preview || !e.contentChanges.length) return;
      const d = e.document;
      if (d.uri.toString() === preview.uri.toString() || (d.uri.scheme === 'file' && preview.depends(d.uri.fsPath))) preview.update(true);
    }),
    // Files on disk that the preview pulls in: \input files, .bib and .bbl.
    (() => {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib,bbl,ltx}');
      const changed = (uri) => {
        if (preview && preview.depends(uri.fsPath)) preview.update(true);
      };
      watcher.onDidChange(changed);
      watcher.onDidCreate(changed);
      watcher.onDidDelete(changed);
      return watcher;
    })(),
    // The preview follows the LaTeX file you are editing, unless that file is
    // part of the document it shows already.
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!preview || !ed || !isTex(ed.document)) return;
      if (ed.document.uri.scheme === 'file' && preview.hasFile(ed.document.uri.fsPath)) {
        preview.syncFromEditor(ed);
        return;
      }
      preview.setDocument(rootOf(ed.document.uri, ed.document.getText()));
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
