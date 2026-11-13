/*
 * A small BibTeX reader: turns the entries a document cites into a
 * thebibliography environment that TeXglass can render, in the spirit of the
 * amsplain style (or alpha labels, or citation order, following
 * \bibliographystyle).
 */
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
 * '*' means every entry). `style` is the \bibliographystyle name.
 * Returns { text, missing: [keys not found] }.
 */
function makeBibliography(entries, cited, style) {
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
  const s = (style || '').toLowerCase();
  if (!/unsrt|ieee|acm|siam|phys|apsrev|nature/.test(s)) {
    const sortKey = (k) => {
      const e = entries[k];
      const ns = names(e.fields.author).length ? names(e.fields.author) : names(e.fields.editor);
      return [ns.map((p) => plain(p.last) + ' ' + plain(p.first)).join(' ').toLowerCase(), e.fields.year || '', plain(e.fields.title).toLowerCase()].join('\u0001');
    };
    keys.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  }
  const alpha = /alpha/.test(s);
  const used = {};
  const items = keys.map((k) => {
    let label = '';
    if (alpha) {
      label = alphaLabel(entries[k]);
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
  const body = items.map((it) => `\\bibitem${it.label ? `[${it.label}]` : ''}{${it.k}} ${formatEntry(entries[it.k])}`).join('\n\n');
  return { text: `\\begin{thebibliography}{${items.length}}\n${body}\n\\end{thebibliography}`, missing };
}

module.exports = { parseBib, makeBibliography, formatEntry, parseName };
