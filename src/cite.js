/*
 * Citation previews, in the web viewer, the VS Code preview and the browser
 * extension. Resting on a citation already shows its bibliography entry; this
 * adds, under the entry, the cited paper's title, authors and abstract, and a
 * button that opens it in TeXglass when it is on arXiv.
 *
 * Nothing runs while a document renders. A lookup starts only when a citation
 * is hovered, is asked of free services that allow browser requests and need
 * no key (DataCite for arXiv records, Crossref for DOIs and reference
 * strings), and is kept for the rest of the visit. Offline, or when nothing is
 * found, the bibliography entry is all that shows.
 *
 *   const cites = TeXglassCite.create({
 *     getJson(url) { ... },        // optional: Promise of parsed JSON (default: fetch)
 *     online() { ... },            // optional: false when offline (default: navigator.onLine)
 *     openArxiv(id) { ... },       // open an arXiv paper in TeXglass
 *     openLink(href) { ... },      // optional: open an outside link
 *   });
 *   const note = cites.noteFor(li, { onChange() { ... } });   // the <li> of a bibliography entry, or null
 */
(function (root) {
  'use strict';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------------------------------------------------------------------
  // Reading a bibliography entry
  // ---------------------------------------------------------------------------

  const NEW_ID = /(?:^|[^\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d.]*\d)/;
  const OLD_ID = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/;

  /** The arXiv id named in a piece of text or a link, or null. */
  function arxivIdIn(s) {
    s = String(s || '');
    let m = /arxiv\.org\/(?:abs|pdf|src)\/([^\s?#]+?)(?:v\d+)?(?:\.pdf)?(?=[\s?#"'<>),;]|$)/i.exec(s);
    if (m) return clean(m[1]);
    m = /10\.48550\/arxiv\.([^\s"'<>,;]+)/i.exec(s);
    if (m) return clean(m[1].replace(/v\d+$/, '').replace(/[.)]+$/, ''));
    // "arXiv:2301.00001", "arXiv preprint arXiv:2301.00001v2", "arXiv: math/0601001", "eprint 2301.00001"
    const re = /arxiv\s*(?:preprint|e-?print)?\s*(?:arxiv)?\s*[:\s]\s*([^\s,;)\]]+)/gi;
    while ((m = re.exec(s))) {
      const id = clean(m[1].replace(/\.$/, '').replace(/v\d+$/, ''));
      if (id) return id;
    }
    return null;
    function clean(id) {
      id = String(id).replace(/\.$/, '');
      let k = NEW_ID.exec(' ' + id);
      if (k && ('' + id).startsWith(k[1])) return k[1];
      k = OLD_ID.exec(id);
      return k && id.startsWith(k[1]) ? k[1] : null;
    }
  }

  /** The DOI named in a piece of text or a link, or null. */
  function doiIn(s) {
    const m = /\b(10\.\d{4,9}\/[^\s"'<>]+)/.exec(String(s || ''));
    if (!m) return null;
    let d = m[1].replace(/[.,;:]+$/, '');
    // a closing bracket that opens nowhere in the DOI belongs to the text around it
    while (/[)\]]$/.test(d) && (d.split('(').length < d.split(')').length || d.split('[').length < d.split(']').length)) d = d.slice(0, -1);
    try { d = decodeURIComponent(d); } catch (e) { /* keep it */ }
    return d;
  }

  /** Lower case, accents and TeX off, words only: for comparing titles with entries. */
  function norm(s) {
    return String(s || '')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\\[a-zA-Z]+/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Does the entry's text contain this title? (Titles of a word or two are too loose to trust.) */
  function titleInEntry(title, entryText) {
    const t = norm(title);
    if (t.length < 12 || t.split(' ').length < 2) return false;
    return (' ' + norm(entryText) + ' ').includes(' ' + t + ' ');
  }

  /**
   * What an entry says about the paper it cites:
   * { key, text, arxiv, doi, title } where title is a guess (the emphasised
   * part, or a quoted part), or ''.
   */
  function entryOf(li) {
    const body = li.querySelector('.bib-body') || li;
    const text = body.textContent.replace(/\s+/g, ' ').trim();
    const hrefs = Array.from(body.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    let arxiv = null;
    let doi = null;
    for (const h of hrefs) {
      arxiv = arxiv || arxivIdIn(h);
      if (!doi && /doi\.org\//i.test(h)) doi = doiIn(h);
    }
    arxiv = arxiv || arxivIdIn(text);
    doi = doi || doiIn(text);
    if (doi && /^10\.48550\/arxiv\./i.test(doi)) {
      arxiv = arxiv || arxivIdIn(doi);
      doi = null;
    }
    let title = '';
    const em = body.querySelector('em, i, .textit, .emph');
    if (em && em.textContent.trim().split(/\s+/).length >= 2) title = em.textContent.replace(/\s+/g, ' ').trim();
    if (!title) {
      const q = /[“"‘]([^”"’]{12,300})[”"’]/.exec(text) || /``([^']{12,300})''/.exec(text);
      if (q) title = q[1].trim();
    }
    return { key: text, text, arxiv, doi, title: title.replace(/[.,;:]+$/, '') };
  }

  // ---------------------------------------------------------------------------
  // Asking DataCite and Crossref
  // ---------------------------------------------------------------------------

  const DATACITE_FIELDS = '&fields%5Bdois%5D=doi,titles,creators,publicationYear,descriptions,identifiers';

  const urls = {
    /** The DataCite record of an arXiv paper (every arXiv paper has a DOI 10.48550/arXiv.<id>). */
    arxiv: (id) => `https://api.datacite.org/dois/${encodeURIComponent('10.48550/arXiv.' + id)}?${DATACITE_FIELDS.slice(1)}`,
    /** arXiv papers with this exact title. */
    arxivTitle: (title) =>
      `https://api.datacite.org/dois?query=${encodeURIComponent('titles.title:"' + title.replace(/["\\]/g, ' ') + '"')}` +
      `&client-id=arxiv.content&page%5Bsize%5D=5${DATACITE_FIELDS}`,
    /** Crossref's record of a DOI. */
    doi: (doi) => `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    /** Crossref's best matches for a reference as printed in a bibliography. */
    reference: (text) =>
      `https://api.crossref.org/works?rows=3&select=DOI,title,author,issued,abstract&query.bibliographic=${encodeURIComponent(text.slice(0, 300))}`,
  };

  /** "Lyons, Terry" -> "Terry Lyons". */
  function personName(c) {
    if (!c) return '';
    if (c.givenName && c.familyName) return `${c.givenName} ${c.familyName}`;
    if (c.given || c.family) return [c.given, c.family].filter(Boolean).join(' ');
    return String(c.name || '').replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim();
  }

  /** Abstracts come as plain text, or as JATS XML from Crossref. */
  function plainAbstract(s) {
    return String(s || '')
      .replace(/<jats:title>[^<]*<\/jats:title>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/^\s*abstract[.:]?\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fromDataCite(item) {
    const a = (item && item.attributes) || {};
    let id = null;
    for (const i of a.identifiers || []) if (/^arxiv$/i.test(i.identifierType || '')) id = arxivIdIn('arXiv:' + i.identifier);
    if (!id) id = arxivIdIn(a.doi || item.id || '');
    const abs = (a.descriptions || []).find((d) => d.descriptionType === 'Abstract') || (a.descriptions || [])[0];
    return {
      arxiv: id,
      title: ((a.titles || [])[0] || {}).title || '',
      authors: (a.creators || []).map(personName).filter((n) => /[a-z]/i.test(n)),
      year: a.publicationYear || null,
      abstract: abs ? plainAbstract(abs.description) : '',
    };
  }

  function fromCrossref(w) {
    const issued = w && w.issued && w.issued['date-parts'] && w.issued['date-parts'][0];
    return {
      doi: w.DOI || null,
      title: plainAbstract((w.title || [])[0] || ''),
      authors: (w.author || []).map(personName).filter(Boolean),
      year: (issued && issued[0]) || null,
      abstract: plainAbstract(w.abstract || ''),
    };
  }

  /**
   * Look up the paper an entry cites. Resolves to
   * { title, authors, year, abstract, arxiv, doi, found } (found: whether any
   * service knew it). Rejects only when every request failed to get through.
   */
  async function lookup(entry, getJson) {
    const out = { title: '', authors: [], year: null, abstract: '', arxiv: entry.arxiv || null, doi: entry.doi || null, found: false };
    let reached = false;
    let failed = null;
    const ask = async (url) => {
      try {
        const json = await getJson(url);
        reached = true;
        return json;
      } catch (e) {
        if (e && e.status) reached = true; // the service answered, with an error such as 404
        else failed = e;
        return null;
      }
    };
    const take = (info) => {
      for (const k of ['title', 'year', 'abstract', 'arxiv', 'doi']) if (info[k] && !out[k]) out[k] = info[k];
      if (info.authors && info.authors.length && !out.authors.length) out.authors = info.authors;
      out.found = true;
    };
    let askedCrossref = false;

    // 1. No identifier: find the DOI and title from the reference as printed.
    if (!out.arxiv && !out.doi && !entry.title) {
      askedCrossref = true;
      const json = await ask(urls.reference(entry.text));
      const items = (json && json.message && json.message.items) || [];
      const hit = items.map(fromCrossref).find((w) => titleInEntry(w.title, entry.text));
      if (hit) take(hit);
    }
    // 2. A DOI and no title yet: Crossref knows the title (and sometimes the abstract).
    if (!out.arxiv && out.doi && !out.title && !askedCrossref) {
      askedCrossref = true;
      const json = await ask(urls.doi(out.doi));
      if (json && json.message) take(fromCrossref(json.message));
    }
    // 3. Is it on arXiv? Look for the title among arXiv records.
    const title = out.title || entry.title;
    if (!out.arxiv && title) {
      const json = await ask(urls.arxivTitle(title));
      const hit = ((json && json.data) || []).map(fromDataCite).find((r) => r.arxiv && norm(r.title) === norm(title));
      if (hit) take(hit);
    }
    // 4. On arXiv: its record has the abstract.
    if (out.arxiv && !out.abstract) {
      const json = await ask(urls.arxiv(out.arxiv));
      if (json && json.data) take(fromDataCite(json.data));
    }
    // 5. Still no abstract: Crossref sometimes has it.
    if (out.doi && !out.abstract && !askedCrossref) {
      const json = await ask(urls.doi(out.doi));
      if (json && json.message) take(fromCrossref(json.message));
    }
    if (!reached && failed) throw failed;
    return out;
  }

  // ---------------------------------------------------------------------------
  // The note under a citation's preview
  // ---------------------------------------------------------------------------

  async function fetchJson(url) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 10000) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal, headers: { Accept: 'application/json' } } : undefined);
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const ABSTRACT_MAX = 1500;

  function create(opts) {
    opts = opts || {};
    const getJson = opts.getJson || fetchJson;
    const online = opts.online || (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    const cache = new Map(); // entry text -> Promise of the lookup

    function find(entry) {
      let p = cache.get(entry.key);
      if (!p) {
        p = lookup(entry, getJson);
        cache.set(entry.key, p);
        // a failed lookup (offline, a network error) is tried again on the next hover
        p.catch(() => { if (cache.get(entry.key) === p) cache.delete(entry.key); });
      }
      return p;
    }

    /** Text with $…$ maths, drawn with KaTeX where the page has it (the web viewer does). */
    function withMath(text) {
      const katex = opts.katex || root.katex;
      if (!katex || !/\$/.test(text)) return esc(text);
      return text.split(/(\$[^$]{1,300}\$)/).map((part, k) => {
        if (k % 2 === 0) return esc(part);
        try { return katex.renderToString(part.slice(1, -1), { throwOnError: false, strict: 'ignore' }); } catch (e) { return esc(part); }
      }).join('');
    }

    function html(info, entry) {
      const parts = [];
      const same = info.title && titleInEntry(info.title, entry.text);
      if (info.title && !same) parts.push(`<div class="cite-title">${withMath(info.title)}</div>`);
      if (info.abstract) {
        const a = info.abstract.length > ABSTRACT_MAX ? info.abstract.slice(0, ABSTRACT_MAX - 1).replace(/\s+\S*$/, '') + ' …' : info.abstract;
        parts.push(`<div class="cite-abstract"><span class="insight-usedby-k">Abstract</span> ${withMath(a)}</div>`);
      } else if (info.found) {
        parts.push('<div class="insight-muted">No abstract is on record for this paper.</div>');
      } else {
        parts.push('<div class="insight-muted">Not found on arXiv or Crossref; the entry above is all there is.</div>');
      }
      const links = [];
      if (info.arxiv) {
        links.push(`<button type="button" class="cite-open" data-arxiv="${esc(info.arxiv)}">Open in TeXglass</button>`);
        links.push(`<a href="https://arxiv.org/abs/${esc(info.arxiv)}" target="_blank" rel="noopener" class="cite-out">arXiv:${esc(info.arxiv)}</a>`);
      }
      if (info.doi) links.push(`<a href="https://doi.org/${esc(info.doi)}" target="_blank" rel="noopener" class="cite-out">doi:${esc(info.doi)}</a>`);
      if (links.length) parts.push(`<div class="cite-actions">${links.join(' ')}</div>`);
      return parts.join('');
    }

    /** The note for a bibliography entry's preview: filled in when the lookup comes back. */
    function noteFor(li, nopts) {
      nopts = nopts || {};
      if (!li || !li.closest || !li.closest('.bibliography')) return null;
      const entry = entryOf(li);
      const div = (li.ownerDocument || document).createElement('div');
      div.className = 'cite-note';
      div.addEventListener('click', (e) => {
        const open = e.target.closest('.cite-open');
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          if (opts.openArxiv) opts.openArxiv(open.dataset.arxiv);
          return;
        }
        const out = e.target.closest('a.cite-out');
        if (out && opts.openLink) {
          e.preventDefault();
          e.stopPropagation();
          opts.openLink(out.href);
        }
      });
      const done = () => { if (nopts.onChange) nopts.onChange(div); };
      if (!online()) {
        div.innerHTML = '<div class="insight-muted">Offline: showing the entry from the bibliography.</div>' +
          (entry.arxiv ? `<div class="cite-actions"><button type="button" class="cite-open" data-arxiv="${esc(entry.arxiv)}">Open in TeXglass</button></div>` : '');
        return div;
      }
      div.innerHTML = '<div class="insight-muted cite-wait">Looking up the abstract…</div>';
      find(entry).then(
        (info) => { div.innerHTML = html(info, entry); done(); },
        () => {
          div.innerHTML = '<div class="insight-muted">Could not reach arXiv or Crossref; showing the entry from the bibliography.</div>' +
            (entry.arxiv ? `<div class="cite-actions"><button type="button" class="cite-open" data-arxiv="${esc(entry.arxiv)}">Open in TeXglass</button></div>` : '');
          done();
        }
      );
      return div;
    }

    return { noteFor, find };
  }

  const api = { create, lookup, entryOf, arxivIdIn, doiIn, norm, titleInEntry, urls, fromDataCite, fromCrossref };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassCite = api;
})(typeof self !== 'undefined' ? self : this);
