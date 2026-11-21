/*
 * Open a LaTeX file straight from a GitHub repository.
 *
 * Takes a github.com link (a file, a folder or a whole repo), a github.dev or
 * raw.githubusercontent.com link, or "owner/repo/blob/branch/path.tex". Files
 * are read from raw.githubusercontent.com, which allows cross-origin requests
 * and has no rate limit; the GitHub API is used only to list a folder or repo
 * when the link does not name a file. The files named by \input and \include,
 * the .bbl bibliography (or the .bib files) and PNG/JPEG/SVG figures are
 * fetched as well, so the
 * viewer gets one self-contained document, as with an arXiv import.
 *
 * Only public repositories can be read this way.
 *
 * Works in browsers and in Node 18+ (fetch).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./arxiv.js'), require('./bib.js'), require('./eps.js'));
  else root.TeXglassGitHub = factory(root.TeXglassArxiv, root.TeXglassBib, root.TeXglassEps);
})(typeof self !== 'undefined' ? self : this, function (Arxiv, Bib, Eps) {
  'use strict';

  const RAW = 'https://raw.githubusercontent.com';
  const API = 'https://api.github.com';

  const decodeSeg = (s) => {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  };

  /**
   * Split a link into { owner, repo, kind, rest } or null.
   * kind is 'file' (blob/raw/edit links), 'tree' (a folder) or 'repo';
   * rest holds the segments after blob/tree/…: the branch followed by the path.
   * The branch may itself contain slashes, so it is worked out later.
   */
  function parseUrl(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    s = s.replace(/[?#].*$/, '');
    let raw = false;
    const m = /^(?:https?:\/\/)?(?:www\.)?(github\.com|github\.dev|raw\.githubusercontent\.com)\/(.*)$/i.exec(s);
    if (m) {
      raw = /^raw\./i.test(m[1]);
      s = m[2];
    } else if (/^[a-z]+:/i.test(s) || /^[^/]*\.[a-z]{2,}\//i.test(s)) {
      return null; // some other site
    }
    const segs = s.split('/').filter(Boolean).map(decodeSeg);
    if (segs.length < 2) return null;
    const [owner, repoName] = segs;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repoName)) return null;
    const repo = repoName.replace(/\.git$/, '');
    let rest = segs.slice(2);
    if (raw) {
      if (rest[0] === 'refs' && rest[1] === 'heads') rest = rest.slice(2);
      return rest.length >= 2 ? { owner, repo, kind: 'file', rest } : null;
    }
    if (!rest.length) return { owner, repo, kind: 'repo', rest: [] };
    const what = rest[0];
    if ((what === 'blob' || what === 'raw' || what === 'edit') && rest.length >= 3) return { owner, repo, kind: 'file', rest: rest.slice(1) };
    if (what === 'tree' && rest.length >= 2) return { owner, repo, kind: 'tree', rest: rest.slice(1) };
    return null;
  }

  /** Every way to split rest into a branch and a path, shortest branch first. */
  function splits(rest) {
    const out = [];
    for (let i = 1; i < rest.length; i++) out.push({ ref: rest.slice(0, i).join('/'), path: rest.slice(i).join('/') });
    return out;
  }

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  function normalize(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  }

  /** Links for a file: where to view and edit it on GitHub, and in github.dev. */
  function links(owner, repo, ref, path) {
    const tail = `${owner}/${repo}/%s/${encodePath(ref)}/${encodePath(path)}`;
    return {
      view: `https://github.com/${tail.replace('%s', 'blob')}`,
      edit: `https://github.com/${tail.replace('%s', 'edit')}`,
      dev: `https://github.dev/${tail.replace('%s', 'blob')}`,
    };
  }

  const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
  const IMAGE_EXTS = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];

  // \input-like commands and figures, skipping comments.
  const INPUTS = /(^|[^\\])%.*$|\\(?:input|include|subfile)\s*\{([^}]*)\}|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]*)\}|\\input\s+([^\s{}\\%]+)/gm;
  const FIGURES = /(^|[^\\])%.*$|\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/gm;

  /**
   * Fetch a file, its inputs, bibliography and figures.
   * options: { fetch, maxFiles (default 60), maxImages (default 40) }.
   * Returns { name, source, images: { path: Blob }, owner, repo, ref, path, links, files }.
   */
  async function importFile(input, options) {
    options = options || {};
    const doFetch = options.fetch || fetch;
    const loc = parseUrl(input);
    if (!loc) throw new Error('That does not look like a link to a GitHub repository or file.');
    const { owner, repo } = loc;
    const where = `${owner}/${repo}`;

    const rawUrl = (ref, path) => `${RAW}/${owner}/${repo}/${encodePath(ref)}/${encodePath(path)}`;
    const get = async (url, as) => {
      let res;
      try {
        res = await doFetch(url);
      } catch (e) {
        throw new Error(`Could not reach GitHub (${e.message}). Check your connection.`);
      }
      if (res.status === 404) return null;
      if (res.status === 403 || res.status === 429) {
        throw new Error(/api\.github/.test(url)
          ? 'GitHub limits how often a repository can be listed without signing in. Wait a few minutes, or open the .tex file itself on GitHub and use that link.'
          : `GitHub refused the request (${res.status}).`);
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
      return as === 'json' ? res.json() : as === 'blob' ? res.blob() : res.text();
    };

    let ref = null;
    let mainPath = null;
    let mainText = null;

    if (loc.kind === 'file') {
      // raw.githubusercontent.com takes branch and path joined by "/", so a
      // branch with slashes needs no special care: any split gives the same URLs.
      ref = loc.rest[0];
      mainPath = loc.rest.slice(1).join('/');
      mainText = await get(rawUrl(ref, mainPath));
      if (mainText == null) throw new Error(`Could not open that file. ${where} may be private, or the file was moved or renamed.`);
    } else {
      // A folder or a whole repo: list it and pick the main .tex file.
      let tree = null;
      let dir = '';
      if (loc.kind === 'repo') {
        const info = await get(`${API}/repos/${owner}/${repo}`, 'json');
        if (!info) throw new Error(`Could not find ${where}. It may be private, or the name is misspelt.`);
        ref = info.default_branch;
        tree = await get(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, 'json');
      } else {
        const options = loc.rest.length === 1 ? [{ ref: loc.rest[0], path: '' }] : splits(loc.rest).concat([{ ref: loc.rest.join('/'), path: '' }]);
        for (const c of options) {
          tree = await get(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(c.ref)}?recursive=1`, 'json');
          if (tree) {
            ref = c.ref;
            dir = c.path;
            break;
          }
        }
      }
      if (!tree) throw new Error(`Could not list ${where}. It may be private.`);
      const prefix = dir ? dir + '/' : '';
      const texPaths = (tree.tree || [])
        .filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && /\.(tex|ltx|latex)$/i.test(e.path))
        .map((e) => e.path);
      if (!texPaths.length) throw new Error(`There is no .tex file in ${where}${dir ? '/' + dir : ''}.`);
      // Read the likeliest few and let the arXiv chooser pick the one with \documentclass.
      const ranked = texPaths
        .map((p) => ({ p, score: (/^(main|ms|paper|article|thesis|arxiv)\.tex$/i.test(p.split('/').pop()) ? 2 : 0) - p.slice(prefix.length).split('/').length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      const texts = {};
      for (const { p } of ranked) {
        const t = await get(rawUrl(ref, p));
        if (t != null) texts[p] = t;
      }
      mainPath = Arxiv.pickMain(texts);
      if (!mainPath) throw new Error(`Could not read the .tex files in ${where}.`);
      mainText = texts[mainPath];
    }

    const fix = (t) => (t == null ? null : t.replace(/\r\n?/g, '\n'));
    // .tex files by path in the repo: a promise of the text, or of null if there is none.
    const repoTexts = new Map([[mainPath, Promise.resolve(fix(mainText))]]);
    const fetchRepoTex = (p) => {
      if (!repoTexts.has(p)) repoTexts.set(p, get(rawUrl(ref, p)).then(fix, () => null));
      return repoTexts.get(p);
    };
    const maxFiles = options.maxFiles || 60;

    /**
     * Fetch a main file and everything it pulls in. Files are keyed relative
     * to the main file's folder, as LaTeX resolves them.
     * Returns { name, texFiles, missing, full(rel) -> repo path }.
     */
    const crawl = async (rootPath) => {
      const base = dirOf(rootPath);
      const full = (rel) => normalize((base ? base + '/' : '') + rel);
      const name = rootPath.split('/').pop();
      const texFiles = { [name]: await fetchRepoTex(rootPath) };
      const missing = [];
      const claimed = new Set([name]);
      const fetchTex = async (rel) => {
        const clean = normalize(rel.trim().replace(/^"|"$/g, ''));
        if (!clean || claimed.has(clean) || claimed.size >= maxFiles) return;
        claimed.add(clean);
        for (const ext of /\.(tex|ltx|latex)$/i.test(clean) ? [''] : ['.tex', '']) {
          const t = await fetchRepoTex(full(clean + ext));
          if (t != null) {
            texFiles[clean + ext] = t;
            await scan(t);
            return;
          }
        }
        missing.push(clean);
      };
      const scan = (text) => Promise.all(inputNames(text).map(fetchTex));
      await scan(texFiles[name]);
      return { name, texFiles, missing, full };
    };

    // A chapter opened on its own is shown as part of the whole document.
    const opened = mainPath;
    let project = null;
    if (loc.kind === 'file' && options.findRoot !== false) {
      const root = await findRoot(mainPath, fix(mainText));
      if (root) {
        mainPath = root.path;
        project = root.project || (await crawl(mainPath));
      }
    }
    if (!project) project = await crawl(mainPath);
    const { name, texFiles, missing, full } = project;

    const all = () => Object.values(texFiles).join('\n');

    // A .bbl next to the main file, if one was committed.
    if (!/\\begin\s*\{(thebibliography|bibdiv|biblist)\}/.test(all()) && /\\(bibliography|printbibliography)\b/.test(all())) {
      const bblName = name.replace(/\.[^.]+$/, '') + '.bbl';
      const bbl = await get(rawUrl(ref, full(bblName)));
      if (bbl != null) texFiles[bblName] = bbl;
      // No .bbl (it is rarely committed): the .bib files, from which the viewer builds one.
      if (bbl == null && Bib) {
        for (const n of Bib.bibResources(all()).slice(0, 10)) {
          const rel = /\.bib$/i.test(n) ? n : n + '.bib';
          if (texFiles[rel] != null) continue;
          const t = await get(rawUrl(ref, full(rel)));
          if (t != null) texFiles[rel] = t.replace(/\r\n?/g, '\n');
        }
      }
    }
    const starts = {};
    const source = Arxiv.flatten(name, texFiles, { starts });
    // Where the file that was opened begins in the document, if it is not the main file.
    let start = null;
    if (opened !== mainPath) {
      const rel = Object.keys(starts).find((k) => full(k) === opened);
      if (rel !== undefined) start = starts[rel];
    }

    // Figures.
    const images = {};
    const maxImages = options.maxImages || 40;
    const dirs = [''];
    const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(source);
    if (gp) for (const m of gp[1].matchAll(/\{([^}]*)\}/g)) dirs.push(m[1].replace(/\/?$/, '/'));
    const figures = [];
    source.replace(FIGURES, (m, pre, arg) => {
      if (pre === undefined && arg && !figures.includes(arg.trim())) figures.push(arg.trim());
      return m;
    });
    for (const fig of figures.slice(0, maxImages)) {
      const clean = fig.replace(/^\.\//, '');
      search: for (const d of dirs) {
        const rel = normalize(d + clean);
        const noExt = rel.replace(/\.(pdf|eps|ps)$/i, '');
        const stems = noExt === rel ? [rel] : [noExt];
        for (const stem of stems) {
          const hasExt = /\.(png|jpe?g|gif|svg|webp)$/i.test(stem);
          for (const ext of hasExt ? [''] : IMAGE_EXTS.slice(1)) {
            const p = stem + ext;
            const blob = await get(rawUrl(ref, full(p)), 'blob');
            if (blob) {
              const type = IMAGE_TYPES[(p.split('.').pop() || '').toLowerCase()];
              images[p] = type && blob.type !== type ? new Blob([blob], { type }) : blob;
              break search;
            }
          }
        }
        // an .eps figure, drawn as SVG
        const isEps = /\.(eps|ps)$/i.test(rel);
        if (Eps && (isEps || !/\.[a-z]+$/i.test(rel))) {
          for (const p of isEps ? [rel] : [rel + '.eps']) {
            const blob = await get(rawUrl(ref, full(p)), 'blob');
            if (!blob) continue;
            const r = Eps.toSvg(Arxiv.latin1(new Uint8Array(await blob.arrayBuffer())));
            if (r) { images[p] = new Blob([r.svg], { type: 'image/svg+xml' }); break search; }
          }
        }
        // a .pdf figure, drawn in the viewer by src/pdf.js
        const isPdf = /\.pdf$/i.test(rel);
        if (isPdf || !/\.[a-z]+$/i.test(rel)) {
          for (const p of isPdf ? [rel] : [rel + '.pdf']) {
            const blob = await get(rawUrl(ref, full(p)), 'blob');
            if (blob) { images[p] = new Blob([blob], { type: 'application/pdf' }); break search; }
          }
        }
      }
    }

    return {
      name,
      source,
      images,
      owner,
      repo,
      ref,
      path: mainPath,
      opened,
      start,
      links: links(owner, repo, ref, opened),
      files: Object.keys(texFiles).map(full),
      missing,
    };

    /**
     * The main file of the document `file` belongs to, as { path, project? },
     * or null if `file` is the main file itself (or none was found):
     *  - the file named by a "% !TEX root = …" line near the top;
     *  - for a subfile, the file in \documentclass[main.tex]{subfiles};
     *  - for a file with no \documentclass, the nearest .tex file with one,
     *    in its folder or a folder above, that pulls it in (perhaps through
     *    other files). `project` is then that file's crawl, to reuse.
     */
    async function findRoot(file, text) {
      const head = text.split('\n', 30).join('\n');
      const magic = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(head);
      const body = stripComments(text);
      const sub = /\\documentclass\s*\[([^\]]*)\]\s*\{subfiles\}/.exec(body);
      const named = magic ? magic[1] : sub && sub[1].trim() ? sub[1].trim() : null;
      if (named) {
        const dir = dirOf(file);
        const p = normalize((dir ? dir + '/' : '') + named);
        for (const cand of /\.(tex|ltx)$/i.test(p) ? [p] : [p + '.tex', p]) {
          if (cand !== file && (await fetchRepoTex(cand)) != null) return { path: cand };
        }
        return null;
      }
      if (/\\documentclass/.test(body)) return null;

      // The folders to look in: the file's own, then each one above it.
      const dirs = [];
      for (let d = dirOf(file); ; d = dirOf(d)) {
        dirs.push(d);
        if (!d) break;
      }
      const inDir = (p) => dirOf(p);
      let cands = null;
      try {
        const tree = await get(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, 'json');
        if (tree && tree.tree) {
          cands = tree.tree
            .filter((e) => e.type === 'blob' && /\.(tex|ltx)$/i.test(e.path) && e.path !== file && dirs.includes(inDir(e.path)))
            .map((e) => e.path);
        }
      } catch (e) {
        cands = null; // rate-limited: guess the usual names instead
      }
      if (!cands) {
        cands = [];
        for (const d of dirs.slice(0, 4)) for (const n of MAIN_NAMES) cands.push((d ? d + '/' : '') + n + '.tex');
      }
      const rank = (p) => dirs.indexOf(inDir(p)) * 10 - (MAIN_NAMES.includes(p.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase()) ? 1 : 0);
      cands.sort((a, b) => rank(a) - rank(b));
      cands = cands.slice(0, 40);
      const texts = await Promise.all(cands.map(fetchRepoTex));
      const mains = cands.filter((p, i) => {
        const t = texts[i] && stripComments(texts[i]);
        return t && /\\documentclass/.test(t) && !/\\documentclass\s*\[[^\]]*\]\s*\{subfiles\}/.test(t);
      });
      for (const cand of mains.slice(0, 4)) {
        const project = await crawl(cand);
        if (Object.keys(project.texFiles).some((k) => project.full(k) === file)) return { path: cand, project };
      }
      return null;
    }
  }

  const MAIN_NAMES = ['main', 'paper', 'thesis', 'ms', 'article', 'book', 'notes', 'root', 'master', 'manuscript', 'dissertation', 'report', 'index'];
  const stripComments = (t) => t.replace(/(^|[^\\])%.*$/gm, '$1');

  /** The files a text names with \input, \include, \subfile or \import. */
  function inputNames(text) {
    const names = [];
    text.replace(INPUTS, (m, pre, arg, impDir, impFile, bare) => {
      if (pre !== undefined) return m;
      names.push(arg !== undefined ? arg : impFile !== undefined ? impDir.replace(/\/?$/, '/') + impFile : bare);
      return m;
    });
    return names;
  }

  /**
   * A bookmarklet that opens the GitHub page being viewed in TeXglass at viewerUrl.
   */
  function bookmarklet(viewerUrl) {
    const target = String(viewerUrl).replace(/[?#].*$/, '');
    return `javascript:(function(){window.open(${JSON.stringify(target + '?gh=')}+encodeURIComponent(location.href),'_blank')})()`;
  }

  /**
   * Search public repositories that hold LaTeX (GitHub's language:TeX), best match first.
   * options: { fetch, page (from 1), perPage (default 20), anyLanguage }.
   * Returns { results: [{ owner, repo, name, description, stars, updated, url }], total, more, anyLanguage }
   * (anyLanguage: nothing matched among LaTeX repositories, so these are any repositories).
   * Without signing in GitHub allows about ten searches a minute.
   */
  async function search(query, options) {
    options = options || {};
    const doFetch = options.fetch || fetch;
    const page = options.page || 1;
    const perPage = options.perPage || 20;
    const q = String(query || '').trim();
    if (!q) return { results: [], total: 0, more: false };
    // LaTeX repositories first; if none match, any repository (its LaTeX may not be its main language).
    const anyLanguage = !!options.anyLanguage;
    const url = `${API}/search/repositories?q=${encodeURIComponent(anyLanguage ? q : q + ' language:TeX')}&per_page=${perPage}&page=${page}`;
    let res;
    try {
      res = await doFetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    } catch (e) {
      throw new Error(`Could not reach GitHub (${e.message}). Check your connection.`);
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub allows only a few searches a minute without signing in. Wait a minute and try again.');
    }
    if (res.status === 422) return { results: [], total: 0, more: false };
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const results = items.map((r) => ({
      owner: (r.owner && r.owner.login) || String(r.full_name || '').split('/')[0],
      repo: r.name,
      name: r.full_name,
      description: r.description || '',
      stars: r.stargazers_count || 0,
      updated: r.pushed_at || r.updated_at || '',
      url: r.html_url || `https://github.com/${r.full_name}`,
    }));
    if (!results.length && page === 1 && !anyLanguage) return search(q, Object.assign({}, options, { anyLanguage: true }));
    const total = Math.min(data.total_count || 0, 1000); // GitHub serves the first 1000 only
    return { results, total: data.total_count || 0, more: page * perPage < total && items.length === perPage, anyLanguage };
  }

  return { parseUrl, splits, importFile, links, bookmarklet, search };
});
