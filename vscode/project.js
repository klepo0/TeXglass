/*
 * Put a LaTeX project together into one text for TeXglass: pull in the files
 * named by \input, \include, \subfile and \import, and turn
 * \bibliography / \printbibliography into a thebibliography built from the
 * .bbl (when it is up to date) or the .bib files.
 *
 * Every piece of the result remembers which file and offset it came from, so
 * the preview can jump to the right file and line.
 */
'use strict';
const nodePath = require('path');
const { parseBib, makeBibliography } = require('./bib.js');

// A comment, an \input-like command, or a bibliography command.
const COMMANDS = new RegExp(
  [
    '(?<!\\\\)%.*$',
    '\\\\(input|include|subfile)\\s*\\{([^}]*)\\}',
    '\\\\(?:sub)?(?:import|inputfrom|includefrom)\\s*\\{([^}]*)\\}\\s*\\{([^}]*)\\}',
    '\\\\input\\s+([^\\s{}\\\\%]+)',
    '\\\\(bibliography)\\s*\\{([^}]*)\\}',
    '\\\\(printbibliography)(?:\\s*\\[[^\\]]*\\])?',
  ].join('|'),
  'gm'
);

const CITE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;

/**
 * read(absolutePath) -> text or null; paths is the path module to use
 * (Node's by default, path.posix for the paths of virtual files). Returns
 * { text, files: [abs paths], texts: { path: text }, segments, deps, warnings }
 * where segments are [{ start, end, file, at, generated }]: text[start, end)
 * came from files[file] starting at offset `at` (or was made for the command
 * at `at`, if generated).
 */
function assemble(mainPath, read, paths) {
  const path = paths || nodePath;
  const mainDir = path.dirname(mainPath);
  const files = [];
  const texts = {};
  const deps = new Set([mainPath]);
  const warnings = [];
  const segments = [];
  let out = '';
  const fileIndex = (p) => {
    let k = files.indexOf(p);
    if (k < 0) k = files.push(p) - 1;
    return k;
  };
  const emit = (text, file, at, generated) => {
    if (!text) return;
    segments.push({ start: out.length, end: out.length + text.length, file: fileIndex(file), at, generated: !!generated });
    out += text;
  };
  const tryRead = (p) => {
    deps.add(p);
    const t = read(p);
    return t == null ? null : t.replace(/\r\n?/g, '\n');
  };
  const resolveTex = (name, dir) => {
    const clean = name.trim().replace(/^"|"$/g, '');
    if (!clean) return null;
    const bases = path.isAbsolute(clean) ? [clean] : [path.resolve(dir, clean), path.resolve(mainDir, clean)];
    for (const b of bases) for (const ext of ['', '.tex']) {
      if (ext === '' && !/\.[a-z]+$/i.test(b)) continue;
      const t = tryRead(b + ext);
      if (t != null) return { p: b + ext, t };
    }
    return null;
  };
  const bibCommands = []; // { pos in out, kind, arg }
  const stack = new Set();

  function expand(file, text, depth) {
    stack.add(file);
    fileIndex(file);
    texts[file] = text;
    COMMANDS.lastIndex = 0;
    const re = new RegExp(COMMANDS.source, 'gm');
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0][0] === '%') continue;
      const at = m.index;
      if (m[6] || m[8]) {
        // \bibliography{…} or \printbibliography: filled in once every citation is known.
        emit(text.slice(last, at), file, last);
        bibCommands.push({ pos: out.length, file, at, kind: m[6] || m[8], arg: m[7] || '' });
        last = at + m[0].length;
        continue;
      }
      const name = m[2] !== undefined ? m[2] : m[4] !== undefined ? m[3].replace(/\/?$/, '/') + m[4] : m[5];
      // \import{dir}{file} looks in dir; the others relative to the main file (as LaTeX does).
      const found = depth < 20 ? resolveTex(name, m[3] !== undefined ? path.resolve(mainDir, m[3]) : mainDir) : null;
      if (!found) {
        // (A bare "\input xy" usually loads a macro package; say nothing about those.)
        if (name && depth < 20 && m[5] === undefined) warnings.push(`Could not find the file "${name}" for \\${m[1] || 'input'}.`);
        continue;
      }
      if (stack.has(found.p)) continue;
      emit(text.slice(last, at), file, last);
      const include = m[1] === 'include' || m[1] === 'subfile';
      if (include) emit('\n\n', file, at, true);
      let inner = found.t;
      if (m[1] === 'subfile') {
        // A subfile is a whole document; keep only its body.
        const b = /\\begin\s*\{document\}/.exec(inner);
        const e = /\\end\s*\{document\}/.exec(inner);
        if (b) {
          emit('', file, at, true);
          const startBody = b.index + b[0].length;
          expandPart(found.p, inner, startBody, e ? e.index : inner.length, depth + 1);
        } else expand(found.p, inner, depth + 1);
      } else expand(found.p, inner, depth + 1);
      if (include) emit('\n\n', file, at, true);
      last = at + m[0].length;
    }
    emit(text.slice(last), file, last);
    stack.delete(file);
  }

  /** Expand only text[from, to) of a file (the body of a subfile). */
  function expandPart(file, text, from, to, depth) {
    const startOut = out.length;
    expand(file, text.slice(from, to), depth);
    texts[file] = text;
    // The segments just made count offsets from `from`.
    for (const s of segments) if (s.start >= startOut && files[s.file] === file && !s.generated) s.at += from;
  }

  const main = tryRead(mainPath);
  if (main == null) return null;
  expand(mainPath, main, 0);

  // Bibliography: one environment for the first \bibliography / \printbibliography.
  const bib = bibCommands[0];
  if (bib) {
    const cited = [];
    const noComments = out.replace(/(?<!\\)%.*$/gm, '');
    for (const m of noComments.matchAll(CITE)) for (const k of m[1].split(',')) if (k.trim()) cited.push(k.trim());
    const style = (/\\bibliographystyle\s*\{([^}]*)\}/.exec(noComments) || [])[1] || '';
    const bibText = bibliography(mainPath, bib, noComments, cited, style, tryRead, warnings, path);
    if (bibText) {
      // Splice it in where the command was, moving everything after it along.
      const len = bibText.length;
      out = out.slice(0, bib.pos) + bibText + out.slice(bib.pos);
      for (const s of segments) {
        if (s.start >= bib.pos) {
          s.start += len;
          s.end += len;
        }
      }
      segments.push({ start: bib.pos, end: bib.pos + len, file: fileIndex(bib.file), at: bib.at, generated: true });
      segments.sort((a, b) => a.start - b.start);
    }
  }
  return { text: out, files, texts, segments, deps: Array.from(deps), warnings };
}

