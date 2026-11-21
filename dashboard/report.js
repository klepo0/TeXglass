'use strict';
/*
 * Turns what the render dashboard saw in each paper into results: a status per
 * paper, what changed since the last run, and the macros, environments and
 * packages behind the most problems. Pure functions, so they can be tested.
 */

const SLOW_MS = 20000;
const RANK = { ok: 0, issues: 1, broken: 2 };

/** The command or message behind a KaTeX error, e.g. '\\foo' or 'Expected }'. */
function mathErrorKey(message) {
  const m = String(message || '').replace(/^(ParseError:\s*)?KaTeX parse error:\s*/, '');
  const cs = /Undefined control sequence:\s*(\\[A-Za-z@]+|\\.)/.exec(m) || /Unknown (?:column alignment|size|accent|function|environment)[^:]*:\s*'?([^'\s]+)/.exec(m);
  if (cs) return cs[1];
  const env = /No such environment:\s*([A-Za-z*@]+)/.exec(m);
  if (env) return `{${env[1]}}`;
  return m.replace(/\s+at (position \d+|end of input)[\s\S]*$/, '').replace(/(\s)'([^']{13,})'/g, "$1'…'").replace(/\d+/g, 'N').slice(0, 80);
}

/**
 * One paper's results from what the page showed.
 * raw: { id, kind, error, timeout, ms, mathErrors: [title], placeholders: [text],
 *        tikzPartial, warnings: [text], brokenImages, blocks, packages: [name] }
 */
function classify(raw) {
  const p = { id: raw.id, ms: raw.ms == null ? null : Math.round(raw.ms), packages: raw.packages || [] };
  if (raw.kind && raw.kind !== 'tex') return Object.assign(p, { status: 'nosource', why: raw.kind === 'pdf' ? 'PDF only' : 'not on arXiv', problems: {} });
  const problems = {};
  const add = (kind, key) => {
    problems[kind] = problems[kind] || {};
    problems[kind][key] = (problems[kind][key] || 0) + 1;
  };
  for (const t of raw.mathErrors || []) add('math', mathErrorKey(t));
  for (const t of raw.placeholders || []) {
    const d = /^\[([^\]]+?) diagram\]$/.exec(t.trim());
    if (d) add('diagram', d[1]);
    else add('figure', t.trim().replace(/^\[image:\s*/, '').replace(/\]$/, ''));
  }
  for (let i = 0; i < (raw.brokenImages || 0); i++) add('figure', '(image did not load)');
  for (let i = 0; i < (raw.tikzPartial || 0); i++) add('tikz', 'TikZ not fully drawn');
  for (const w of raw.warnings || []) {
    const u = /^Unknown command (\\\S+?)\.?$/.exec(w);
    if (u) add('command', u[1]);
  }
  const count = (k) => Object.values(problems[k] || {}).reduce((a, b) => a + b, 0);
  p.counts = { math: count('math'), figure: count('figure'), diagram: count('diagram'), tikz: count('tikz'), command: count('command') };
  p.problems = problems;
  if (raw.timeout) return Object.assign(p, { status: 'broken', timeout: true, why: 'Did not finish rendering (hang or very slow)' });
  if (raw.error) return Object.assign(p, { status: 'broken', why: raw.error });
  if (!raw.blocks) return Object.assign(p, { status: 'broken', why: 'Nothing was rendered' });
  p.slow = p.ms != null && p.ms > SLOW_MS;
  const n = p.counts.math + p.counts.figure + p.counts.diagram + p.counts.tikz;
  p.status = n ? 'issues' : 'ok';
  return p;
}

/** A number for sorting papers worst first. */
function badness(p) {
  if (p.status === 'broken') return 1e6;
  if (p.status !== 'issues' && !p.slow) return 0;
  const c = p.counts || {};
  return c.math * 3 + c.figure * 5 + c.diagram * 5 + c.tikz * 2 + (p.slow ? 10 : 0);
}

/** What kind of figure did not show: by file type, since that says what to support. */
function figureKind(name) {
  if (name.startsWith('(')) return name;
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1];
  return ext ? `.${ext.toLowerCase()} figures` : 'figures named without extension';
}

