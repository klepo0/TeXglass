/*
 * The reader's own LaTeX, for what TeXglass cannot draw (src/texfallback.js).
 * Node only, with no editor in it: the VS Code extension and FlexTeX use it
 * the same way.
 *
 *   const { createCompiler } = require('./texfallback-node.js');
 *   const tex = createCompiler({
 *     cacheDir,            // a folder of its own, for drawings kept between runs
 *     engine: 'auto',      // or 'pdflatex', 'xelatex', 'lualatex'
 *     texPath: '',         // a folder with the TeX programs, if they are not on PATH
 *   });
 *   await tex.available()  // { engine, path, distribution } or null: no TeX
 *   await tex.draw({ source, dir, pieces })
 *       source: the whole document (its preamble is used), or preamble: '…'
 *       dir: the document's folder, where its own .sty files and figures are
 *       pieces: what texfallback.js's request(pieces) got
 *     -> one result per piece, as request(pieces) returns them: { pdf, page,
 *        depth, fontSize } with pdf a Buffer (one per run, shared by its
 *        pieces), or null. Never throws; null for every piece without TeX.
 *
 * Pieces are compiled together in one run, one page each, in the background
 * and one run at a time; each result is kept (in memory and in cacheDir) by
 * the hash of the engine, the preamble, the piece and the document's own
 * packages, so a piece is compiled again only when one of those changes.
 * TeX runs without shell escape, and without MiKTeX's package installer.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const F = require('./texfallback.js');

const VERSION = 1; // part of every cache key: a new layout compiles everything again
const MAX_PIECES = 40; // per run
const MAX_AGE = 30 * 24 * 3600 * 1000; // drawings unused for a month are deleted

/** The full path of a program on PATH (or in extra folders), or null. */
function which(name, extra) {
  const dirs = (extra ? [extra] : []).concat(String(process.env.PATH || process.env.Path || '').split(path.delimiter)).filter(Boolean);
  const exts = process.platform === 'win32' ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext.toLowerCase());
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch (e) { /* not here */ }
    }
  }
  return null;
}

function run(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, Object.assign({ windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, options), (error, stdout) => {
      resolve({ error, stdout: String(stdout || '') });
    });
  });
}

const hash = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);

/** Files of the document's own named in its preamble (\usepackage{mine}, \input{macros}), with their times. */
function ownFiles(pre, dir) {
  if (!dir) return '';
  const names = new Set();
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}|\\(?:input|include|documentclass(?:\s*\[[^\]]*\])?)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(pre))) {
    if (m[1]) m[1].split(',').forEach((n) => names.add(n.trim() + '.sty'));
    if (m[2]) {
      const n = m[2].trim();
      names.add(n).add(n + '.tex').add(n + '.cls');
    }
  }
  const out = [];
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile()) out.push(`${n}:${st.mtimeMs}:${st.size}`);
    } catch (e) { /* not the document's own */ }
  }
  return out.sort().join('|');
}

