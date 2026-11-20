#!/usr/bin/env node
'use strict';
/*
 * Picks the render dashboard's corpus once: for each arXiv category and year
 * below, the first paper submitted in March of that year that has a LaTeX
 * source. The result is dashboard/papers.json, which is then kept fixed so
 * runs compare like with like. Run again only to rebuild the list:
 *
 *   node dashboard/pick-corpus.js > dashboard/papers.json
 *
 * Asks arXiv's API and source server politely: one request every 3 seconds.
 */
const { fetchSource } = require('./sources.js');

const CATEGORIES = {
  maths: ['math.PR', 'math.AP', 'math.AG', 'math.CO', 'math.NT', 'math.DG', 'math.AT', 'math.FA', 'math.OA',
    'math.RT', 'math.LO', 'math.CA', 'math.DS', 'math.GT', 'math.ST', 'math.QA', 'math.CT', 'math.NA'],
  physics: ['hep-th', 'quant-ph', 'gr-qc', 'cond-mat.stat-mech', 'math-ph', 'astro-ph.CO', 'hep-ph', 'physics.flu-dyn',
    'cond-mat.str-el', 'nlin.SI'],
  cs: ['cs.LG', 'cs.CL', 'cs.DS', 'cs.IT', 'cs.LO', 'cs.CC', 'cs.CV', 'cs.CR', 'cs.PL', 'cs.GT'],
};
const YEARS = [2004, 2011, 2017, 2022, 2026];
// Papers that rendered badly when someone opened them; always in the corpus.
const KNOWN = [
  ['2609.02755', 'maths', 'regularity structures trees, local .sty files'],
  ['2611.22175', 'maths', 'heavy TikZ'],
  ['1410.3394', 'maths', 'reported 2026-11-20'],
  ['1907.00578', 'maths', 'reported 2026-11-20'],
  ['2106.10340', 'maths', 'known hard'],
  ['2611.25547', 'maths', 'known hard'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'TeXglass-render-dashboard/1 (+https://github.com/klepo0/TeXglass)';

async function candidates(cat, year) {
  const q = `cat:${cat} AND submittedDate:[${year}03010000 TO ${year}03312359]`;
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=ascending&max_results=4`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    await sleep(3000);
    if (!res.ok) continue;
    const xml = await res.text();
    return [...xml.matchAll(/<entry>[\s\S]*?<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(v\d+)?<\/id>[\s\S]*?<title>([\s\S]*?)<\/title>/g)]
      .map((m) => ({ id: m[1], title: m[3].replace(/\s+/g, ' ').trim() }));
  }
  return [];
}

async function main() {
  const papers = KNOWN.map(([id, field, note]) => ({ id, field, note }));
  const have = new Set(papers.map((p) => p.id));
  for (const [field, cats] of Object.entries(CATEGORIES)) {
    for (const cat of cats) {
      for (const year of YEARS) {
        for (const c of await candidates(cat, year)) {
          if (have.has(c.id)) continue;
          const src = await fetchSource(c.id, { log: (m) => process.stderr.write(m + '\n') });
          if (!src || src.kind !== 'tex') continue;
          papers.push({ id: c.id, field, cat, year, title: c.title });
          have.add(c.id);
          process.stderr.write(`${cat} ${year}: ${c.id} ${c.title}\n`);
          break;
        }
      }
    }
  }
  process.stdout.write(JSON.stringify(papers, null, 1) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