/** Which keys turn up in how many papers, most papers first. */
function tally(papers, kind, keyOf) {
  const byKey = new Map();
  for (const p of papers) {
    const keys = {};
    for (const [k, n] of Object.entries((p.problems || {})[kind] || {})) {
      const key = keyOf ? keyOf(k) : k;
      keys[key] = (keys[key] || 0) + n;
    }
    for (const [key, n] of Object.entries(keys)) {
      const e = byKey.get(key) || { key, papers: [], count: 0 };
      e.papers.push(p.id);
      e.count += n;
      byKey.set(key, e);
    }
  }
  return [...byKey.values()].sort((a, b) => b.papers.length - a.papers.length || b.count - a.count).slice(0, 25);
}

/** Packages used by at least 3 papers, by how many papers with problems use them. */
function packageTally(papers) {
  const by = new Map();
  for (const p of papers) {
    if (p.status === 'nosource') continue;
    for (const pkg of new Set(p.packages || [])) {
      const e = by.get(pkg) || { key: pkg, used: 0, papers: [] };
      e.used++;
      if (p.status !== 'ok') e.papers.push(p.id);
      by.set(pkg, e);
    }
  }
  return [...by.values()].filter((e) => e.used >= 3 && e.papers.length)
    .map((e) => Object.assign(e, { share: e.papers.length / e.used }))
    .sort((a, b) => b.papers.length - a.papers.length || b.share - a.share).slice(0, 25);
}

const problemTotal = (p) => Object.values(p.counts || {}).reduce((a, b) => a + b, 0) - ((p.counts || {}).command || 0);

/** What is different from the last run, worst news first. */
function changes(papers, prev) {
  if (!prev) return [];
  const before = new Map((prev.papers || []).map((p) => [p.id, p]));
  const out = [];
  for (const p of papers) {
    const q = before.get(p.id);
    if (!q) { out.push({ id: p.id, change: 'new', to: p.status }); continue; }
    if (p.status === 'nosource' || q.status === 'nosource') continue;
    const dr = (RANK[p.status] || 0) - (RANK[q.status] || 0);
    const dn = problemTotal(p) - problemTotal(q);
    const fresh = [];
    for (const [kind, keys] of Object.entries(p.problems || {})) {
      if (kind === 'command') continue;
      for (const k of Object.keys(keys)) if (!((q.problems || {})[kind] || {})[k]) fresh.push(k);
    }
    const slower = p.ms != null && q.ms != null && p.ms > q.ms * 1.5 && p.ms - q.ms > 3000;
    if (dr > 0 || (dr === 0 && dn > 0) || slower) out.push({ id: p.id, change: 'worse', from: q.status, to: p.status, problems: [problemTotal(q), problemTotal(p)], ms: [q.ms, p.ms], fresh: fresh.slice(0, 8) });
    else if (dr < 0 || dn < 0) out.push({ id: p.id, change: 'better', from: q.status, to: p.status, problems: [problemTotal(q), problemTotal(p)], ms: [q.ms, p.ms] });
  }
  const order = { worse: 0, new: 1, better: 2 };
  return out.sort((a, b) => order[a.change] - order[b.change]);
}

/** The year a paper was submitted: from the corpus, or else from its arXiv id. */
function yearOf(p) {
  if (p.year) return p.year;
  const id = String(p.id || '');
  const m = /^(\d{2})\d{2}\./.exec(id) || /\/(\d{2})\d{2}/.exec(id);
  if (!m) return null;
  const yy = Number(m[1]);
  return yy > 90 ? 1900 + yy : 2000 + yy;
}

const YEARS = ['before 2008', '2008–2014', '2015–2019', '2020–2023', '2024 on', 'unknown'];

/** The decade-ish bucket for a year, so small years do not each get a row. */
function yearBucket(y) {
  if (!y) return 'unknown';
  if (y < 2008) return 'before 2008';
  if (y < 2015) return '2008–2014';
  if (y < 2020) return '2015–2019';
  if (y < 2024) return '2020–2023';
  return '2024 on';
}

