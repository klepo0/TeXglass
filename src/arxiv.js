/*
 * Import a paper's LaTeX source from arXiv.
 *
 * arxiv.org/src/<id> serves the source the authors uploaded, gzipped: usually a
 * tar archive, sometimes a single .tex file. It allows cross-origin requests,
 * so a browser page can fetch it directly. This module unpacks it, finds the
 * main file, and inlines \input/\include and the bibliography (from the .bbl,
 * or built from the .bib files when there is no usable .bbl) so the
 * viewer gets one self-contained document. Images come back as raw files that
 * the caller can turn into object URLs.
 *
 * Works in browsers and in Node 18+ (fetch and DecompressionStream).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bib.js'), require('./eps.js'));
  else root.TeXglassArxiv = factory(root.TeXglassBib, root.TeXglassEps);
})(typeof self !== 'undefined' ? self : this, function (Bib, Eps) {
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
   * The thebibliography to put in place of \bibliography / \printbibliography,
   * or '' if the document has one already or there is nothing to build it from.
   * A BibTeX .bbl is a thebibliography and goes in as it is. biblatex's .bbl
   * (written by biber) is not, so it is read and turned into one. Without a .bbl,
   * the .bib files the document names (or, failing that, any in the source) are
   * read and the cited entries listed.
   */
  function bibliographyFor(mainPath, texFiles, text) {
    if (/\\begin\{thebibliography\}/.test(text)) return '';
    const asks = /\\(bibliography|printbibliography|addbibresource)\b/.test(text.replace(/(^|[^\\])%.*$/gm, '$1'));
    const base = mainPath.replace(/\.[^./]+$/, '');
    const bbls = Object.keys(texFiles).filter((n) => /\.bbl$/i.test(n));
    const bbl = bbls.find((n) => n === base + '.bbl') || bbls[0];
    if (bbl && /\\begin\s*\{thebibliography\}/.test(texFiles[bbl])) return texFiles[bbl];
    if (!asks || !Bib) return '';
    const cited = Bib.citedKeys(text);
    const style = Bib.styleOf(text);
    if (bbl && Bib.isBiblatexBbl(texFiles[bbl])) {
      const entries = Bib.parseBbl(texFiles[bbl]);
      if (Object.keys(entries).length) return Bib.makeBibliography(entries, cited, style, { keepOrder: true }).text;
    }
    const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const bibs = [];
    for (const name of Bib.bibResources(text)) {
      const found = resolvePath(texFiles, dirOf(mainPath), name, ['.bib', '']);
      if (found && !bibs.includes(found)) bibs.push(found);
    }
    if (!bibs.length) bibs.push(...Object.keys(texFiles).filter((n) => /\.bib$/i.test(n)));
    if (!bibs.length) return '';
    const entries = {};
    for (const b of bibs) Object.assign(entries, Bib.parseBib(texFiles[b]));
    return Bib.makeBibliography(entries, cited, style).text;
  }

  /**
   * Inline \input, \include, \subfile and \import into the main file, and
   * replace \bibliography{…} / \printbibliography with a thebibliography
   * (see bibliographyFor).
   * \include files left out by \includeonly are dropped, and a \subfile
   * brings in only its document body.
   * If opts.starts is an object, it is filled with { path: offset } of where
   * each pulled-in file's text begins in the result.
   */
  /** Packages whose environments TeXglass understands without reading their .sty. */
  const NATIVE_PACKAGES = new Set(['mhequ']);

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
      const out = text.replace(/(^|[^\\])(%.*$)|\\(input|include|subfile)\s*\{([^}]*)\}|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]*)\}|\\input\s+([^\s{}\\]+)|\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/gm,
        (m, pre, comment, cmd, arg, impDir, impFile, bare, pkgs) => {
          if (comment !== undefined) return m;
          if (pkgs !== undefined) return localPackages(m, pkgs, (found) => expand(found, depth + 1));
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
    // The authors' own packages (macros.sty next to the paper) hold macro
    // definitions the paper needs: put them where they are loaded. Packages
    // TeXglass implements itself stay out, since their internals would
    // redefine \tag, \label and the like.
    const localPackages = (m, pkgs, load) => {
      const kept = [];
      let inlined = '';
      for (const name of pkgs.split(',').map((n) => n.trim()).filter(Boolean)) {
        const found = !NATIVE_PACKAGES.has(name) && resolvePath(texFiles, mainDir, name, ['.sty']);
        if (found && !seen.has(found)) inlined += `\n\\makeatletter\n${load(found)}\n\\makeatother\n`;
        else if (!found) kept.push(name);
      }
      if (!inlined) return m;
      return (kept.length ? m.replace(/\{[^}]*\}$/, `{${kept.join(',')}}`) : '') + inlined;
    };
    let text = expand(mainPath, 0);
    const bib = bibliographyFor(mainPath, texFiles, text);
    if (bib) {
      let used = false;
      text = text.replace(/\\bibliography\s*\{[^}]*\}|\\printbibliography(\[[^\]]*\])?/, () => {
        used = true;
        return bib;
      });
      if (!used) text = text.replace(/\\end\{document\}/, () => bib + '\n\\end{document}');
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

  /** Bytes as a string of the same character codes (PostScript is 8-bit text). */
  function latin1(bytes) {
    let s = '';
    for (let k = 0; k < bytes.length; k += 8192) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
    return s;
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
      if (/^(tex|ltx|latex|bbl|bib|sty|cls|def)$/.test(ext) || !path.includes('.')) texFiles[path] = decodeText(data);
      else if (IMAGE_TYPES[ext]) images[path] = new Blob([data], { type: IMAGE_TYPES[ext] });
    }
    // .eps figures, which browsers cannot show, drawn as SVG (unless the authors
    // also uploaded the figure as a picture browsers can show)
    if (Eps) {
      for (const [path, data] of Object.entries(raw)) {
        if (!/\.(eps|ps|epsi)$/i.test(path)) continue;
        const stem = path.replace(/\.[^.]+$/, '');
        if (['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'].some((e) => images[stem + e])) continue;
        let r = null;
        try { r = Eps.toSvg(latin1(data)); } catch (e) { r = null; }
        if (r) images[path] = new Blob([r.svg], { type: 'image/svg+xml' });
      }
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
    const exts = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.eps', '.ps'];
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


  // --- searching arXiv ---------------------------------------------------------
  //
  // arXiv's own search API (export.arxiv.org/api) sends no CORS header, so a web
  // page cannot call it. Every arXiv paper has a DataCite DOI (10.48550/arXiv.*),
  // and DataCite's API allows browser requests with no key or daily budget, so
  // it is asked first. OpenAlex (which pauses keyless search under load and has
  // a per-IP daily budget) and Semantic Scholar (often 429, with no CORS header
  // on the error) are fallbacks.

  const OPENALEX_ARXIV = 'S4306400194'; // OpenAlex's id for the arXiv repository
  const SEARCH_PAGE = 25;

  /** An abstract from OpenAlex's inverted index { word: [positions] }. */
  function abstractFromIndex(index) {
    if (!index || typeof index !== 'object') return '';
    const words = [];
    for (const [w, positions] of Object.entries(index)) for (const p of positions) words[p] = w;
    return words.filter((w) => w != null).join(' ');
  }

  /** The arXiv id of an OpenAlex work, from its arXiv landing page, PDF link or arXiv DOI. */
  function openAlexArxivId(work) {
    const urls = [];
    for (const l of work.locations || []) urls.push(l.landing_page_url, l.pdf_url);
    if (work.primary_location) urls.push(work.primary_location.landing_page_url, work.primary_location.pdf_url);
    for (const u of urls) {
      if (u && /arxiv\.org\/(abs|pdf)\//i.test(u)) {
        const id = parseId(u.replace(/v\d+(\.pdf)?$/i, ''));
        if (id) return id;
      }
    }
    const doi = String((work.ids && work.ids.doi) || work.doi || '');
    const m = /10\.48550\/arxiv\.(.+)$/i.exec(doi);
    return m ? parseId(m[1]) : null;
  }

  function fromOpenAlex(json) {
    const results = [];
    for (const w of json.results || []) {
      const id = openAlexArxivId(w);
      if (!id) continue;
      results.push({
        id,
        title: w.display_name || w.title || id,
        authors: (w.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean),
        year: w.publication_year || null,
        abstract: abstractFromIndex(w.abstract_inverted_index),
      });
    }
    return { total: (json.meta && json.meta.count) || results.length, results };
  }

  function fromSemanticScholar(json) {
    const results = [];
    for (const p of json.data || []) {
      const id = p.externalIds && p.externalIds.ArXiv ? parseId(p.externalIds.ArXiv) : null;
      if (!id) continue;
      results.push({
        id,
        title: p.title || id,
        authors: (p.authors || []).map((a) => a.name).filter(Boolean),
        year: p.year || null,
        abstract: p.abstract || '',
      });
    }
    return { total: json.total || results.length, results };
  }

  /** "Lyons, Terry" -> "Terry Lyons"; organisations stay as they are. */
  function dataCiteName(c) {
    if (!c) return '';
    if (c.givenName && c.familyName) return `${c.givenName} ${c.familyName}`;
    return String(c.name || '').replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim();
  }

  function fromDataCite(json) {
    const results = [];
    for (const item of json.data || []) {
      const a = item.attributes || {};
      let id = null;
      for (const i of a.identifiers || []) if (/^arxiv$/i.test(i.identifierType || '')) id = parseId(i.identifier);
      if (!id) {
        const m = /10\.48550\/arxiv\.(.+)$/i.exec(a.doi || item.id || '');
        if (m) id = parseId(m[1]);
      }
      if (!id) continue;
      const abs = (a.descriptions || []).find((d) => d.descriptionType === 'Abstract') || (a.descriptions || [])[0];
      results.push({
        id,
        title: ((a.titles || [])[0] || {}).title || id,
        authors: (a.creators || []).map(dataCiteName).filter((n) => /[a-z]/i.test(n)),
        year: a.publicationYear || null,
        abstract: abs ? String(abs.description || '').replace(/\s+/g, ' ').trim() : '',
      });
    }
    return { total: (json.meta && json.meta.total) || results.length, results };
  }

  /** The request URLs for one page of a search, in the order they are tried. */
  function searchUrls(query, page) {
    const q = encodeURIComponent(String(query).trim());
    const p = Math.max(1, page | 0);
    return {
      datacite: `https://api.datacite.org/dois?query=${q}&client-id=arxiv.content&sort=relevance` +
        `&page%5Bsize%5D=${SEARCH_PAGE}&page%5Bnumber%5D=${p}` +
        '&fields%5Bdois%5D=doi,titles,creators,publicationYear,descriptions,identifiers',
      openalex: `https://api.openalex.org/works?search=${q}&filter=locations.source.id:${OPENALEX_ARXIV}` +
        `&per_page=${SEARCH_PAGE}&page=${p}` +
        '&select=id,display_name,publication_year,authorships,abstract_inverted_index,locations,primary_location,ids',
      semanticscholar: `https://api.semanticscholar.org/graph/v1/paper/search?query=${q}` +
        `&offset=${(p - 1) * SEARCH_PAGE}&limit=${SEARCH_PAGE}&fields=title,authors,year,abstract,externalIds`,
    };
  }

  /**
   * Search arXiv papers by keywords, title or author.
   * Resolves to { total, results: [{ id, title, authors, year, abstract }], source, page, more }.
   * DataCite and OpenAlex are asked for arXiv records only; Semantic Scholar results are
   * kept when they have an arXiv id. A source that fails, or finds nothing, passes to the next.
   */
  async function search(query, options) {
    const opts = options || {};
    const doFetch = opts.fetch || fetch;
    const page = Math.max(1, opts.page | 0);
    if (!String(query || '').trim()) return { total: 0, results: [], source: null, page, more: false };
    const urls = searchUrls(query, page);
    const sources = opts.source ? [opts.source] : ['datacite', 'openalex', 'semanticscholar'];
    const names = { datacite: 'DataCite', openalex: 'OpenAlex', semanticscholar: 'Semantic Scholar' };
    const parse = { datacite: fromDataCite, openalex: fromOpenAlex, semanticscholar: fromSemanticScholar };
    let lastError = null;
    let empty = null;
    for (const source of sources) {
      try {
        const res = await doFetch(urls[source]);
        if (!res.ok) throw new Error(`${names[source]} answered ${res.status}`);
        const json = await res.json();
        const out = parse[source](json);
        const fetched = (json.data || json.results || []).length;
        Object.assign(out, { source, page, more: fetched === SEARCH_PAGE && page * SEARCH_PAGE < out.total });
        if (out.results.length || page > 1) return out;
        empty = empty || out;
      } catch (e) {
        lastError = new Error(`${names[source]}: ${e && e.message ? e.message : e}`);
      }
    }
    if (empty) return empty;
    throw lastError || new Error('Search failed.');
  }

  return { parseId, untar, pickMain, flatten, bibliographyFor, includeOnly, includeName, importPaper, imageResolver, search, searchUrls, abstractFromIndex, latin1 };
});
