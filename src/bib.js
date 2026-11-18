/*
 * A small BibTeX reader: turns the entries a document cites into a
 * thebibliography environment that TeXglass can render, in the spirit of the
 * amsplain style (or alpha labels, or citation order, following
 * \bibliographystyle or biblatex's style option). It also reads the .bbl that
 * biber writes for biblatex, which is not a thebibliography.
 *
 * Shared by the web viewer (window.TeXglassBib) and the VS Code extension
 * (copied to vscode/shared/bib.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassBib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const MONTHS = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
  jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December',
};

/** Parse BibTeX text into { key: { type, fields: { name: value } } }. */
function parseBib(text, strings) {
  strings = strings || Object.assign({}, MONTHS);
  const entries = {};
  let i = 0;
  while ((i = text.indexOf('@', i)) >= 0) {
    const head = /^@\s*([a-zA-Z]+)\s*([{(])/.exec(text.slice(i, i + 64));
    if (!head) {
      i++;
      continue;
    }
    const type = head[1].toLowerCase();
    const closer = head[2] === '{' ? '}' : ')';
    const start = i + head[0].length;
    // Find the end of the entry: the closer at brace depth 0.
    let depth = 0;
    let k = start;
    for (; k < text.length; k++) {
      const c = text[k];
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0 && closer === '}') break;
        depth--;
      } else if (c === ')' && closer === ')' && depth === 0) break;
    }
    const body = text.slice(start, k);
    i = k + 1;
    if (type === 'comment' || type === 'preamble') continue;
    if (type === 'string') {
      Object.assign(strings, parseFields(body, strings));
      continue;
    }
    const comma = body.indexOf(',');
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!key) continue;
    entries[key] = { type, fields: comma < 0 ? {} : parseFields(body.slice(comma + 1), strings) };
  }
  return entries;
}

/** Parse `name = value, …`, where a value joins {…}, "…", numbers and @string names with #. */
function parseFields(s, strings) {
  const fields = {};
  let i = 0;
  const n = s.length;
  const ws = () => { while (i < n && /[\s,]/.test(s[i])) i++; };
  while (i < n) {
    ws();
    const nm = /^[^\s=,{}"#]+/.exec(s.slice(i));
    if (!nm) break;
    const name = nm[0].toLowerCase();
    i += nm[0].length;
    while (i < n && /\s/.test(s[i])) i++;
    if (s[i] !== '=') {
      i++;
      continue;
    }
    i++;
    let value = '';
    for (;;) {
      while (i < n && /\s/.test(s[i])) i++;
      if (s[i] === '{' || s[i] === '"') {
        const close = s[i] === '{' ? '}' : '"';
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          const c = s[j];
          if (c === '\\') { j++; continue; }
          if (c === '{') depth++;
          else if (c === '}' && depth > 0) depth--;
          else if (c === close && depth === 0) break;
        }
        value += s.slice(i + 1, j);
        i = j + 1;
      } else {
        const word = /^[^\s,#}]+/.exec(s.slice(i));
        if (!word) break;
        const w = word[0];
        value += /^\d+$/.test(w) ? w : strings[w.toLowerCase()] !== undefined ? strings[w.toLowerCase()] : w;
        i += w.length;
      }
      while (i < n && /\s/.test(s[i])) i++;
      if (s[i] === '#') {
        i++;
        continue;
      }
      break;
    }
    fields[name] = value.replace(/\s+/g, ' ').trim();
  }
  return fields;
}

/** Split at a separator that is not inside braces. */
function splitTop(s, re) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m && m.index === i) {
        parts.push(s.slice(last, i));
        last = i + m[0].length;
        i = last - 1;
      }
    }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** "Last, First" or "First Last" → { first, last }. */
