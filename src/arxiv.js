/*
 * Import a paper's LaTeX source from arXiv.
 *
 * arxiv.org/src/<id> serves the source the authors uploaded, gzipped: usually a
 * tar archive, sometimes a single .tex file. It allows cross-origin requests,
 * so a browser page can fetch it directly. This module unpacks it, finds the
 * main file, and inlines \input/\include and the .bbl bibliography so the
 * viewer gets one self-contained document. Images come back as raw files that
 * the caller can turn into object URLs.
 *
 * Works in browsers and in Node 18+ (fetch and DecompressionStream).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassArxiv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The arXiv identifier in a link or a bare id, with its version if given, or null.
   * Accepts new-style ids (2301.00001, 2301.00001v2) and old-style ones
   * (math/0601001, hep-th/9901001v3), as abs/pdf/src/e-print/html links or with
   * an "arXiv:" prefix.
   */
  function parseId(input) {
    const s = String(input || '').trim().replace(/^arxiv:\s*/i, '');
    const re = /(?:^|\/)((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?\/?(?:[?#].*)?$/i;
    const m = s.match(re);
    return m ? m[1] : null;
  }

  /** Parse a tar archive into { path: Uint8Array }. */
  function untar(bytes) {
    const files = {};
    const dec = new TextDecoder('latin1');
    const str = (off, len) => {
      const raw = dec.decode(bytes.subarray(off, off + len));
      const nul = raw.indexOf('\0');
      return nul >= 0 ? raw.slice(0, nul) : raw;
    };
    let off = 0;
    let longName = null;
    while (off + 512 <= bytes.length) {
      const name = str(off, 100);
      if (!name && bytes[off] === 0) break; // end-of-archive block
      const size = parseInt(str(off + 124, 12).trim() || '0', 8) || 0;
      const type = str(off + 156, 1);
      const prefix = str(off + 257, 6).startsWith('ustar') ? str(off + 345, 155) : '';
      const body = off + 512;
      const data = bytes.subarray(body, body + size);
      if (type === 'L') {
        longName = str(body, size); // GNU long file name for the next entry
      } else if (type === 'x' || type === 'g') {
        const m = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data));
        if (m && type === 'x') longName = m[1];
      } else {
        let path = longName || (prefix ? prefix + '/' + name : name);
        longName = null;
        path = path.replace(/^\.\//, '');
        if ((type === '0' || type === '' || type === '\0') && path && !path.endsWith('/')) files[path] = data;
      }
      off = body + Math.ceil(size / 512) * 512;
    }
    return files;
  }

  const isTar = (bytes) => bytes.length > 262 && new TextDecoder('latin1').decode(bytes.subarray(257, 262)) === 'ustar';

  async function gunzip(bytes) {
    if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const decodeText = (bytes) => {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Old submissions are often Latin-1; fall back when UTF-8 decoding hit invalid bytes.
    return utf8.includes('\uFFFD') ? new TextDecoder('latin1').decode(bytes) : utf8;
  };

  /** The main .tex file: the one with \documentclass (and \begin{document}), preferring common names. */
  function pickMain(texFiles) {
    const names = Object.keys(texFiles);
    const strip = (t) => t.replace(/(^|[^\\])%.*$/gm, '$1');
    const scored = names.map((n) => {
      const t = strip(texFiles[n]);
      let score = 0;
      if (/\\documentclass/.test(t)) score += 10;
      if (/\\begin\{document\}/.test(t)) score += 5;
      if (/^(main|ms|paper|article|arxiv)\.tex$/i.test(n.split('/').pop())) score += 2;
      if (!n.includes('/')) score += 1;
      return { n, score, len: t.length };
    });
    scored.sort((a, b) => b.score - a.score || b.len - a.len);
    return scored.length ? scored[0].n : null;
  }

  function resolvePath(files, base, name, exts) {
    const clean = name.trim().replace(/^\.\//, '');
    const dirs = [base, ''];
    for (const d of dirs) {
      const p = normalize((d ? d + '/' : '') + clean);
      for (const ext of exts) if (files[p + ext] != null) return p + ext;
    }
    return null;
  }

  function normalize(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  }

  const stripComments = (t) => t.replace(/(^|[^\\])%.*$/gm, '$1');

  /** How \include and \includeonly name a file: trimmed, without "./" or ".tex". */
  const includeName = (name) => String(name || '').trim().replace(/^"|"$/g, '').replace(/^(\.\/)+/, '').replace(/\.tex$/i, '');

  /** The names in \includeonly{…} (see includeName), or null if there is none. */
  function includeOnly(text) {
    const m = /\\includeonly\s*\{([^}]*)\}/.exec(stripComments(text || ''));
    return m ? new Set(m[1].split(',').map(includeName).filter(Boolean)) : null;
  }

  /** The body of a whole document pulled in with \subfile: what is inside \begin{document}. */
  function subfileBody(text) {
    const b = /\\begin\s*\{document\}/.exec(text);
    if (!b) return text;
    const rest = text.slice(b.index + b[0].length);
    const e = /\\end\s*\{document\}/.exec(rest);
    return e ? rest.slice(0, e.index) : rest;
  }

  /**
   * Inline \input, \include, \subfile and \import into the main file, and
   * replace \bibliography{…} with the .bbl that arXiv keeps next to it.
   * \include files left out by \includeonly are dropped, and a \subfile
   * brings in only its document body.
   * If opts.starts is an object, it is filled with { path: offset } of where
   * each pulled-in file's text begins in the result.
   */
  function flatten(mainPath, texFiles, opts) {
    const starts = opts && opts.starts;
    const mark = (p) => (starts ? `\u0000${p}\u0000` : '');
    const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const mainDir = dirOf(mainPath);
    const only = includeOnly(texFiles[mainPath]);
    const seen = new Set();
    const expand = (path, depth) => {
      if (depth > 20 || seen.has(path)) return '';
      seen.add(path);
      const text = texFiles[path];
      const out = text.replace(/(^|[^\\])(%.*$)|\\(input|include|subfile)\s*\{([^}]*)\}|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]*)\}|\\input\s+([^\s{}\\]+)/gm,
        (m, pre, comment, cmd, arg, impDir, impFile, bare) => {
          if (comment !== undefined) return m;
          const name = arg !== undefined ? arg : impFile !== undefined ? impDir.replace(/\/?$/, '/') + impFile : bare;
          if (cmd === 'include' && only && !only.has(includeName(name))) return '\n';
          const found = resolvePath(texFiles, mainDir, name, ['', '.tex', '.ltx']);
          if (!found || found === path) return m;
          let body = expand(found, depth + 1);
          if (cmd === 'subfile') body = '\n' + subfileBody(body) + '\n';
          body = mark(found) + body;
          seen.delete(found);
          return (cmd === 'include' ? '\n' : '') + body + (cmd === 'include' ? '\n' : '');
        });
      return out;
    };
    let text = expand(mainPath, 0);
    // A bibliography from BibTeX: arXiv requires the .bbl, which is plain thebibliography.
    const bbls = Object.keys(texFiles).filter((n) => n.endsWith('.bbl'));
    if (bbls.length && !/\\begin\{thebibliography\}/.test(text)) {
      const base = mainPath.replace(/\.[^./]+$/, '');
      const bbl = bbls.find((n) => n === base + '.bbl') || bbls[0];
      let used = false;
      text = text.replace(/\\bibliography\s*\{[^}]*\}|\\printbibliography(\[[^\]]*\])?/, () => {
        used = true;
        return texFiles[bbl];
      });
      if (!used) text = text.replace(/\\end\{document\}/, () => texFiles[bbl] + '\n\\end{document}');
    }
    if (starts) {
      // Take out the marks, remembering where they were.
      let out = '';
      let last = 0;
      for (const m of text.matchAll(/\u0000([^\u0000]*)\u0000/g)) {
        out += text.slice(last, m.index);
        if (!(m[1] in starts)) starts[m[1]] = out.length;
        last = m.index + m[0].length;
      }
      text = out + text.slice(last);
    }
    return text;
  }

  const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

  /**
   * Fetch and unpack a paper.
   * Returns { id, name, source, images: { path: Blob }, files: [paths] }.
   */
  async function importPaper(input, options) {
    const id = parseId(input);
    if (!id) throw new Error('That does not look like an arXiv link or id.');
    const doFetch = (options && options.fetch) || fetch;
    let res;
    try {
      res = await doFetch(`https://arxiv.org/src/${id}`);
    } catch (e) {
      throw new Error(`Could not reach arXiv (${e.message}). Check your connection, or download the source from arxiv.org/src/${id} and open it here.`);
    }
    if (res.status === 404) throw new Error(`arXiv has no paper ${id}.`);
    if (!res.ok) throw new Error(`arXiv answered ${res.status} for ${id}.`);
    const type = res.headers.get('content-type') || '';
    if (/pdf/.test(type)) throw new Error(`${id} has no LaTeX source on arXiv: the authors uploaded only a PDF.`);
    const bytes = await gunzip(new Uint8Array(await res.arrayBuffer()));

    let raw;
    if (isTar(bytes)) raw = untar(bytes);
    else if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      throw new Error(`${id} has no LaTeX source on arXiv: the authors uploaded only a PDF.`);
    } else raw = { 'main.tex': bytes };

    const texFiles = {};
    const images = {};
    for (const [path, data] of Object.entries(raw)) {
      const ext = (path.split('.').pop() || '').toLowerCase();
      if (/^(tex|ltx|latex|bbl|sty|cls|def)$/.test(ext) || !path.includes('.')) texFiles[path] = decodeText(data);
      else if (IMAGE_TYPES[ext]) images[path] = new Blob([data], { type: IMAGE_TYPES[ext] });
    }
    const candidates = {};
    for (const n of Object.keys(texFiles)) if (/\.(tex|ltx|latex)$/i.test(n) || !n.includes('.')) candidates[n] = texFiles[n];
    const main = pickMain(candidates);
    if (!main) throw new Error(`No .tex file found in the source of ${id}.`);
    return { id, name: `arXiv-${id.replace('/', '-')}.tex`, source: flatten(main, texFiles), images, main, files: Object.keys(raw) };
  }

  /**
   * A resolveImage function for TeXglass.render from { path: url }:
   * matches \includegraphics paths with or without extension, relative to \graphicspath.
   */
  function imageResolver(urls, source) {
    const dirs = [''];
    const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(source || '');
    if (gp) for (const m of gp[1].matchAll(/\{([^}]*)\}/g)) dirs.push(m[1].replace(/\/?$/, '/'));
    const exts = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];
    return (name) => {
      const clean = name.trim().replace(/^\.\//, '');
      for (const d of dirs) {
        const p = normalize(d + clean);
        for (const e of exts) if (urls[p + e]) return urls[p + e];
        // .pdf/.eps figures are often uploaded as .png too; try swapping the extension.
        const noExt = p.replace(/\.(pdf|eps|ps)$/i, '');
        if (noExt !== p) for (const e of exts.slice(1)) if (urls[noExt + e]) return urls[noExt + e];
      }
      return null;
    };
  }

  return { parseId, untar, pickMain, flatten, includeOnly, includeName, importPaper, imageResolver };
});
