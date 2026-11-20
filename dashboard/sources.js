'use strict';
/*
 * arXiv sources for the render dashboard, kept on disk so each paper is
 * downloaded from arXiv only once (the workflow keeps this folder in the
 * GitHub Actions cache). Downloads are polite: one at a time, at least three
 * seconds apart, with a user agent that says who is asking, and they back off
 * when arXiv says it is busy.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CACHE = process.env.DASHBOARD_CACHE || path.join(__dirname, '..', '.dashboard-cache');
const UA = 'TeXglass-render-dashboard/1 (+https://github.com/klepo0/TeXglass)';
const GAP = 3000;

let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stem = (id) => path.join(CACHE, id.replace(/\//g, '_'));

/** What the bytes arXiv sent are: 'tex' (a gzipped tar or .tex file) or 'pdf'. */
function kindOf(bytes, type) {
  if (/pdf/i.test(type || '')) return 'pdf';
  let body = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { body = zlib.gunzipSync(bytes); } catch (e) { return 'tex'; }
  }
  return body.slice(0, 4).toString('latin1') === '%PDF' ? 'pdf' : 'tex';
}

/** The cached source of a paper, or null: { kind, type, file, bytes } (kind 'tex', 'pdf' or 'missing'). */
function cached(id) {
  const s = stem(id);
  if (!fs.existsSync(s + '.json')) return null;
  const meta = JSON.parse(fs.readFileSync(s + '.json', 'utf8'));
  if (meta.kind === 'tex' && !fs.existsSync(s + '.src')) return null;
  return Object.assign(meta, { file: meta.kind === 'tex' ? s + '.src' : null });
}

/**
 * The source of a paper, from the cache or else from arXiv.
 * Returns { kind, type, file } or null when arXiv could not be reached.
 */
async function fetchSource(id, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const hit = cached(id);
  if (hit) return hit;
  fs.mkdirSync(CACHE, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = last + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let res;
    try {
      res = await fetch(`https://arxiv.org/src/${id}`, { headers: { 'user-agent': UA } });
    } catch (e) {
      log(`${id}: ${e.message}`);
      await sleep(GAP * (attempt + 1));
      continue;
    }
    if (res.status === 404) {
      const meta = { kind: 'missing', type: '' };
      fs.writeFileSync(stem(id) + '.json', JSON.stringify(meta));
      return meta;
    }
    if (res.status === 429 || res.status >= 500) {
      const after = Number(res.headers.get('retry-after')) || 30 * (attempt + 1);
      log(`${id}: arXiv answered ${res.status}; waiting ${after}s`);
      await sleep(after * 1000);
      continue;
    }
    if (!res.ok) { log(`${id}: arXiv answered ${res.status}`); return null; }
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    const meta = { kind: kindOf(bytes, type), type, bytes: bytes.length, fetched: new Date().toISOString() };
    if (meta.kind === 'tex') fs.writeFileSync(stem(id) + '.src', bytes);
    fs.writeFileSync(stem(id) + '.json', JSON.stringify(meta));
    if (opts.onDownload) opts.onDownload(id);
    log(`${id}: downloaded ${(bytes.length / 1e6).toFixed(1)} MB (${meta.kind})`);
    return Object.assign(meta, { file: meta.kind === 'tex' ? stem(id) + '.src' : null });
  }
  return null;
}

module.exports = { fetchSource, cached, kindOf, CACHE };