/** Papers per group (field, years), with how many are OK, have issues or are broken. */
function breakdown(papers, groupOf) {
  const by = new Map();
  for (const p of papers) {
    if (p.status === 'nosource') continue;
    const g = groupOf(p) || 'other';
    const e = by.get(g) || { key: g, papers: 0, ok: 0, issues: 0, broken: 0 };
    e.papers++;
    e[p.status]++;
    by.set(g, e);
  }
  return [...by.values()].map((e) => Object.assign(e, { clean: e.ok / e.papers }));
}

/** How many papers have each kind of failure. */
function byType(papers) {
  const t = { math: 0, figure: 0, tikz: 0, diagram: 0, timeout: 0, error: 0, slow: 0 };
  for (const p of papers) {
    const c = p.counts || {};
    for (const k of ['math', 'figure', 'tikz', 'diagram']) if (c[k]) t[k]++;
    if (p.timeout) t.timeout++;
    else if (p.status === 'broken') t.error++;
    if (p.slow) t.slow++;
  }
  return t;
}

/**
 * The run's results: { date, commit, papers, summary, changes, top, history }.
 * corpus: [{ id, field, title, note }]; prev: the last run's results, if any.
 */
function build(raws, corpus, prev, info) {
  info = info || {};
  const meta = new Map(corpus.map((c) => [c.id, c]));
  const before = new Map(((prev && prev.papers) || []).map((p) => [p.id, p]));
  const date = info.date || new Date().toISOString();
  const papers = raws.map((r) => {
    const p = classify(r);
    const c = meta.get(r.id) || {};
    Object.assign(p, { field: c.field, title: c.title || '', note: c.note || '' });
    const q = before.get(p.id);
    p.since = q && q.status === p.status && q.since ? q.since : date;
    p.badness = badness(p);
    return p;
  });
  const summary = { papers: papers.length, ok: 0, issues: 0, broken: 0, nosource: 0, slow: 0 };
  for (const p of papers) { summary[p.status]++; if (p.slow) summary.slow++; }
  const rendered = papers.filter((p) => p.ms != null && p.status !== 'broken').map((p) => p.ms).sort((a, b) => a - b);
  summary.medianMs = rendered.length ? rendered[Math.floor(rendered.length / 2)] : null;
  summary.p90Ms = rendered.length ? rendered[Math.min(rendered.length - 1, Math.floor(rendered.length * 0.9))] : null;
  const judged = summary.papers - summary.nosource;
  summary.clean = judged ? summary.ok / judged : null;
  summary.byType = byType(papers);
  const top = {
    math: tally(papers, 'math'),
    command: tally(papers, 'command'),
    diagram: tally(papers, 'diagram'),
    figure: tally(papers, 'figure', figureKind),
    packages: packageTally(papers),
  };
  for (const p of papers) p.year = yearOf(Object.assign({}, meta.get(p.id), p));
  const groups = {
    field: breakdown(papers, (p) => p.field).sort((a, b) => b.papers - a.papers),
    year: breakdown(papers, (p) => yearBucket(p.year)).sort((a, b) => YEARS.indexOf(a.key) - YEARS.indexOf(b.key)),
  };
  const slowest = papers.filter((p) => p.ms != null).sort((a, b) => b.ms - a.ms).slice(0, 10)
    .map((p) => ({ id: p.id, ms: p.ms, status: p.status, timeout: !!p.timeout }));
  const changed = changes(papers, prev);
  const entry = { date, commit: info.commit || '', summary, worse: changed.filter((c) => c.change === 'worse').length, better: changed.filter((c) => c.change === 'better').length };
  const history = ((prev && prev.history) || []).concat([entry]).slice(-120);
  return { date, commit: info.commit || '', papers, summary, changes: changed, top, groups, slowest, history };
}

module.exports = { classify, mathErrorKey, figureKind, yearOf, yearBucket, breakdown, byType, badness, tally, packageTally, changes, build, SLOW_MS };
