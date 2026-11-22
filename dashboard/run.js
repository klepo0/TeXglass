#!/usr/bin/env node
'use strict';
/*
 * The render dashboard's nightly run: opens every paper in dashboard/papers.json
 * in the web viewer (index.html?arxiv=<id>, the same import path people use) in
 * headless Chromium, and records what went wrong: maths KaTeX could not render,
 * figures that did not show, diagrams and TikZ that were not drawn, commands the
 * viewer does not know, papers that never finished, and how long each took.
 *
 *   node dashboard/run.js [--out dir] [--prev results.json] [--only id,id] [--limit n] [--timeout s] [--shots dir]
 *
 * Writes <out>/results.json (see report.js). Sources come from the cache in
 * sources.js; only papers not in it are downloaded, politely.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { fetchSource } = require('./sources.js');
const report = require('./report.js');
const Arxiv = require('../src/arxiv.js');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function args() {
  const a = { out: path.join(__dirname, 'out'), prev: null, only: null, limit: 0, timeout: 120, shots: null };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i].replace(/^--/, '');
    if (k === 'only') a.only = v[++i].split(',');
    else if (k === 'limit' || k === 'timeout') a[k] = Number(v[++i]);
    else a[k] = v[++i];
  }
  return a;
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The packages a paper loads, read from its flattened source. */
async function packagesOf(id, src) {
  try {
    const bytes = fs.readFileSync(src.file);
    const paper = await Arxiv.importPaper(id, { fetch: async () => new Response(bytes, { headers: { 'content-type': src.type || 'application/gzip' } }) });
    const out = new Set();
    for (const m of paper.source.replace(/(^|[^\\])%.*$/gm, '$1').matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      for (const name of m[1].split(',')) if (name.trim()) out.add(name.trim());
    }
    return [...out].sort();
  } catch (e) {
    return [];
  }
}

/** Serve the viewer from this checkout and the paper from the cache; nothing else leaves the machine. */
async function route(context, id, src) {
  await context.route('**/*', (r) => {
    const url = new URL(r.request().url());
    if (url.host === 'texglass.test') {
      const p = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !file.startsWith(ROOT) || !fs.existsSync(file)) return r.fulfill({ status: 404, body: '' });
      return r.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    }
    if (url.host === 'arxiv.org' && url.pathname === `/src/${id}`) {
      return r.fulfill({ body: fs.readFileSync(src.file), headers: { 'access-control-allow-origin': '*', 'content-type': src.type || 'application/gzip' } });
    }
    if (url.protocol === 'blob:' || url.protocol === 'data:') return r.continue();
    return r.abort();
  });
}

// Counts DOM changes, so the run can wait until the page has settled.
const SETTLE = () => {
  window.__changed = performance.now();
  new MutationObserver(() => { window.__changed = performance.now(); })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
};