function parseName(name) {
  const parts = splitTop(name, /,/y);
  if (parts.length >= 2) {
    const last = parts.length === 3 ? `${parts[0]} ${parts[1]}` : parts[0];
    return { first: parts[parts.length - 1], last };
  }
  const words = splitTop(name, /\s+/y);
  if (words.length === 1) return { first: '', last: words[0] };
  // "von" particles start the last name.
  let k = words.findIndex((w, j) => j > 0 && j < words.length - 1 && /^[a-z]/.test(w));
  if (k < 0) k = words.length - 1;
  return { first: words.slice(0, k).join(' '), last: words.slice(k).join(' ') };
}

function names(list) {
  return list ? splitTop(list, /\s+and\s+/iy).map(parseName) : [];
}

function joinNames(ns) {
  const full = ns.map((p) => (p.first ? `${p.first} ${p.last}` : p.last));
  if (full.length <= 2) return full.join(' and ');
  return `${full.slice(0, -1).join(', ')}, and ${full[full.length - 1]}`;
}

const plain = (s) => String(s || '').replace(/\\[a-zA-Z]+\s*|[{}\\'"`^~]/g, '');

/** The text of one \bibitem. */
function formatEntry(e) {
  const f = e.fields;
  const authors = names(f.author);
  const editors = names(f.editor);
  const parts = [];
  if (authors.length) parts.push(joinNames(authors));
  else if (editors.length) parts.push(`${joinNames(editors)} (ed${editors.length > 1 ? 's' : ''}.)`);
  if (f.title) parts.push(`\\emph{${f.title}}`);
  const year = f.year ? (f.month ? `${MONTHS[f.month.toLowerCase().slice(0, 3)] || f.month} ${f.year}` : f.year) : '';
  const pages = f.pages ? (/[-–,]/.test(f.pages) ? `pp.~${f.pages}` : `p.~${f.pages}`) : '';
  switch (e.type) {
    case 'article': {
      let j = f.journal || f.journaltitle || '';
      if (f.volume) j += ` \\textbf{${f.volume}}`;
      if (year) j += ` (${year})`;
      if (f.number) j += `, no.~${f.number}`;
      if (j) parts.push(j.trim());
      if (f.pages) parts.push(f.pages);
      break;
    }
    case 'book':
    case 'booklet':
      if (f.edition) parts.push(`${f.edition} ed.`);
      if (f.series) parts.push(f.volume ? `${f.series}, vol.~${f.volume}` : f.series);
      if (f.publisher) parts.push(f.publisher);
      if (f.address) parts.push(f.address);
      if (year) parts.push(year);
      break;
    case 'inproceedings':
    case 'incollection':
    case 'inbook':
    case 'conference':
      if (f.booktitle) parts.push(`${f.booktitle}${editors.length && authors.length ? ` (${joinNames(editors)}, ed${editors.length > 1 ? 's' : ''}.)` : ''}`);
      if (f.series) parts.push(f.volume ? `${f.series}, vol.~${f.volume}` : f.series);
      if (f.publisher) parts.push(f.publisher);
      if (year) parts.push(year);
      if (pages) parts.push(pages);
      break;
    case 'phdthesis':
    case 'mastersthesis':
    case 'thesis':
      parts.push(e.type === 'mastersthesis' ? "Master's thesis" : 'Ph.D. thesis');
      if (f.school || f.institution) parts.push(f.school || f.institution);
      if (year) parts.push(year);
      break;
    default:
      if (f.howpublished) parts.push(f.howpublished);
      if (f.institution) parts.push(f.institution);
      if (f.publisher) parts.push(f.publisher);
      if (year) parts.push(year);
  }
  let text = parts.join(', ') + '.';
  if (f.note) text += ` ${f.note}${/[.!?]$/.test(f.note) ? '' : '.'}`;
  const eprint = f.eprint && (!f.archiveprefix || /arxiv/i.test(f.archiveprefix)) ? f.eprint : '';
  if (eprint) text += ` \\href{https://arxiv.org/abs/${eprint}}{arXiv:${eprint}}.`;
  else if (f.doi) text += ` \\href{https://doi.org/${f.doi}}{doi:${f.doi}}.`;
  else if (f.url) text += ` \\url{${f.url}}.`;
  return text;
}

/** An alpha-style label such as Lur09 or BHS19. */
function alphaLabel(e) {
  const ns = names(e.fields.author).length ? names(e.fields.author) : names(e.fields.editor);
  const year = (e.fields.year || '').slice(-2);
  const last = (p) => plain(p.last).replace(/^(von|van|de|der|di|da|le|la)\s+/i, '');
  if (!ns.length) return plain(e.fields.key || e.fields.title || '???').slice(0, 3) + year;
  if (ns.length === 1) return last(ns[0]).slice(0, 3) + year;
  const initials = ns.slice(0, 4).map((p) => last(p)[0] || '').join('');
  return initials + (ns.length > 4 ? '+' : '') + year;
}

/**
 * Build `\begin{thebibliography}…` for the cited keys (in citation order;
 * '*' means every entry). `style` is the \bibliographystyle name, or biblatex's
 * style option. An entry's own `label` (from a biblatex .bbl) wins over a
 * computed one; opts.keepOrder keeps the order of `entries` (a .bbl is sorted
 * already) instead of sorting.
 * Returns { text, missing: [keys not found] }.
 */
function makeBibliography(entries, cited, style, opts) {
  opts = opts || {};
  const all = cited.includes('*');
  let keys = [];
  const seen = new Set();
  for (const k of all ? cited.filter((c) => c !== '*').concat(Object.keys(entries)) : cited) {
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  const missing = keys.filter((k) => !entries[k]);
  keys = keys.filter((k) => entries[k]);
  // biblatex .bib files often give `date = {2021-03}` instead of `year`.
  const use = {};
  for (const k of keys) {
    const e = entries[k];
    const date = /^\s*(\d{4})/.exec(e.fields.date || '');
    use[k] = !e.fields.year && date ? Object.assign({}, e, { fields: Object.assign({}, e.fields, { year: date[1] }) }) : e;
  }
  const s = (style || '').toLowerCase();
  if (opts.keepOrder) {
    const order = Object.keys(entries);
    keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  } else if (!/unsrt|ieee|acm|siam|phys|apsrev|nature|sorting=none/.test(s)) {
    const sortKey = (k) => {
      const e = use[k];
      const ns = names(e.fields.author).length ? names(e.fields.author) : names(e.fields.editor);
      return [ns.map((p) => plain(p.last) + ' ' + plain(p.first)).join(' ').toLowerCase(), e.fields.year || '', plain(e.fields.title).toLowerCase()].join('\u0001');
    };
    keys.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  }
  const alpha = /alpha/.test(s);
  const used = {};
  const items = keys.map((k) => {
    let label = use[k].label || '';
    if (!label && alpha) {
      label = alphaLabel(use[k]);
      used[label] = (used[label] || 0) + 1;
    }
    return { k, label };
  });
  if (alpha) {
    // Two entries with the same label become Lur09a, Lur09b.
    const count = {};
    for (const it of items) {
      if (used[it.label] > 1) {
        count[it.label] = (count[it.label] || 0) + 1;
        it.label += String.fromCharCode(96 + count[it.label]);
      }
    }
  }
  const body = items.map((it) => `\\bibitem${it.label ? `[${it.label}]` : ''}{${it.k}} ${formatEntry(use[it.k])}`).join('\n\n');
  return { text: `\\begin{thebibliography}{${items.length}}\n${body}\n\\end{thebibliography}`, missing };
}

// --- biber's .bbl -------------------------------------------------------------
//
// biblatex does not write a thebibliography: biber leaves a .bbl of
// \entry{key}{type}{…} … \endentry blocks holding the parsed fields, names and
// the alphabetic label, already sorted. arXiv keeps it next to the source.

/** Whether a .bbl was written by biber for biblatex. */
function isBiblatexBbl(text) {
  return /\\entry\s*\{[^}]*\}\s*\{[^}]*\}/.test(text || '') && /\\endentry\b/.test(text || '');
}

/** The {…} group at or after s[i] (skipping spaces and %-line ends), as { content, end }, or null. */
function bblGroup(s, i) {
  while (i < s.length && /[\s%]/.test(s[i])) {
    if (s[i] === '%') while (i < s.length && s[i] !== '\n') i++;
    i++;
  }
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '{') depth++;
    else if (s[k] === '}' && --depth === 0) return { content: s.slice(i + 1, k), end: k + 1 };
  }
  return null;
}