/** The thebibliography for a document: from the .bbl if it covers every citation, else from the .bib files. */
function bibliography(mainPath, bib, text, cited, style, read, warnings, path) {
  const dir = path.dirname(mainPath);
  const keys = cited.filter((k) => k !== '*');
  const bbl = read(mainPath.replace(/\.[^./\\]+$/, '') + '.bbl');
  if (bbl && /\\begin\s*\{thebibliography\}/.test(bbl)) {
    const items = new Set(Array.from(bbl.matchAll(/\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g), (m) => m[1].trim()));
    if (keys.every((k) => items.has(k))) return bbl.trim();
  }
  // .bib files: from \bibliography{a,b} and \addbibresource{c.bib}.
  const names = [];
  if (bib.kind === 'bibliography') names.push(...bib.arg.split(','));
  for (const m of text.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) names.push(m[1]);
  const entries = {};
  let found = 0;
  for (let name of names) {
    name = name.trim();
    if (!name) continue;
    const p = path.resolve(dir, /\.bib$/i.test(name) ? name : name + '.bib');
    const t = read(p);
    if (t == null) {
      warnings.push(`Could not find the bibliography file "${path.basename(p)}".`);
      continue;
    }
    found++;
    Object.assign(entries, parseBib(t));
  }
  if (!found) return '';
  return makeBibliography(entries, cited, style).text;
}

/** Map an offset in the assembled text back to { file, offset } in its source file. */
function locate(project, offset) {
  const segs = project.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  if (!s) return { file: 0, offset: 0 };
  return { file: s.file, offset: s.generated ? s.at : s.at + Math.min(offset - s.start, s.end - s.start) };
}

/**
 * The root of a project a file belongs to: a "% !TEX root = …" line, or, for
 * a file with no \documentclass, a .tex file next to it or one folder up
 * that \input's or \include's it. Returns an absolute path, or `file` itself.
 * listTex(dir) lists the .tex files in a folder; paths is as for assemble.
 */
function findRoot(file, text, listTex, read, paths) {
  const path = paths || nodePath;
  const head = text.split('\n', 30).join('\n');
  const magic = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(head);
  if (magic) return path.resolve(path.dirname(file), magic[1]);
  if (/\\documentclass/.test(text)) return file;
  const stem = path.basename(file).replace(/\.tex$/i, '');
  const dirs = [path.dirname(file), path.dirname(path.dirname(file))];
  for (const d of dirs) {
    for (const cand of listTex(d)) {
      if (cand === file) continue;
      const t = read(cand);
      if (!t || !/\\documentclass/.test(t)) continue;
      const re = /\\(?:input|include|subfile)\s*\{([^}]*)\}|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]*)\}/g;
      for (const m of t.replace(/(?<!\\)%.*$/gm, '').matchAll(re)) {
        const name = (m[1] !== undefined ? m[1] : m[2].replace(/\/?$/, '/') + m[3]).trim().replace(/\.tex$/i, '');
        if (path.resolve(path.dirname(cand), name) === path.resolve(path.dirname(file), stem)) return cand;
      }
    }
  }
  return file;
}

module.exports = { assemble, locate, findRoot };
