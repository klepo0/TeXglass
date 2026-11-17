/*
 * Browse OpenAI's collection of mathematical preprints (github.com/openai/math)
 * and open a manuscript's LaTeX source in the viewer.
 *
 * The catalogue comes from two files in the repository, read from
 * raw.githubusercontent.com (cross-origin, no rate limit):
 *  - CONTENTS.md, the manuscript map: each result family with its description,
 *    followed by its manuscripts, each a link to the PDF and an abstract;
 *  - overview.tex, which files each family under a discipline.
 *
 * A manuscript lives in preprints/<folder>/ with its LaTeX under build/. The
 * main file is found by trying the usual names on raw.githubusercontent.com
 * first; only if none fits is the folder listed with the GitHub API, which
 * allows 60 requests an hour without signing in. The main file is then opened
 * with TeXglassGitHub.importFile, which pulls in its \input files, the .bbl and
 * figures.
 *
 * Works in browsers and in Node 18+ (fetch).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./github.js'), require('./arxiv.js'));
  else root.TeXglassOpenAIMath = factory(root.TeXglassGitHub, root.TeXglassArxiv);
})(typeof self !== 'undefined' ? self : this, function (GitHub, Arxiv) {
  'use strict';

  const OWNER = 'openai';
  const REPO = 'math';
  const REF = 'main';
  const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${REF}`;
  const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const WEB = `https://github.com/${OWNER}/${REPO}`;

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  /**
   * Parse CONTENTS.md into families:
   * [{ number: '001', title, description, manuscripts: [{ title, folder, pdf, abstract }] }].
   * Descriptions and abstracts keep their GitHub math ($`…`$) and the few HTML
   * tags the file uses (<i>, <sub>, <sup>).
   */
  function parseContents(md) {
    const families = [];
    let family = null;
    let manuscript = null;
    let para = null; // where the paragraph being read goes
    const flush = () => {
      if (para && para.target) para.target[para.key] = para.lines.join(' ').trim();
      para = null;
    };
    for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      if (!line || /^<\/?(td|tr|tbody|table|thead|th)\b/.test(line)) {
        flush();
        continue;
      }
      const fam = /^\*\*(\d+)\.\s+(.+?)\*\*\s*(.*)$/.exec(line);
      if (fam) {
        flush();
        family = { number: fam[1], title: fam[2].replace(/\.$/, ''), description: fam[3], manuscripts: [] };
        families.push(family);
        manuscript = null;
        if (fam[3]) para = { target: family, key: 'description', lines: [fam[3]] };
        continue;
      }
      // A link to a manuscript's PDF. Folder names may hold parentheses, so
      // the link runs to the last ".pdf)" on the line.
      const ms = /^(?:&emsp;)+\[(.+?)\]\((preprints\/.+\.pdf)\)\s*(?:[—–-]\s*(.*))?$/.exec(line);
      if (ms && family) {
        flush();
        const path = ms[2];
        const parts = path.split('/');
        manuscript = { title: ms[1], folder: parts[1], pdf: parts.slice(2).join('/'), abstract: '' };
        if (ms[3]) manuscript.note = ms[3].trim();
        family.manuscripts.push(manuscript);
        continue;
      }
      if (para) para.lines.push(line);
      else if (manuscript && !manuscript.abstract) para = { target: manuscript, key: 'abstract', lines: [line] };
    }
    flush();
    return families;
  }

  /** Parse overview.tex into { familyNumber: discipline }. */
  function parseOverview(tex) {
    const out = {};
    let discipline = null;
    const re = /\\cataloguesection\s*\{([^}]*)\}|\\resultentry\s*\{(\d+)\}/g;
    let m;
    while ((m = re.exec(String(tex || '')))) {
      if (m[1] !== undefined) discipline = m[1].trim();
      else if (discipline) out[m[2]] = discipline;
    }
    return out;
  }

  /**
   * The catalogue: { families, disciplines } where each family also carries
   * its discipline (or ''). options: { fetch }.
   */
  async function loadCatalogue(options) {
    const doFetch = (options && options.fetch) || fetch;
    const get = async (name, required) => {
      let res;
      try {
        res = await doFetch(`${RAW}/${name}`);
      } catch (e) {
        if (!required) return '';
        throw new Error(`Could not reach GitHub (${e.message}). Check your connection.`);
      }
      if (!res.ok) {
        if (!required) return '';
        throw new Error(`Could not read the catalogue of ${OWNER}/${REPO} (GitHub answered ${res.status}).`);
      }
      return res.text();
    };
    const [md, tex] = await Promise.all([get('CONTENTS.md', true), get('overview.tex', false)]);
    const families = parseContents(md);
    if (!families.length) throw new Error(`The catalogue of ${OWNER}/${REPO} has changed shape and could not be read.`);
    const byNumber = parseOverview(tex);
    const disciplines = [];
    for (const f of families) {
      f.discipline = byNumber[f.number] || '';
      if (f.discipline && !disciplines.includes(f.discipline)) disciplines.push(f.discipline);
    }
    return { families, disciplines };
  }

  /** Where to look for a manuscript's main .tex file, likeliest first, relative to its folder. */
  function mainCandidates(pdf) {
    const stem = String(pdf || '').replace(/^.*\//, '').replace(/\.pdf$/i, '');
    const names = ['main', 'paper'];
    if (stem && !names.includes(stem)) names.push(stem);
    names.push('manuscript', 'article');
    const dirs = ['build', 'build/source', 'build/manuscript', 'build/build', 'build/latex', 'build/paper', ''];
    const out = [];
    for (const d of dirs) for (const n of names) out.push((d ? d + '/' : '') + n + '.tex');
    return out;
  }

  const stripComments = (t) => t.replace(/(^|[^\\])%.*$/gm, '$1');
  const isMain = (t) => /\\documentclass|\\begin\s*\{document\}/.test(stripComments(t));

  /** Links for a manuscript: its folder, PDF and README on GitHub. */
  function links(m) {
    const dir = `preprints/${m.folder}`;
    return {
      folder: `${WEB}/tree/${REF}/${encodePath(dir)}`,
      pdf: `${WEB}/blob/${REF}/${encodePath(dir + '/' + m.pdf)}`,
    };
  }

  /**
   * Find a manuscript's main .tex file, as a path in the repository.
   * options: { fetch }.
   */
  async function findMain(m, options) {
    const doFetch = (options && options.fetch) || fetch;
    const dir = `preprints/${m.folder}`;
    const read = async (p) => {
      try {
        const res = await doFetch(`${RAW}/${encodePath(p)}`);
        return res.ok ? await res.text() : null;
      } catch (e) {
        return null;
      }
    };

    // The usual places, a few at a time so a hit early on stops the search.
    const cands = mainCandidates(m.pdf).map((c) => `${dir}/${c}`);
    // build/main.tex, build/paper.tex and build/<pdf name>.tex cover nearly all of them.
    for (let i = 0, n = 3; i < cands.length; i += n, n = 6) {
      const batch = cands.slice(i, i + n);
      const texts = await Promise.all(batch.map(read));
      const hit = batch.findIndex((p, j) => texts[j] != null && isMain(texts[j]));
      if (hit >= 0) return batch[hit];
    }

    // List the folder and pick the file with \documentclass.
    let res;
    try {
      res = await doFetch(`${API}/git/trees/${encodeURIComponent(REF + ':' + dir)}?recursive=1`);
    } catch (e) {
      throw new Error(`Could not reach GitHub (${e.message}). Check your connection.`);
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub limits how often a folder can be listed without signing in. Wait a few minutes and try again.');
    }
    if (!res.ok) throw new Error(`Could not find the LaTeX source of "${m.title}".`);
    const tree = await res.json();
    const tex = (tree.tree || [])
      .filter((e) => e.type === 'blob' && /\.tex$/i.test(e.path) && !/(^|\/)(verification|tools)\//.test(e.path))
      .map((e) => `${dir}/${e.path}`)
      .sort((a, b) => a.split('/').length - b.split('/').length)
      .slice(0, 12);
    const texts = {};
    await Promise.all(tex.map(async (p) => {
      const t = await read(p);
      if (t != null) texts[p] = t;
    }));
    const main = Arxiv.pickMain(texts);
    if (!main || !isMain(texts[main])) throw new Error(`Could not find the LaTeX source of "${m.title}".`);
    return main;
  }

  /**
   * Open a manuscript: its main file with everything it pulls in, as
   * TeXglassGitHub.importFile returns it, plus { manuscript, links }.
   * options: { fetch }.
   */
  async function openManuscript(m, options) {
    const main = await findMain(m, options);
    const file = await GitHub.importFile(`${WEB}/blob/${REF}/${main}`, Object.assign({}, options, { findRoot: false }));
    return Object.assign(file, { manuscript: m, paperLinks: links(m) });
  }

  /** The manuscript in a list of families whose folder is `folder`, or null. */
  function byFolder(families, folder) {
    for (const f of families) for (const m of f.manuscripts) if (m.folder === folder) return m;
    return null;
  }

  return { OWNER, REPO, REF, parseContents, parseOverview, loadCatalogue, mainCandidates, findMain, openManuscript, links, byFolder, repoUrl: WEB };
});