/** Every top-level {…} group in s. */
function bblGroups(s) {
  const out = [];
  let i = 0;
  for (;;) {
    while (i < s.length && s[i] !== '{') i++;
    const g = bblGroup(s, i);
    if (!g) return out;
    out.push(g.content);
    i = g.end;
  }
}

const unbrace = (v) => { v = String(v || '').trim(); return /^\{[\s\S]*\}$/.test(v) && bblGroup(v, 0).end === v.length ? v.slice(1, -1) : v; };

/** biblatex's name and range macros, as plain TeX. */
const bblText = (v) => String(v || '')
  .replace(/\\bibrangedash\b\s*/g, '--')
  .replace(/\\bibinithyphendelim\b\s*/g, '-')
  .replace(/\\bibinitperiod\b\s*/g, '.')
  .replace(/\\bibnamedelim[a-d]\b\s*|\\bibnamedelimi\b\s*|\\bibinitdelim\b\s*/g, ' ')
  .replace(/%\n\s*/g, '')
  .trim();

/** One person of a \name list, as "Family, Given" (or "Family, Jr, Given"). */
function bblPerson(p) {
  const gs = bblGroups(p.replace(/(?<!\\)%[^\n]*\n\s*/g, ''));
  let family = '';
  let given = '';
  let prefix = '';
  let suffix = '';
  const keyed = gs.find((g) => /(^|,)\s*family\s*=/.test(g));
  if (keyed) {
    // biblatex 3.3+: {opts}{family={…}, familyi={…}, given={…}, …}
    const f = {};
    let depth = 0;
    let last = 0;
    const parts = [];
    for (let k = 0; k <= keyed.length; k++) {
      const c = keyed[k];
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if ((c === ',' || k === keyed.length) && depth === 0) {
        parts.push(keyed.slice(last, k));
        last = k + 1;
      }
    }
    if (last <= keyed.length) parts.push(keyed.slice(last));
    for (const part of parts) {
      const m = /^\s*([a-z]+)\s*=\s*([\s\S]*)$/.exec(part);
      if (m) f[m[1]] = unbrace(m[2]);
    }
    ({ family = '', given = '', prefix = '', suffix = '' } = f);
  } else if (gs.length >= 4) {
    // Older biblatex: {opts}{family}{familyi}{given}{giveni}{prefix}{prefixi}{suffix}{suffixi}
    [, family, , given, , prefix = '', , suffix = ''] = gs;
  } else return '';
  family = bblText([prefix, family].filter(Boolean).join(' '));
  given = bblText(given);
  suffix = bblText(suffix);
  const brace = (v) => (/,|\sand\s/.test(v) ? `{${v}}` : v);
  return [brace(family), suffix, given].filter(Boolean).map(brace).join(', ');
}

