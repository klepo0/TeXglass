/*
 * TeXglass for Overleaf: the parts of the live preview that need no browser.
 *
 *   - unzip(bytes): read the zip that Overleaf's "Download as zip" serves
 *     (/project/<id>/download/zip), so the preview can use the project's other
 *     files: \input files, the main file's preamble, .bib files and figures.
 *   - compose(open, project): the LaTeX to render for the file open in
 *     Overleaf's editor, with those files pulled in, and a map between offsets
 *     in that LaTeX and offsets in the open file, so that the preview can
 *     follow the editor and a click in the preview can move the editor's
 *     cursor.
 *
 * The open file is always the live text from the editor; the other files are
 * a snapshot from the zip, refreshed when the reader asks.
 *
 * Shared by the preview page (overleaf.html, as window.TeXglassOverleaf) and
 * the tests (Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../src/arxiv.js'));
  else root.TeXglassOverleaf = factory(root.TeXglassArxiv);
})(typeof self !== 'undefined' ? self : this, function (Arxiv) {
  'use strict';

  // --- zip ---------------------------------------------------------------------

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * The files in a zip archive, as { path: Uint8Array }. Only stored and
   * deflated entries are read (all that Overleaf writes); `want(path)` picks
   * which files to unpack, so large PDFs need not be inflated.
   */
  async function unzip(buf, want) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('This is not a zip file.');
    const count = dv.getUint16(end + 10, true);
    let p = dv.getUint32(end + 16, true);
    const files = {};
    const utf8 = new TextDecoder('utf-8');
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true); // compressed; the local header may leave it 0
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/') || (want && !want(name))) continue;
      if (dv.getUint32(local, true) !== 0x04034b50) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + csize);
      if (method === 0) files[name] = data.slice();
      else if (method === 8) files[name] = await inflateRaw(data);
    }
    return files;
  }

  const TEXT = /\.(tex|ltx|latex|bib|bbl|sty|cls|def|cfg|clo)$/i;
  const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
  const extOf = (p) => (p.split('/').pop().includes('.') ? p.split('.').pop().toLowerCase() : '');

  /** Whether the preview has any use for a file in the project's zip. */
  const wanted = (path) => TEXT.test(path) || !!IMAGE_TYPES[extOf(path)];

  /** Split unzipped files into { texts: { path: string }, images: { path: Blob } }. */
  function sortFiles(raw) {
    const texts = {};
    const images = {};
    const dec = new TextDecoder('utf-8');
    for (const [path, data] of Object.entries(raw)) {
      if (TEXT.test(path)) texts[path] = dec.decode(data);
      else if (IMAGE_TYPES[extOf(path)] && typeof Blob === 'function') images[path] = new Blob([data], { type: IMAGE_TYPES[extOf(path)] });
    }
    return { texts, images };
  }

  // --- which project file is open ------------------------------------------------

  /**
   * The path in the project of the file open in the editor: the path the page
   * showed if the zip has it, else the one file with the same text, else the
   * one file with the same name.
   */
  function locate(texts, text, name) {
    const paths = Object.keys(texts);
    const clean = String(name || '').replace(/^\/+/, '');
    if (clean && texts[clean] != null) return clean;
    const same = paths.filter((p) => texts[p] === text);
    if (same.length === 1) return same[0];
    const base = clean.split('/').pop();
    const named = paths.filter((p) => p.split('/').pop() === base);
    if (named.length === 1) return named[0];
    if (same.length) return same[0];
    return named[0] || null;
  }

  // --- composing the LaTeX to render ---------------------------------------------------

  const stripComments = (t) => t.replace(/(^|[^\\])%.*$/gm, '$1');
  const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  function normalize(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  }

  function resolvePath(files, dirs, name, exts) {
    const clean = name.trim().replace(/^"|"$/g, '').replace(/^\.\//, '');
    for (const d of dirs) {
      const p = normalize((d ? d + '/' : '') + clean);
      for (const ext of exts) if (files[p + ext] != null) return p + ext;
    }
    return null;
  }

  function subfileBody(text) {
    const b = /\\begin\s*\{document\}/.exec(text);
    if (!b) return text;
    const rest = text.slice(b.index + b[0].length);
    const e = /\\end\s*\{document\}/.exec(rest);
    return e ? rest.slice(0, e.index) : rest;
  }

  const INPUT = /(^|[^\\])(%.*$)|\\(input|include|subfile)\s*\{([^}]*)\}|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]*)\}|\\input\s+([^\s{}\\]+)|\\bibliography\s*\{[^}]*\}|\\printbibliography(?:\[[^\]]*\])?/gm;

  /**
   * The LaTeX to render for the open file.
   *
   *   open:    { text, name }   the editor's text, and the file's name or path if known
   *   project: { texts: { path: string } } or null   the project's files, from its zip
   *
   * Returns { text, toOpen(offset), fromOpen(offset), path, main, inlined, missing }:
   * toOpen maps an offset in `text` to one in the open file (text pulled in from
   * another file maps to the command that pulled it in), fromOpen the other way.
   * Without project files the text is the open file's, unchanged.
   */
  function compose(open, project) {
    const src = String(open.text || '');
    const files = project && project.texts ? Object.assign({}, project.texts) : null;
    const pieces = []; // { c: offset in result, len, o: offset in open file, oEnd, copy: true if text from the open file }
    let out = '';
    const add = (text, o, oEnd, copy) => {
      if (!text.length && copy) return;
      pieces.push({ c: out.length, len: text.length, o, oEnd, copy });
      out += text;
    };
    const result = { path: null, main: null, inlined: [], missing: [] };

    if (!files) {
      add(src, 0, src.length, true);
    } else {
      const path = locate(files, src, open.name);
      if (path) files[path] = src; // the editor is newer than the zip
      result.path = path;
      const candidates = {};
      for (const p of Object.keys(files)) if (/\.(tex|ltx|latex)$/i.test(p)) candidates[p] = files[p];
      const isWhole = /\\documentclass/.test(stripComments(src));
      const main = isWhole ? path : Arxiv.pickMain(candidates);
      const mainOk = main && /\\documentclass/.test(stripComments(files[main] || ''));
      result.main = mainOk ? main : null;
      const dirs = [dirOf(result.main || path), dirOf(path), ''];

      // A part of a larger document: put the main file's preamble before it, for its macros.
      let preamble = '';
      if (!isWhole && result.main && result.main !== path) {
        const flat = Arxiv.flatten(result.main, files);
        const b = /\\begin\s*\{document\}/.exec(flat);
        if (b) preamble = flat.slice(0, b.index + b[0].length) + '\n';
        add(preamble, 0, 0, false);
      }

      // The open file, with its \input files pulled in.
      let last = 0;
      let bibPiece = null;
      let bibCmd = '';
      INPUT.lastIndex = 0;
      let m;
      while ((m = INPUT.exec(src))) {
        if (m[2] !== undefined) continue; // a comment
        const at = m.index + (m[1] ? m[1].length : 0);
        const whole = m[0].slice(m[1] ? m[1].length : 0);
        if (/^\\(bibliography|printbibliography)/.test(whole)) {
          add(src.slice(last, at), last, at, true);
          bibPiece = pieces.length;
          bibCmd = whole;
          add('', at, at + whole.length, false);
          last = at + whole.length;
          continue;
        }
        const cmd = m[3] || 'input';
        const name = m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5].replace(/\/?$/, '/') + m[6] : m[7];
        const found = resolvePath(files, dirs, name, ['', '.tex', '.ltx']);
        if (!found || found === path) {
          if (!found) result.missing.push(name.trim());
          continue;
        }
        let body = Arxiv.flatten(found, files);
        if (cmd === 'subfile') body = subfileBody(body);
        if (cmd === 'include' || cmd === 'subfile') body = '\n' + body + '\n';
        add(src.slice(last, at), last, at, true);
        add(body, at, at + whole.length, false);
        result.inlined.push(found);
        last = at + whole.length;
      }
      add(src.slice(last), last, src.length, true);

      // The bibliography, from the project's .bib files.
      const owner = isWhole ? path : result.main;
      if (owner) {
        let probe = out + (bibCmd ? '\n' + bibCmd : '');
        if (!isWhole) {
          const ask = stripComments(files[owner] || '').match(/\\bibliography\s*\{[^}]*\}|\\printbibliography/);
          if (ask && !bibPiece) probe += '\n' + ask[0];
        }
        let bib = '';
        try {
          bib = Arxiv.bibliographyFor(owner, files, probe) || '';
        } catch (e) {
          bib = '';
        }
        if (bib && bibPiece != null) {
          // Put it in place of the \bibliography command.
          const piece = pieces[bibPiece];
          out = out.slice(0, piece.c) + bib + out.slice(piece.c);
          piece.len = bib.length;
          for (const q of pieces.slice(bibPiece + 1)) q.c += bib.length;
        } else if (bib && !isWhole && /\\(no)?cite|\\[a-z]*cite[a-z]*\b/i.test(stripComments(out))) {
          add('\n' + bib + '\n', src.length, src.length, false);
        }
      }
      if (preamble) add('\n\\end{document}\n', src.length, src.length, false);
    }

    result.text = out;
    result.toOpen = (c) => {
      for (const p of pieces) {
        if (c < p.c + p.len || p === pieces[pieces.length - 1]) {
          if (c < p.c) return p.o;
          return p.copy ? Math.min(p.o + (c - p.c), p.oEnd) : p.o;
        }
      }
      return 0;
    };
    result.fromOpen = (o) => {
      for (const p of pieces) {
        if (p.copy && o >= p.o && o <= p.oEnd) return p.c + (o - p.o);
        if (!p.copy && o >= p.o && o < p.oEnd) return p.c;
      }
      return out.length;
    };
    return result;
  }

  /** The names that the open file pulls in with \input, \include, \subfile or \import. */
  function inputsOf(text) {
    const names = [];
    INPUT.lastIndex = 0;
    let m;
    while ((m = INPUT.exec(String(text || '')))) {
      if (m[2] !== undefined) continue;
      const name = m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] + m[6] : m[7];
      if (name) names.push(name.trim());
    }
    return names;
  }

  return { unzip, wanted, sortFiles, locate, compose, inputsOf, IMAGE_TYPES };
});
