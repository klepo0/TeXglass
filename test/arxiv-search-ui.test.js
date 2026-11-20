'use strict';
// Searching arXiv from the arXiv dialog in a real browser, with OpenAlex and
// arxiv.org answered by fakes. Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

test('typing words in the arXiv dialog searches, and a result opens the paper', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const searches = [];
    await page.route('http://texglass.test/**', (route) => {
      let p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    // Only DataCite answers, as when OpenAlex pauses keyless search and Semantic Scholar rate-limits.
    await page.route(/api\.(openalex|semanticscholar)\.org/, (route) => route.fulfill({ status: 503, body: '' }));
    await page.route('https://api.datacite.org/**', (route) => {
      searches.push(route.request().url());
      route.fulfill({
        contentType: 'application/vnd.api+json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          meta: { total: 1 },
          data: [{
            id: '10.48550/arxiv.2401.00001',
            attributes: {
              doi: '10.48550/arxiv.2401.00001',
              identifiers: [{ identifier: '2401.00001', identifierType: 'arXiv' }],
              titles: [{ title: 'Signatures of $p$-variation paths' }],
              creators: [{ name: 'Lovelace, Ada', givenName: 'Ada', familyName: 'Lovelace' }],
              publicationYear: 2024,
              descriptions: [{ description: 'We study $L^2$', descriptionType: 'Abstract' }],
            },
          }],
        }),
      });
    });
    const tex = '\\documentclass{article}\\begin{document}\\section{Found it}Hello.\\end{document}';
    await page.route('https://arxiv.org/src/**', (route) => route.fulfill({
      headers: { 'access-control-allow-origin': '*' }, contentType: 'application/gzip', body: zlib.gzipSync(Buffer.from(tex)),
    }));
    await page.goto('http://texglass.test/index.html');
    await page.click('#open');
    await page.fill('#arxiv-input', 'p-variation signatures');
    assert.equal(await page.textContent('#arxiv-go'), 'Search');
    await page.press('#arxiv-input', 'Enter');
    await page.waitForSelector('#arxiv-results .preprint-open');
    assert.equal(searches.length, 1);
    assert.match(searches[0], /query=p-variation%20signatures/);
    assert.equal(await page.isVisible('#arxiv-results'), true);
    assert.equal(await page.locator('#arxiv-results .preprint-title .katex').count(), 1, 'maths in the title is rendered');
    assert.match(await page.textContent('#arxiv-results .arxiv-result-meta'), /Ada Lovelace · 2024 · arXiv:2401\.00001/);
    assert.match(await page.textContent('#arxiv-message'), /1 paper on arXiv/);
    await page.screenshot({ path: process.env.ARXIV_SHOT || path.join(require('os').tmpdir(), 'arxiv-search.png') });
    // An id still imports directly.
    await page.fill('#arxiv-input', '2401.00001');
    assert.equal(await page.textContent('#arxiv-go'), 'Import');
    // Clicking a result opens it.
    await page.click('#arxiv-results .preprint-open');
    await page.waitForFunction(() => /Found it/.test(document.body.innerText));
    assert.equal(await page.evaluate(() => document.getElementById('arxiv-dialog').open), false);
  } finally {
    await browser.close();
  }
});