/**
 * Parse a biber .bbl into { key: { type, fields, label } } in its own (sorted)
 * order, with BibTeX field names so formatEntry can print it.
 */
function parseBbl(text) {
  const entries = {};
  const re = /\\entry\s*\{([^}]*)\}\s*\{([^}]*)\}([\s\S]*?)\\endentry\b/g;
  const RENAME = { journaltitle: 'journal', location: 'address', eprinttype: 'archiveprefix', institution: 'institution' };
  for (const m of String(text || '').matchAll(re)) {
    const key = m[1].trim();
    if (entries[key]) continue; // the same entry again, in another sort list
    const body = m[3];
    const fields = {};
    const set = (name, value) => { name = RENAME[name] || name; if (value && !(name in fields)) fields[name] = value; };
    let labelalpha = '';
    let extraalpha = '';
    const cmd = /\\(name|list|field|verb)\s*\{([^}]*)\}/g;
    let c;
    while ((c = cmd.exec(body))) {
      const kind = c[1];
      const name = c[2].toLowerCase();
      let i = c.index + c[0].length;
      if (kind === 'verb') {
        // \verb{doi}\n \verb 10.1000/xyz\n \endverb
        const end = body.indexOf('\\endverb', i);
        if (end < 0) break;
        const value = body.slice(i, end).split('\n').map((l) => l.replace(/^\s*\\verb\s?/, '')).join('').trim();
        set(name, value);
        cmd.lastIndex = end + 8;
        continue;
      }
      const args = [];
      const want = kind === 'field' ? 1 : kind === 'list' ? 2 : 3; // \list{…}{count}{items}, \name{…}{count}{opts}{people}
      for (let n = 0; n < want; n++) {
        const g = bblGroup(body, i);
        if (!g) break;
        args.push(g.content);
        i = g.end;
      }
      cmd.lastIndex = i;
      if (kind === 'field') {
        const v = bblText(args[0]);
        if (name === 'labelalpha') labelalpha = v;
        else if (name === 'extraalpha') extraalpha = v;
        else set(name, v);
      } else if (args.length >= 2) {
        const items = bblGroups(args[args.length - 1]);
        set(name, (kind === 'name' ? items.map(bblPerson) : items.map(bblText)).filter(Boolean).join(' and '));
      }
    }
    if (fields.publisher) fields.publisher = fields.publisher.replace(/ and /g, ', ');
    if (fields.address) fields.address = fields.address.replace(/ and /g, ', ');
    const extra = parseInt(extraalpha, 10);
    const label = labelalpha ? labelalpha + (extra > 0 ? String.fromCharCode(96 + extra) : '') : '';
    entries[key] = { type: m[2].trim().toLowerCase(), fields, label };
  }
  return entries;
}