function createCompiler(options) {
  const opts = Object.assign({ engine: 'auto', texPath: '', timeout: 60000 }, options || {});
  const cacheDir = opts.cacheDir;
  const memo = new Map(); // piece key -> { file, page, depth, fontSize } or null
  const pdfs = new Map(); // run hash -> Buffer
  const found = new Map(); // engine -> Promise of { engine, path, distribution } or null
  let queue = Promise.resolve();

  if (cacheDir) {
    try {
      fs.mkdirSync(path.join(cacheDir, 'work'), { recursive: true });
      // tidy up: drawings nobody asked for in a month
      const now = Date.now();
      for (const name of fs.readdirSync(cacheDir)) {
        const p = path.join(cacheDir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile() && now - st.atimeMs > MAX_AGE && now - st.mtimeMs > MAX_AGE) fs.unlinkSync(p);
        } catch (e) { /* in use */ }
      }
    } catch (e) { /* drawings then stay in memory only */ }
  }

  /** The engine's program, and whether it is MiKTeX (whose options differ). */
  function find(engine) {
    if (!found.has(engine)) {
      found.set(engine, (async () => {
        const file = which(engine, opts.texPath);
        if (!file) return null;
        const v = await run(file, ['--version'], { timeout: 15000 });
        if (v.error && !v.stdout) return null;
        return { engine, path: file, distribution: /MiKTeX/i.test(v.stdout) ? 'MiKTeX' : /TeX Live/i.test(v.stdout) ? 'TeX Live' : 'TeX' };
      })().catch(() => null));
    }
    return found.get(engine);
  }

  const engineOf = (pre) => (opts.engine && opts.engine !== 'auto' ? opts.engine : F.engineFor(pre));

  async function available(pre) {
    return find(engineOf(pre || ''));
  }

  function readPdf(id) {
    if (pdfs.has(id)) return pdfs.get(id);
    if (!cacheDir) return null;
    try {
      const buf = fs.readFileSync(path.join(cacheDir, id + '.pdf'));
      pdfs.set(id, buf);
      return buf;
    } catch (e) {
      return null;
    }
  }

  function lookup(key) {
    if (memo.has(key)) return memo.get(key);
    if (!cacheDir) return undefined;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, key + '.json'), 'utf8'));
      const now = new Date();
      fs.utimes(path.join(cacheDir, key + '.json'), now, now, () => {});
      if (entry && entry.file) fs.utimes(path.join(cacheDir, entry.file + '.pdf'), now, now, () => {});
      memo.set(key, entry);
      return entry;
    } catch (e) {
      return undefined;
    }
  }

  function remember(key, entry) {
    memo.set(key, entry);
    if (!cacheDir || !entry) return; // a failure is tried again next session (a package may have been installed)
    try {
      fs.writeFileSync(path.join(cacheDir, key + '.json'), JSON.stringify(entry));
    } catch (e) { /* memory only */ }
  }

  /** One run of TeX over some pieces; every piece gets an entry (null if it failed). */
  async function compile(tex, pre, dir, todo) {
    const id = hash('run', VERSION, tex.engine, pre, todo.map((t) => t.key).join('|'));
    const work = cacheDir ? path.join(cacheDir, 'work') : fs.mkdtempSync(path.join(require('os').tmpdir(), 'texglass-'));
    const name = 'tg' + id.slice(0, 12);
    fs.writeFileSync(path.join(work, name + '.tex'), F.documentFor(pre, todo.map((t) => t.piece)));
    const args = ['-interaction=nonstopmode'];
    if (tex.distribution === 'MiKTeX') args.push('-disable-write18', '-disable-installer');
    else args.push('-no-shell-escape');
    args.push(name + '.tex');
    // the document's folder first, so its own packages, \input files and figures are found
    const env = Object.assign({}, process.env);
    if (dir) {
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'TEXINPUTS') || 'TEXINPUTS';
      env[key] = dir + path.delimiter + (env[key] || '');
    }
    await run(tex.path, args, { cwd: work, env, timeout: opts.timeout });
    let log = '';
    let pdf = null;
    try { log = fs.readFileSync(path.join(work, name + '.log'), 'latin1'); } catch (e) { /* no log */ }
    try { pdf = fs.readFileSync(path.join(work, name + '.pdf')); } catch (e) { /* no PDF */ }
    for (const ext of ['.tex', '.log', '.aux', '.pdf', '.out', '.toc', '.nav', '.snm']) {
      try { fs.unlinkSync(path.join(work, name + ext)); } catch (e) { /* not made */ }
    }
    const info = F.parseLog(log, todo.length);
    if (pdf && !info.fatal) {
      pdfs.set(id, pdf);
      if (cacheDir) { try { fs.writeFileSync(path.join(cacheDir, id + '.pdf'), pdf); } catch (e) { /* memory only */ } }
    }
    // a run that lost its way (pages and pieces apart) is tried again piece by piece
    if (!pdf || (info.pages !== todo.length && todo.length > 1)) {
      if (todo.length > 1 && !info.fatal) {
        for (const t of todo) await compile(tex, pre, dir, [t]);
        return;
      }
    }
    todo.forEach((t, k) => {
      const r = info.pieces[k];
      remember(t.key, pdf && r.ok ? { file: id, page: r.page, depth: r.depth, height: r.height, width: r.width, fontSize: info.fontSize } : null);
    });
  }

  /** Draw the pieces: see the top of this file. */
  function draw(job) {
    const result = queue.then(() => drawNow(job)).catch(() => (job.pieces || []).map(() => null));
    queue = result.catch(() => {});
    return result;
  }

  async function drawNow(job) {
    const pieces = job.pieces || [];
    const pre = job.preamble || F.preamble(job.source || '');
    if (!pre || !pieces.length) return pieces.map(() => null);
    const tex = await find(engineOf(pre));
    if (!tex) return pieces.map(() => null);
    const own = ownFiles(pre, job.dir);
    const keys = pieces.map((p) => hash('piece', VERSION, tex.engine, pre, own, job.dir || '', p.kind, p.display ? 1 : 0, p.tex));
    const todo = [];
    const seen = new Set();
    pieces.forEach((piece, k) => {
      if (lookup(keys[k]) !== undefined || seen.has(keys[k])) return;
      seen.add(keys[k]);
      todo.push({ key: keys[k], piece });
    });
    for (let i = 0; i < todo.length; i += MAX_PIECES) await compile(tex, pre, job.dir, todo.slice(i, i + MAX_PIECES));
    return keys.map((key) => {
      const entry = memo.get(key);
      const pdf = entry && readPdf(entry.file);
      return pdf ? { pdf, page: entry.page, depth: entry.depth, fontSize: entry.fontSize } : null;
    });
  }

  return { available, draw, which };
}

module.exports = { createCompiler, which };
