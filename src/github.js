/*
 * Open a LaTeX file straight from a GitHub repository.
 *
 * Takes a github.com link (a file, a folder or a whole repo), a github.dev or
 * raw.githubusercontent.com link, or "owner/repo/blob/branch/path.tex". Files
 * are read from raw.githubusercontent.com, which allows cross-origin requests
 * and has no rate limit; the GitHub API is used only to list a folder or repo
 * when the link does not name a file. The files named by \input and \include,
 * the .bbl bibliography and PNG/JPEG/SVG figures are fetched as well, so the
 * viewer gets one self-contained document, as with an arXiv import.
 *
 * Only public repositories can be read this way.
 *
 * Works in browsers and in Node 18+ (fetch).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./arxiv.js'));
  else root.TeXglassGitHub = factory(root.TeXglassArxiv);
})(typeof self !== 'undefined' ? self : this, function (Arxiv) {
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

    // Files are keyed relative to the main file's folder, as LaTeX resolves them.
    const base = dirOf(mainPath);
    const full = (rel) => normalize((base ? base + '/' : '') + rel);
    const maxFiles = options.maxFiles || 60;
    const texFiles = {};
    const name = mainPath.split('/').pop();
    texFiles[name] = mainText.replace(/\r\n?/g, '\n');
    const missing = [];

    const fetchTex = async (rel) => {
      const clean = normalize(rel.trim().replace(/^"|"$/g, ''));
      if (!clean) return;
      for (const ext of /\.(tex|ltx|latex)$/i.test(clean) ? [''] : ['.tex', '']) {
        if (texFiles[clean + ext] != null) return;
      }
      if (Object.keys(texFiles).length >= maxFiles) return;
      for (const ext of /\.(tex|ltx|latex)$/i.test(clean) ? [''] : ['.tex', '']) {
        const t = await get(rawUrl(ref, full(clean + ext)));
        if (t != null) {
          texFiles[clean + ext] = t.replace(/\r\n?/g, '\n');
          await scan(texFiles[clean + ext]);
          return;
        }
      }
      missing.push(clean);
    };
    const scan = async (text) => {
      const names = [];
      text.replace(INPUTS, (m, pre, arg, impDir, impFile, bare) => {
        if (pre !== undefined) return m;
        names.push(arg !== undefined ? arg : impFile !== undefined ? impDir.replace(/\/?$/, '/') + impFile : bare);
        return m;
      });
      for (const n of names) await fetchTex(n);
    };
    await scan(texFiles[name]);

    let source = texFiles[name];
    const all = () => Object.values(texFiles).join('\n');

    // A .bbl next to the main file, if one was committed.
    if (!/\\begin\{thebibliography\}/.test(all()) && /\\(bibliography|printbibliography)\b/.test(all())) {
      const bblName = name.replace(/\.[^.]+$/, '') + '.bbl';
      const bbl = await get(rawUrl(ref, full(bblName)));
      if (bbl != null) texFiles[bblName] = bbl;
    }
    source = Arxiv.flatten(name, texFiles);

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
      links: links(owner, repo, ref, mainPath),
      files: Object.keys(texFiles).map(full),
      missing,
    };
  }

  /**
   * A bookmarklet that opens the GitHub page being viewed in TeXglass at viewerUrl.
   */
  function bookmarklet(viewerUrl) {
    const target = String(viewerUrl).replace(/[?#].*$/, '');
    return `javascript:(function(){window.open(${JSON.stringify(target + '?gh=')}+encodeURIComponent(location.href),'_blank')})()`;
  }

  return { parseUrl, splits, importFile, links, bookmarklet };
});
