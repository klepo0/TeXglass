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

const BLOCK_HEAD = /^<div class="src-block" data-s="(\d+)" data-e="(\d+)">/;

// --- the preview panel --------------------------------------------------------------

class Preview {
  constructor(context, converter, panel, uri) {
    this.context = context;
    this.converter = converter;
    this.panel = panel;
    this.uri = uri;
    this.version = -1;
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
    this.version = -1;
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
    let doc = this.document;
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(this.uri);
      } catch (e) {
        this.post({ type: 'error', text: `Could not open ${this.uri.fsPath || this.uri}: ${e.message || e}` });
        return;
      }
    }
    if (this.disposed || doc.uri.toString() !== this.uri.toString() || doc.version === this.version) return;
    this.busy = true;
    const version = doc.version;
    const text = doc.getText().replace(/\r\n?/g, '\n');
    const isFile = doc.uri.scheme === 'file';
    const dir = isFile ? path.dirname(doc.uri.fsPath) : null;
    const base = isFile ? this.panel.webview.asWebviewUri(vscode.Uri.file(dir)).toString() : null;
    const slow = setTimeout(() => this.post({ type: 'status', text: 'Rendering…' }), 400);
    try {
      const uri = this.uri.toString();
      const m = await this.converter.render({ text, dir, base });
      if (this.disposed || uri !== this.uri.toString() || !this.ready) return;
      if (m.error) {
        this.post({ type: 'error', text: m.error });
      } else {
        const lineOf = lineIndex(text);
        const r = m.result;
        const lines = r.blocks.map((html) => {
          const h = BLOCK_HEAD.exec(html);
          return h ? [lineOf(Number(h[1])), lineOf(Math.max(Number(h[1]), Number(h[2]) - 1))] : null;
        });
        this.version = version;
        this.post({ type: 'render', blocks: r.blocks, lines, toc: r.toc, warnings: r.warnings });
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
        this.version = -1;
        this.render().then(() => {
          const ed = this.editor();
          if (ed && ed.visibleRanges.length) this.syncFromEditor(ed);
        });
        break;
      }
      case 'reveal':
        this.reveal(m.line);
        break;
      case 'reveal-at':
        this.revealAt(m);
        break;
      case 'scroll':
        this.syncFromPreview(m.line);
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

  editor() {
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.uri.toString());
  }

  /** Put the cursor at `line` in the source, opening it if needed. */
  /** Go to the spot in the source that was clicked in the preview (see whereClicked in preview.js). */
  async revealAt(m) {
    const doc = this.document || (await vscode.workspace.openTextDocument(this.uri));
    const text = doc.getText().replace(/\r\n?/g, '\n');
    const s = Math.min(m.s, text.length);
    const offset = s + findInBlock(text.slice(s, Math.min(m.e, text.length)), m);
    // Offsets are in the text with \n line endings, so count lines there.
    const line = lineIndex(text)(offset);
    const col = offset - (text.lastIndexOf('\n', offset - 1) + 1);
    return this.reveal(line, col);
  }

  async reveal(line, col) {
    let ed = this.editor();
    if (!ed) {
      const doc = await vscode.workspace.openTextDocument(this.uri);
      ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
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
    this.lastEditorScroll = Date.now();
    const range = ed.visibleRanges[0];
    this.post({ type: 'scroll-to', line: range.start.line });
  }

  syncFromPreview(line) {
    if (!this.syncEnabled() || Date.now() - this.lastEditorScroll < 300) return;
    const ed = this.editor();
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
      if (preview && e.document.uri.toString() === preview.uri.toString()) preview.update(true);
    }),
    // The preview follows the LaTeX file you are editing.
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (preview && ed && isTex(ed.document)) preview.setDocument(ed.document.uri);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (preview && e.textEditor.document.uri.toString() === preview.uri.toString()) preview.syncFromEditor(e.textEditor);
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
