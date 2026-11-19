/*
 * Opening documents from this computer: a .tex file together with the files it
 * pulls in (\input, \include, local packages, the bibliography, figures).
 *
 * The files come one of three ways:
 *   - a folder (or several files) chosen or dropped: everything is read, the
 *     main file found, and the rest put together by TeXglassArxiv.fromFiles;
 *   - a file:// address, in the browser extension with access to file URLs:
 *     only the main file is known, so gather() reads it and follows what it
 *     names, asking for each file next to it;
 *   - a single file: it is shown on its own, and missing() says what it names
 *     that is not there, so the viewer can offer to open its folder.
 *
 * Works in Node too (for tests); reading the browser's file objects needs a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./arxiv.js'), require('./bib.js'));
  else root.TeXglassLocal = factory(root.TeXglassArxiv, root.TeXglassBib);
})(typeof self !== 'undefined' ? self : this, function (Arxiv, Bib) {
  'use strict';

  const TEXT = /\.(tex|ltx|latex|bbl|bib|sty|cls|def|tikz|pgf)$/i;
  const PICTURE = /\.(png|jpe?g|gif|svg|webp|eps|ps|epsi)$/i;
  const SKIP_DIRS = /^(\.git|\.svn|\.hg|node_modules|__pycache__|\.vscode|\.idea)$/;
  const LIMITS = { files: 3000, bytes: 200 * 1024 * 1024 };
  const FIGURE_EXTS = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.eps', '.ps'];

  /** Whether a file in a folder is worth reading: LaTeX text or a figure. */
  const wanted = (path) => TEXT.test(path) || PICTURE.test(path);
  const isText = (path) => TEXT.test(path);

  /** Whether `path` (a/b/c) passes through a folder that is never read. */
  const skipped = (path) => path.split('/').slice(0, -1).some((d) => SKIP_DIRS.test(d));

  const stripComments = (t) => String(t || '').replace(/(^|[^\\])%.*$/gm, '$1');
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const join = (d, n) => Arxiv.normalize((d ? d + '/' : '') + String(n).trim().replace(/^"|"$/g, ''));

  /**
   * What a LaTeX file names that lives in other files, as lists of paths to
   * try (relative to the main file's folder), each list in order of preference:
   * [{ kind: 'tex' | 'sty' | 'bib' | 'figure', name, tries: [paths] }].
   */
  function references(text, mainName) {
    const t = stripComments(text);
    const out = [];
    const add = (kind, name, tries) => out.push({ kind, name, tries: Array.from(new Set(tries)) });
    for (const m of t.matchAll(/\\(input|include|subfile)\s*\{([^}]*)\}|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]*)\}|\\input\s+([^\s{}\\]+)/g)) {
      const name = m[2] !== undefined ? m[2] : m[4] !== undefined ? m[3].replace(/\/?$/, '/') + m[4] : m[5];
      if (!name || /[#\\]/.test(name)) continue;
      add('tex', name, ['', '.tex', '.ltx'].map((e) => join('', name) + e));
    }
    for (const m of t.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      for (const p of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!/[#\\]/.test(p)) add('sty', p, [join('', p) + '.sty']);
      }
    }
    const bibs = Bib && Bib.bibResources ? Bib.bibResources(t) : [];
    for (const b of bibs) add('bib', b, [join('', b), join('', b) + '.bib'].filter((p) => /\.bib$/i.test(p)));
    if (mainName && /\\(bibliography|printbibliography)\b/.test(t)) {
      const bbl = mainName.replace(/\.[^./]+$/, '') + '.bbl';
      add('bib', bbl, [bbl]);
    }
    const dirs = [''];
    const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(t);
    if (gp) for (const m of gp[1].matchAll(/\{([^}]*)\}/g)) dirs.push(m[1].replace(/\/?$/, '/'));
    for (const m of t.matchAll(/\\includegraphics\s*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g)) {
      const name = m[1].trim();
      if (!name || /[#\\]/.test(name)) continue;
      const tries = [];
      for (const d of dirs) {
        const p = join('', d + name);
        for (const e of FIGURE_EXTS) tries.push(p + e);
        // A .pdf figure (which browsers cannot draw inline) often has a .png beside it.
        const stem = p.replace(/\.(pdf|eps|ps)$/i, '');
        if (stem !== p) for (const e of FIGURE_EXTS.slice(1)) tries.push(stem + e);
      }
      add('figure', name, tries.filter((p) => wanted(p)));
    }
    return out;
  }

  /**
   * The files that the main file `mainName` needs, read on demand: read(path)
   * resolves to the file's bytes (Uint8Array) or null, for paths relative to
   * the main file's folder. Follows \input files, local packages, the
   * bibliography and figures, at most `limit` files. Returns { path: bytes }.
   */
  async function gather(mainName, read, mainBytes, limit = 400) {
    const raw = {};
    const tried = new Set();
    raw[mainName] = mainBytes || (await read(mainName));
    if (!raw[mainName]) return null;
    tried.add(mainName);
    let queue = [mainName];
    const decode = (b) => new TextDecoder('utf-8').decode(b);
    while (queue.length && Object.keys(raw).length < limit) {
      const refs = queue.flatMap((p) => references(decode(raw[p]), mainName));
      queue = [];
      await Promise.all(refs.map(async (ref) => {
        for (const p of ref.tries) {
          if (raw[p]) return; // already have it
          if (tried.has(p)) continue;
          tried.add(p);
          let bytes = null;
          try { bytes = await read(p); } catch (e) { bytes = null; }
          if (bytes) {
            raw[p] = bytes;
            if (ref.kind === 'tex' || ref.kind === 'sty') queue.push(p);
            return;
          }
        }
      }));
    }
    return raw;
  }

  /**
   * What `text` (a file opened on its own) names that is not in it, for the
   * viewer to suggest opening its folder: { inputs, figures } (names).
   */
  function missing(text) {
    const refs = references(text);
    return {
      inputs: refs.filter((r) => r.kind === 'tex').map((r) => r.name),
      figures: refs.filter((r) => r.kind === 'figure').map((r) => r.name),
    };
  }

  /** Paths that all start with the same folder (a dropped or chosen folder's name) lose it. */
  function stripCommonFolder(raw) {
    const paths = Object.keys(raw);
    if (!paths.length || !paths.every((p) => p.includes('/'))) return raw;
    const first = paths[0].split('/')[0];
    if (!paths.every((p) => p.split('/')[0] === first)) return raw;
    const out = {};
    for (const [p, v] of Object.entries(raw)) out[p.slice(first.length + 1)] = v;
    return stripCommonFolder(out);
  }

  /**
   * A document from the files of a folder ({ path: bytes }): the main file
   * (opts.main, or the one with \documentclass) with what it pulls in. Paths
   * are taken relative to the main file's folder, as LaTeX does.
   * Returns TeXglassArxiv.fromFiles's { name, source, images, main, files }.
   */
  function fromFolder(raw, opts) {
    opts = opts || {};
    raw = stripCommonFolder(raw);
    let main = opts.main && raw[opts.main] ? opts.main : null;
    if (!main) {
      const texts = {};
      for (const [p, b] of Object.entries(raw)) if (/\.(tex|ltx|latex)$/i.test(p)) texts[p] = new TextDecoder('utf-8').decode(b);
      main = Arxiv.pickMain(texts);
    }
    if (!main) throw new Error('There is no .tex file among these files.');
    const base = dirOf(main);
    let files = raw;
    if (base) {
      files = {};
      for (const [p, b] of Object.entries(raw)) if (p.startsWith(base + '/')) files[p.slice(base.length + 1)] = b;
      main = main.slice(base.length + 1);
    }
    const doc = Arxiv.fromFiles(byName(files), { main });
    doc.files = Object.keys(files);
    return doc;
  }

  /**
   * Files chosen one by one come without their folders (intro.tex for
   * sections/intro.tex): where a file names a path that is not there, use the
   * file of the same name, if there is exactly one.
   */
  function byName(files) {
    const names = {};
    for (const p of Object.keys(files)) {
      const n = p.split('/').pop().toLowerCase();
      names[n] = names[n] === undefined ? p : null;
    }
    const out = Object.assign({}, files);
    const decode = (b) => new TextDecoder('utf-8').decode(b);
    for (const p of Object.keys(files)) {
      if (!/\.(tex|ltx|latex|sty)$/i.test(p)) continue;
      for (const ref of references(decode(files[p]))) {
        if (ref.tries.some((t) => out[t])) continue;
        for (const t of ref.tries) {
          const hit = names[t.split('/').pop().toLowerCase()];
          if (hit) { out[t] = files[hit]; break; }
        }
      }
    }
    return out;
  }

  // --- reading the browser's file objects --------------------------------------

  const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());

  function budget() {
    let files = 0;
    let bytes = 0;
    return (size) => {
      files += 1;
      bytes += size || 0;
      return files <= LIMITS.files && bytes <= LIMITS.bytes;
    };
  }

  /** Files from an <input type=file multiple> or webkitdirectory input: { path: bytes }. */
  async function readFileList(list) {
    const raw = {};
    const ok = budget();
    for (const f of Array.from(list)) {
      const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      if (!wanted(path) || skipped(path) || !ok(f.size)) continue;
      raw[path] = await bytesOf(f);
    }
    return raw;
  }

  /**
   * Files and folders dropped on the page, as the entries that DataTransfer
   * items give with webkitGetAsEntry (Chromium, Firefox and Safari all have it;
   * ask for them during the drop event): { path: bytes }.
   */
  async function readDropped(entries) {
    const raw = {};
    const ok = budget();
    const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
    const children = (dir) => new Promise((resolve, reject) => {
      const reader = dir.createReader();
      const all = [];
      const next = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
      next();
    });
    const walk = async (entry, prefix) => {
      const path = prefix + entry.name;
      if (entry.isDirectory) {
        if (SKIP_DIRS.test(entry.name)) return;
        for (const c of await children(entry)) await walk(c, path + '/');
      } else if (wanted(path)) {
        const f = await fileOf(entry);
        if (ok(f.size)) raw[path] = await bytesOf(f);
      }
    };
    for (const e of entries) await walk(e, '');
    return raw;
  }

  /**
   * The files of a folder chosen with showDirectoryPicker (Chromium):
   * { raw: { path: bytes }, handles: { path: FileSystemFileHandle } } for watching.
   */
  async function readDirectoryHandle(dir) {
    const raw = {};
    const handles = {};
    const ok = budget();
    const walk = async (d, prefix) => {
      for await (const [name, h] of d.entries()) {
        const path = prefix + name;
        if (h.kind === 'directory') {
          if (!SKIP_DIRS.test(name)) await walk(h, path + '/');
        } else if (wanted(path)) {
          const f = await h.getFile();
          if (!ok(f.size)) continue;
          raw[path] = await bytesOf(f);
          handles[path] = h;
        }
      }
    };
    await walk(dir, '');
    return { raw, handles };
  }

  return { wanted, isText, references, gather, missing, stripCommonFolder, fromFolder, readFileList, readDropped, readDirectoryHandle, LIMITS };
});