// --- amsrefs -------------------------------------------------------------------
//
// amsrefs puts the bibliography in the .tex itself:
//   \begin{bibdiv}\begin{biblist}
//   \bib{key}{article}{ author={Bass, Richard~F.}, author={Chen, Z.}, title={…}, date={2003}, … }
//   \end{biblist}\end{bibdiv}
// Fields repeat (one author= per author) and some hold a nested record
// (book={title=…, publisher=…}, conference={…}, series={…}).

/** `key={value}, …` into [[key, value]], keeping repeats and order. */
function amsPairs(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;
    const m = /^([a-zA-Z*]+)\s*=\s*/.exec(s.slice(i));
    if (!m) {
      // Not a field: skip to the next top-level comma.
      let depth = 0;
      while (i < n && !(s[i] === ',' && depth === 0)) {
        if (s[i] === '\\') i++;
        else if (s[i] === '{') depth++;
        else if (s[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i += m[0].length;
    let value;
    const g = s[i] === '{' ? bblGroup(s, i) : null;
    if (g) {
      value = g.content;
      i = g.end;
    } else {
      const end = s.indexOf(',', i);
      value = s.slice(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
    }
    out.push([m[1].toLowerCase(), value.replace(/\s+/g, ' ').trim()]);
  }
  return out;
}

const amsText = (v) => String(v || '').replace(/\\ndash\b\s*/g, '--').replace(/\\mdash\b\s*/g, '---');
const isRecord = (v) => /^\s*[a-zA-Z]+\s*=/.test(v || '');

/** The entries of an amsrefs biblist, as { key: { type, fields } } in their order. */
function parseAmsrefs(text) {
  const entries = {};
  const re = /\\bib\*?\s*\{([^}]*)\}\s*\{([^}]*)\}\s*/g;
  let m;
  while ((m = re.exec(text))) {
    const g = bblGroup(text, m.index + m[0].length);
    if (!g) continue;
    re.lastIndex = g.end;
    const key = m[1].trim();
    const type = m[2].trim().toLowerCase();
    const fields = {};
    const people = { author: [], editor: [], translator: [] };
    const take = (pairs, prefix) => {
      for (const [k, raw] of pairs) {
        const v = amsText(raw);
        if (k in people && !prefix) people[k].push(v);
        else if ((k === 'book' || k === 'conference' || k === 'series' || k === 'partial') && isRecord(raw)) {
          const inner = amsPairs(raw);
          for (const [ik, iv] of inner) {
            const val = amsText(iv);
            if (ik === 'title') {
              if (k === 'series') fields.series = fields.series || val;
              else fields.booktitle = fields.booktitle || val;
            } else if (ik === 'editor') people.editor.push(val);
            else if (!(ik in fields) && !(ik in people)) fields[ik] = val;
          }
        } else if (k === 'review' || k === 'xref' || k === 'status' || k === 'language') continue;
        else if (k === 'date') fields.year = fields.year || (/\d{4}/.exec(v) || [v])[0];
        else if (k === 'organization' || k === 'institution') fields.school = fields.school || v;
        else if (k === 'place') fields.address = fields.address || v;
        else if (k === 'eprint') fields.eprint = v.replace(/^arxiv:\s*/i, '');
        else if (!(k in fields)) fields[k] = v;
      }
    };
    take(amsPairs(g.content), '');
    for (const k of Object.keys(people)) if (people[k].length) fields[k] = people[k].join(' and ');
    if (fields.eprint && !/^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+(\.[A-Z]{2})?\/\d{7}/i.test(fields.eprint)) {
      fields.note = fields.note ? `${fields.note}, ${fields.eprint}` : fields.eprint;
      delete fields.eprint;
    }
    const TYPES = { collection: 'book', report: 'techreport', partial: 'misc', innerbook: 'incollection' };
    entries[key] = { type: TYPES[type] || (type === 'article' && fields.booktitle ? 'inproceedings' : type), fields };
  }
  return entries;
}

/**
 * An amsrefs biblist as the body of a thebibliography ("{n}\n\bibitem…"),
 * every entry in its own order; alpha labels when amsrefs has the alphabetic option.
 */
function amsrefsBibliography(biblist, alphabetic) {
  const entries = parseAmsrefs(biblist);
  const text = makeBibliography(entries, ['*'], alphabetic ? 'alpha' : 'plain', { keepOrder: true }).text;
  return text.replace(/^\\begin\{thebibliography\}/, '').replace(/\\end\{thebibliography\}$/, '');
}

/** The style a document asks for: \bibliographystyle{…}, or biblatex's style/bibstyle and sorting options. */
function styleOf(text) {
  const t = String(text || '');
  const bst = /\\bibliographystyle\s*\{([^}]*)\}/.exec(t);
  if (bst) return bst[1];
  const pkg = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{biblatex\}/.exec(t);
  if (!pkg) return '';
  const opt = (n) => (new RegExp(`(?:^|,)\\s*${n}\\s*=\\s*([^,\\s]+)`).exec(pkg[1] || '') || [])[1];
  const style = opt('bibstyle') || opt('style') || 'numeric';
  return opt('sorting') === 'none' ? `${style},sorting=none` : style;
}

/** The keys a document cites, in order; '*' for \nocite{*}. */
function citedKeys(text) {
  const cited = [];
  const noComments = String(text || '').replace(/(?<!\\)%.*$/gm, '');
  const re = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;
  for (const m of noComments.matchAll(re)) for (const k of m[1].split(',')) if (k.trim()) cited.push(k.trim());
  return cited;
}

/** The .bib names a document asks for, from \bibliography{a,b} and \addbibresource{c.bib}. */
function bibResources(text) {
  const t = String(text || '').replace(/(?<!\\)%.*$/gm, '');
  const out = [];
  for (const m of t.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) out.push(...m[1].split(','));
  for (const m of t.matchAll(/\\(?:addbibresource|addglobalbib|addsectionbib)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) out.push(m[1]);
  return out.map((n) => n.trim()).filter(Boolean);
}

return { parseBib, parseBbl, isBiblatexBbl, parseAmsrefs, amsrefsBibliography, makeBibliography, formatEntry, parseName, styleOf, citedKeys, bibResources };
});