async function renderOne(browser, paper, src, timeoutMs, shots) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addInitScript(SETTLE);
  await route(context, paper.id, src);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const started = Date.now();
  const raw = { id: paper.id, kind: 'tex' };
  try {
    await page.goto(`http://texglass.test/index.html?arxiv=${encodeURIComponent(paper.id)}`, { timeout: 30000 });
    const done = await withTimeout(page.waitForFunction(() => {
      const msg = document.getElementById('arxiv-message');
      if (msg && msg.classList.contains('warn') && msg.textContent) return true;
      const named = /^arXiv-/.test(document.getElementById('file-name').textContent);
      const rendered = document.querySelector('#preview .src-block, #preview .render-error, #preview .empty-doc');
      const drawing = document.documentElement.dataset.pdfFigures; // PDF figures still being drawn
      return named && rendered && !drawing && performance.now() - window.__changed > 1500;
    }, null, { timeout: timeoutMs, polling: 250 }).then(() => 'done', () => 'timeout'), timeoutMs + 5000);
    raw.ms = Date.now() - started - 1500; // less the quiet time waited for
    if (done === 'timeout') {
      raw.timeout = true;
      raw.ms = Date.now() - started;
      return raw;
    }
    const seen = await withTimeout(page.evaluate(async () => {
      const all = (sel) => [...document.querySelectorAll(sel)];
      const imgs = all('#preview img.graphic');
      await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); }))));
      const msg = document.getElementById('arxiv-message');
      return {
        error: msg.classList.contains('warn') ? msg.textContent : (all('#preview .render-error')[0] || {}).textContent || '',
        // KaTeX shows maths it cannot parse as .katex-error, and undefined macros in red inside the formula
        mathErrors: all('#preview .math-error, #preview .katex-error').map((e) => e.title)
          .concat(all('#preview .katex-html .mord.text[style*="color:#cc0000"]')
            .map((e) => e.textContent.trim()).filter((t) => /^\\[A-Za-z@]+\*?$/.test(t))
            .map((t) => `Undefined control sequence: ${t}`)),
        placeholders: all('#preview .graphic-placeholder').map((e) => e.textContent),
        tikzPartial: all('#preview .tikz-note').length,
        images: imgs.length,
        brokenImages: imgs.filter((i) => !i.naturalWidth).length,
        warnings: (document.getElementById('status').title || '').split('\n').filter(Boolean),
        blocks: all('#preview .src-block').length,
      };
    }), 20000);
    if (seen === 'timeout') { raw.timeout = true; return raw; }
    Object.assign(raw, seen);
    // Text commands the converter skipped are not on the page; render the source again to list them.
    const unknown = await withTimeout(page.evaluate(() => {
      try { return TeXglass.render(document.getElementById('source').value).unknownCommands || []; } catch (e) { return []; }
    }), 30000);
    if (Array.isArray(unknown)) raw.warnings = raw.warnings.concat(unknown.map((c) => `Unknown command ${c}.`));
    if (shots) await withTimeout(page.screenshot({ path: path.join(shots, paper.id.replace(/\//g, '_') + '.png'), fullPage: false }), 15000);
    if (seen.error) raw.error = seen.error.slice(0, 300);
    if (!raw.blocks && pageErrors.length) raw.error = 'Script error: ' + pageErrors[0].slice(0, 200);
    if (!raw.blocks && !raw.error) raw.error = 'Nothing was rendered: the page is empty';
    return raw;
  } catch (e) {
    raw.error = 'Run error: ' + e.message.split('\n')[0].slice(0, 200);
    raw.ms = Date.now() - started;
    return raw;
  } finally {
    // A frozen page can keep close() waiting; the caller restarts the browser then.
    raw.closed = (await withTimeout(context.close().then(() => true, () => false), 10000)) === true;
  }
}

function stepSummary(r) {
  const s = r.summary;
  const lines = [`## Render dashboard`, '',
    `Clean-render rate **${Math.round((s.clean || 0) * 100)}%**. ${s.papers} papers: **${s.ok} OK**, **${s.issues} with issues**, **${s.broken} broken**, ${s.slow} slow, ${s.nosource} without source. Median load ${((s.medianMs || 0) / 1000).toFixed(1)} s.`, ''];
  const worse = r.changes.filter((c) => c.change === 'worse');
  if (worse.length) {
    lines.push(`### Worse than the last run (${worse.length})`, '');
    for (const c of worse.slice(0, 30)) lines.push(`- ${c.id}: ${c.from} → ${c.to}${c.fresh && c.fresh.length ? ', new: `' + c.fresh.join('`, `') + '`' : ''}`);
    lines.push('');
  }
  const better = r.changes.filter((c) => c.change === 'better');
  if (better.length) lines.push(`${better.length} papers better than the last run, ${better.filter((c) => c.to === 'ok').length} of them now OK.`, '');
  if (r.top.math.length) lines.push('### Most common maths errors', '', ...r.top.math.slice(0, 10).map((e) => `- \`${e.key}\`: ${e.papers.length} papers`), '');
  lines.push('Full results: https://texglass.js.org/dashboard/', '');
  return lines.join('\n');
}

async function main() {
  const a = args();
  let corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'papers.json'), 'utf8'));
  if (a.only) corpus = corpus.filter((p) => a.only.includes(p.id)).concat(a.only.filter((id) => !corpus.some((p) => p.id === id)).map((id) => ({ id })));
  if (a.limit) corpus = corpus.slice(0, a.limit);
  if (a.shots) fs.mkdirSync(a.shots, { recursive: true });
  let prev = null;
  try { prev = a.prev ? JSON.parse(fs.readFileSync(a.prev, 'utf8')) : null; } catch (e) { prev = null; } // the first run has none
  const log = (m) => process.stdout.write(m + '\n');

  let browser = await chromium.launch();
  const raws = [];
  let downloaded = 0;
  for (const [i, paper] of corpus.entries()) {
    const src = await fetchSource(paper.id, { log, onDownload: () => downloaded++ });
    if (!src) { raws.push({ id: paper.id, error: 'Could not download the source from arXiv' }); continue; }
    if (src.kind !== 'tex') { raws.push({ id: paper.id, kind: src.kind }); continue; }
    const raw = await renderOne(browser, paper, src, a.timeout * 1000, a.shots);
    raw.packages = await packagesOf(paper.id, src);
    if (!raw.closed) {
      await withTimeout(browser.close(), 10000);
      browser = await chromium.launch();
    }
    delete raw.closed;
    raws.push(raw);
    const p = report.classify(raw);
    log(`${String(i + 1).padStart(3)}/${corpus.length} ${paper.id.padEnd(18)} ${p.status.padEnd(8)} ${((raw.ms || 0) / 1000).toFixed(1).padStart(5)}s ${p.why || Object.entries(p.counts || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  await withTimeout(browser.close(), 10000);

  const results = report.build(raws, corpus, prev, { commit: process.env.GITHUB_SHA || '' });
  fs.mkdirSync(a.out, { recursive: true });
  fs.writeFileSync(path.join(a.out, 'results.json'), JSON.stringify(results));
  const s = results.summary;
  // For the workflow: whether the source cache grew, and a summary on the run's page.
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `downloaded=${downloaded}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary(results));
  log(`\n${s.papers} papers: ${s.ok} ok, ${s.issues} with issues, ${s.broken} broken, ${s.nosource} without source, ${s.slow} slow; ${results.changes.filter((c) => c.change === 'worse').length} worse than last run.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { renderOne, packagesOf };
