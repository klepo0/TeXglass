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
 *   cites.decorate(preview);     // after a render: an "Open in TeXglass" button on entries on arXiv
 *
 * Finding a paper on arXiv: an arXiv id in the entry (arXiv:…, an eprint
 * field, an arxiv.org link, a 10.48550/arXiv DOI) settles it. Otherwise the
 * entry's title (or, for a DOI, Crossref's) is searched for among DataCite's
 * arXiv records, ranked by relevance; failing that, among the first author's
 * arXiv papers. A near title (a plural, a hyphen, a subtitle apart) counts
 * only when the first author is among the record's authors and it was not
 * put on arXiv years after the entry's date. An entry with no title to go on
 * is matched with a paper of the first author's whose title the entry contains.
 *
 * decorate() reads only the entries' own text and links (arXiv:…, eprint
 * fields, arxiv.org links, 10.48550/arXiv DOIs). An entry with a DOI or a
 * title but no arXiv id is looked up only when the pointer rests on it, or
 * when a citation preview of it has already found the paper.
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
    let d = m[1].replace(/\\([_%&#])/g, '$1').replace(/[.,;:]+$/, '');
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

  /** A title squashed to letters and digits: "Non-linear  Lévy-area" -> "nonlinearlevyarea". */
  const squash = (s) => norm(s).replace(/ /g, '');

  /** Dice similarity of two strings' letter pairs: 1 for the same, near 1 for a plural or a hyphen apart. */
  function pairSimilarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const pairs = new Map();
    for (let i = 0; i < a.length - 1; i++) { const k = a.slice(i, i + 2); pairs.set(k, (pairs.get(k) || 0) + 1); }
    let n = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const k = b.slice(i, i + 2);
      const c = pairs.get(k);
      if (c) { n++; pairs.set(k, c - 1); }
    }
    return (2 * n) / (a.length + b.length - 2);
  }

  /**
   * How alike two titles are, from 0 to 1. Journal and arXiv versions of a
   * paper often differ a little ("spaces" / "space", "non-linear" /
   * "nonlinear", a subtitle added on publication), so this is not equality: a
   * title that runs on past the other, but agrees with it as far as it goes,
   * counts as 0.85.
   */
  function titleSimilarity(a, b) {
    a = squash(a);
    b = squash(b);
    if (!a || !b) return 0;
    let sim = pairSimilarity(a, b);
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    if (s.length >= 20 && pairSimilarity(s, l.slice(0, s.length)) >= 0.9) sim = Math.max(sim, 0.85);
    return sim;
  }

  /** Family names from a list of authors as printed: "A. Writer, B. van Reader and Cee, D." -> ["Writer", "Reader", "Cee"]. */
  function surnamesIn(names) {
    const out = [];
    for (let piece of String(names || '').replace(/\bet al\b\.?/gi, '').split(/,|;|&|\band\b/)) {
      const words = piece.trim().split(/\s+/).filter((w) => w && !/\.$/.test(w) && !/^\p{L}$/u.test(w) && !/^(jr|sr|ii|iii|iv)$/i.test(w));
      const last = (words[words.length - 1] || '').replace(/[^\p{L}'’-]+/gu, '');
      if (last.length >= 2 && /^\p{Lu}/u.test(last) && !out.includes(last)) out.push(last);
    }
    return out;
  }

  /** The authors' family names, as printed in an entry (the part before its title, else before its year). */
  function surnamesOf(entry) {
    const text = entry.text || '';
    let end = -1;
    if (entry.title) end = text.indexOf(entry.title);
    if (end <= 0) {
      const m = /[:“"‘]|\(?\b(1[89]|20)\d\d\b/.exec(text);
      end = m ? m.index : Math.min(text.length, 120);
    }
    return surnamesIn(text.slice(0, end)).slice(0, 6);
  }

  /** The year an entry gives (the last one that looks like a year), or null. */
  function yearOf(text) {
    const all = String(text || '').match(/\b(?:1[89]|20)\d\d\b/g);
    return all ? +all[all.length - 1] : null;
  }

  /** Is this person (a family name) among the record's authors? */
  function hasAuthor(record, surname) {
    const n = ' ' + norm(surname) + ' ';
    return (record.authors || []).some((a) => (' ' + norm(a) + ' ').includes(n));
  }

  /** A node's text with its maths as $TeX$ (KaTeX's own text repeats each formula two or three times). */
  function plainText(node) {
    const copy = node.cloneNode(true);
    for (const m of Array.from(copy.querySelectorAll('.math[data-tex]'))) m.replaceWith(`$${m.getAttribute('data-tex')}$`);
    for (const m of Array.from(copy.querySelectorAll('.katex-mathml'))) m.replaceWith('');
    return copy.textContent.replace(/\s+/g, ' ').trim();
  }

  /**
   * Is this emphasised part of an entry where the paper appeared rather than
   * its title? Styles such as alpha and plain set the journal in italics:
   * "A. Writer. On paths. Ann. Probab., 12(3):1–9, 1984." So it is a venue
   * when abbreviated (a capitalised word with a full stop inside it), when a
   * volume or pages follow it, or when it is an arXiv preprint note.
   */
  function isVenue(em, after) {
    if (/\barxiv\b/i.test(em)) return true;
    if (/\b\p{Lu}\p{Ll}*\.\s+\S/u.test(em)) return true;
    return /^[.,:;]?\s*(\(?\d|pages?\b|pp\.|vol\b|no\.|in press|to appear)/i.test(after);
  }

  /** The title in "Authors. Title. Venue": the part after the authors' last name. */
  function titleBefore(pre) {
    pre = pre.replace(/[\s.,;:]+$/, '');
    const m = /^(.*?\p{L}\p{Ll})\.\s+(.+)$/u.exec(pre);
    const t = m ? m[2].trim() : '';
    return t.split(/\s+/).length >= 2 ? t : '';
  }

  /**
   * What an entry says about the paper it cites:
   * { key, text, arxiv, doi, title } where title is a guess (the emphasised
   * part, a quoted part, or what comes before an emphasised journal), or ''.
   */
  function entryOf(li) {
    const body = li.querySelector('.bib-body') || li;
    const text = plainText(body);
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
    const emText = em ? plainText(em) : '';
    if (emText) {
      const at = text.indexOf(emText);
      if (at >= 0 && isVenue(emText, text.slice(at + emText.length))) title = titleBefore(text.slice(0, at));
      else if (emText.split(/\s+/).length >= 2) title = emText;
    }
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

  /** The words of a piece of text, safe inside a DataCite (Elasticsearch) query. */
  function words(s, max) {
    const w = String(s || '').replace(/\\[a-zA-Z]+/g, ' ').match(/[\p{L}\p{N}]+/gu) || [];
    return w.filter((x) => !/^(and|or|not|to|a|an|the|of|in|on|for|with|by|at|from|via)$/i.test(x)).slice(0, max || 6).join(' ');
  }

  const urls = {
    /** The DataCite record of an arXiv paper (every arXiv paper has a DOI 10.48550/arXiv.<id>). */
    arxiv: (id) => `https://api.datacite.org/dois/${encodeURIComponent('10.48550/arXiv.' + id)}?${DATACITE_FIELDS.slice(1)}`,
    /** arXiv papers with this exact title. */
    arxivTitle: (title) =>
      `https://api.datacite.org/dois?query=${encodeURIComponent('titles.title:"' + title.replace(/["\\]/g, ' ') + '"')}` +
      `&client-id=arxiv.content&sort=relevance&page%5Bsize%5D=5${DATACITE_FIELDS}`,
    /** arXiv papers by this author whose titles share words with this one. */
    arxivAuthorTitle: (surname, title) =>
      `https://api.datacite.org/dois?query=${encodeURIComponent(`creators.name:"${words(surname)}"` + (title ? ` AND titles.title:(${words(title, 14).split(' ').join(' OR ')})` : ''))}` +
      `&client-id=arxiv.content&sort=relevance&page%5Bsize%5D=10${DATACITE_FIELDS}`,
    /** arXiv papers by this author, around a year. */
    arxivAuthorYear: (surname, year) =>
      `https://api.datacite.org/dois?query=${encodeURIComponent(`creators.name:"${words(surname)}"` + (year ? ` AND publicationYear:[${year - 4} TO ${year + 1}]` : ''))}` +
      `&client-id=arxiv.content&page%5Bsize%5D=50${DATACITE_FIELDS}`,
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
    let arxiv = null;
    for (const r of (w.relation && w.relation['has-preprint']) || []) arxiv = arxiv || arxivIdIn(r.id || '');
    return {
      arxiv,
      doi: w.DOI || null,
      title: plainAbstract((w.title || [])[0] || ''),
      authors: (w.author || []).map(personName).filter(Boolean),
      surnames: (w.author || []).map((a) => a.family || '').filter(Boolean),
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
      if (info.surnames && info.surnames.length && !(out.surnames && out.surnames.length)) out.surnames = info.surnames;
      out.found = true;
    };
    let askedCrossref = false;
    // A DOI can name a part of the work the entry cites (a book's first
    // chapter, "Introduction"): then its title and abstract are not the entry's.
    const fitting = (info) => {
      if (!entry.title || !info.title || titleSimilarity(info.title, entry.title) >= 0.8 || titleInEntry(info.title, entry.text)) return info;
      return Object.assign({}, info, { title: '', abstract: '', surnames: info.surnames });
    };

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
      if (json && json.message) take(fitting(fromCrossref(json.message)));
    }
    // 3. Is it on arXiv? Look for the title among arXiv records, then among
    // the first author's papers on arXiv, since a title on arXiv often differs
    // a little from the published one, and a short title alone ranks the
    // paper below others that share its words.
    const title = out.title || entry.title;
    if (!out.arxiv) {
      const names = out.surnames && out.surnames.length ? out.surnames : surnamesOf(entry);
      const first = names[0];
      const best = (json, score) => {
        let hit = null;
        let top = 0;
        for (const r of ((json && json.data) || []).map(fromDataCite)) {
          const v = r.arxiv ? score(r) : 0;
          if (v > top) { top = v; hit = r; }
        }
        return hit;
      };
      // a match: the same title, or a near one by the same first author
      const year = yearOf(entry.text);
      const byTitle = (r) => {
        const sim = titleSimilarity(r.title, title);
        // the same title, by one of the authors (a long title needs no author: names are not always read right)
        if (sim >= 0.98 && (!names.length || !r.authors.length || names.some((n) => hasAuthor(r, n)) || norm(title).split(' ').length >= 6)) return sim;
        // a near title put on arXiv years after the paper came out is a later paper ("… revisited")
        if (year && r.year && r.year > year + 2) return 0;
        if (sim >= 0.92 && (!first || names.some((n) => hasAuthor(r, n)))) return sim;
        return sim >= 0.8 && first && hasAuthor(r, first) ? sim : 0;
      };
      if (title) {
        let hit = best(await ask(urls.arxivTitle(title)), byTitle);
        if (!hit && first) hit = best(await ask(urls.arxivAuthorTitle(first, title)), byTitle);
        if (hit) take(hit);
      } else if (first) {
        // no title to go on: a paper of the first author's whose title the entry contains
        const hit = best(await ask(urls.arxivAuthorYear(first, year)), (r) =>
          hasAuthor(r, first) && titleInEntry(r.title, entry.text) ? squash(r.title).length : 0);
        if (hit) take(hit);
      }
    }
    // 4. On arXiv: its record has the abstract.
    if (out.arxiv && !out.abstract) {
      const json = await ask(urls.arxiv(out.arxiv));
      if (json && json.data) take(fromDataCite(json.data));
    }
    // 5. Still no abstract: Crossref sometimes has it.
    if (out.doi && !out.abstract && !askedCrossref) {
      const json = await ask(urls.doi(out.doi));
      if (json && json.message) take(fitting(fromCrossref(json.message)));
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
        (info) => {
          div.innerHTML = html(info, entry);
          // found on arXiv by the lookup: the entry in the bibliography gets its button too
          if (info.arxiv && li.isConnected && !li.closest('.ref-popover')) { li.dataset.tgArxiv = info.arxiv; openButton(li, info.arxiv); }
          done();
        },
        () => {
          div.innerHTML = '<div class="insight-muted">Could not reach arXiv or Crossref; showing the entry from the bibliography.</div>' +
            (entry.arxiv ? `<div class="cite-actions"><button type="button" class="cite-open" data-arxiv="${esc(entry.arxiv)}">Open in TeXglass</button></div>` : '');
          done();
        }
      );
      return div;
    }

    // -------------------------------------------------------------------------
    // The bibliography itself: a button on each entry that is on arXiv
    // -------------------------------------------------------------------------

    const LOOKUP_DWELL = 450; // ms the pointer rests on an entry before it is looked up

    function openButton(li, id) {
      if (li.querySelector('.bib-open')) return;
      const body = li.querySelector('.bib-body') || li;
      const b = (li.ownerDocument || document).createElement('button');
      b.type = 'button';
      b.className = 'bib-open';
      b.dataset.arxiv = id;
      // The label is drawn by CSS, so copying the bibliography does not pick it up.
      b.setAttribute('aria-label', `Open arXiv:${id} in TeXglass`);
      b.title = `Open arXiv:${id} in TeXglass`;
      body.appendChild(b);
    }

    function lookUpLater(li) {
      if (li.dataset.tgArxiv !== '' || li.dataset.tgLookup) return;
      const entry = entryOf(li);
      if (!entry.doi && !entry.title) return;
      li.dataset.tgLookup = 'wait';
      let timer = null;
      const go = () => {
        li.removeEventListener('pointerleave', stop);
        if (!online()) { delete li.dataset.tgLookup; return; }
        li.dataset.tgLookup = 'asked';
        find(entry).then(
          (info) => { if (info.arxiv) { li.dataset.tgArxiv = info.arxiv; openButton(li, info.arxiv); } },
          () => { delete li.dataset.tgLookup; } // try again on the next visit
        );
      };
      const stop = () => { clearTimeout(timer); li.removeEventListener('pointerleave', stop); delete li.dataset.tgLookup; };
      li.addEventListener('pointerleave', stop);
      timer = setTimeout(go, LOOKUP_DWELL);
    }

    const wired = new WeakSet();
    function wire(doc, container) {
      if (!wired.has(doc)) {
        wired.add(doc);
        // Capture, so the host's own click handlers (fold, jump to source) never see it.
        doc.addEventListener('click', (e) => {
          const b = e.target && e.target.closest && e.target.closest('.bib-open');
          if (!b) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          if (opts.openArxiv) opts.openArxiv(b.dataset.arxiv);
        }, true);
      }
      if (!wired.has(container)) {
        wired.add(container);
        container.addEventListener('pointerover', (e) => {
          const li = e.target && e.target.closest && e.target.closest('.bibliography li');
          if (li && container.contains(li)) lookUpLater(li);
        });
      }
    }

    /**
     * Give each bibliography entry under `container` that names an arXiv paper
     * an "Open in TeXglass" button. Cheap (a few regular expressions an entry)
     * and safe to call after every render: entries already seen are skipped.
     */
    function decorate(container) {
      if (!container || !container.querySelectorAll) return 0;
      wire(container.ownerDocument || document, container);
      let n = 0;
      for (const li of container.querySelectorAll('.bibliography li')) {
        if (li.dataset.tgArxiv !== undefined) {
          if (li.dataset.tgArxiv) { openButton(li, li.dataset.tgArxiv); n++; }
          continue;
        }
        const entry = entryOf(li);
        let id = entry.arxiv;
        // a citation preview may already have found it
        const known = !id && cache.get(entry.key);
        if (known) known.then((info) => { if (info.arxiv && !li.querySelector('.bib-open')) { li.dataset.tgArxiv = info.arxiv; openButton(li, info.arxiv); } }, () => {});
        li.dataset.tgArxiv = id || '';
        if (id) { openButton(li, id); n++; }
      }
      return n;
    }

    return { noteFor, find, decorate };
  }

  const api = { create, lookup, entryOf, arxivIdIn, doiIn, norm, titleInEntry, titleSimilarity, surnamesIn, surnamesOf, urls, fromDataCite, fromCrossref };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassCite = api;
})(typeof self !== 'undefined' ? self : this);
