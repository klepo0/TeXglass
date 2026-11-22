'use strict';
// The toolbar's one Open button and dialog: arXiv, "github <words>" searching
// GitHub, GitHub links; and the "…" menu holding Save, Export and Print.
// GitHub is answered by fakes. Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const CORS = { 'access-control-allow-origin': '*' };

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

test('one Open button; "github <words>" searches GitHub and a result opens', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await serve(page);
    const searches = [];
    await page.route('https://api.github.com/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/search/repositories') {
        searches.push(url.searchParams.get('q'));
        return route.fulfill({
          contentType: 'application/json', headers: CORS,
          body: JSON.stringify({
            total_count: 1,
            items: [{ name: 'notes', full_name: 'ada/notes', owner: { login: 'ada' }, description: 'Lecture notes on $L^2$ spaces', stargazers_count: 12, pushed_at: '2026-03-01T00:00:00Z', html_url: 'https://github.com/ada/notes', default_branch: 'main' }],
          }),
        });
      }
      if (url.pathname === '/repos/ada/notes') return route.fulfill({ contentType: 'application/json', headers: CORS, body: JSON.stringify({ default_branch: 'main' }) });
      if (url.pathname.startsWith('/repos/ada/notes/git/trees')) {
        return route.fulfill({ contentType: 'application/json', headers: CORS, body: JSON.stringify({ tree: [{ path: 'main.tex', type: 'blob' }], truncated: false }) });
      }
      route.fulfill({ status: 404, headers: CORS, body: '' });
    });
    await page.route('https://raw.githubusercontent.com/**', (route) => {
      if (/\/ada\/notes\/main\/main\.tex$/.test(route.request().url())) {
        return route.fulfill({ headers: CORS, contentType: 'text/plain', body: '\\documentclass{article}\\begin{document}\\section{From GitHub}Hi.\\end{document}' });
      }
      route.fulfill({ status: 404, headers: CORS, body: '' });
    });
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');

    // The arXiv and GitHub buttons are gone; Open opens the one dialog.
    assert.equal(await page.locator('#arxiv, #github').count(), 0);
    await page.click('#open');
    assert.equal(await page.evaluate(() => document.getElementById('arxiv-dialog').open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'arxiv-input');

    // The button says what Enter will do.
    await page.fill('#arxiv-input', '2401.00001');
    assert.equal(await page.textContent('#arxiv-go'), 'Import');
    await page.fill('#arxiv-input', 'https://github.com/ada/notes');
    assert.equal(await page.textContent('#arxiv-go'), 'Open');
    await page.fill('#arxiv-input', 'GitHub lecture notes');
    assert.equal(await page.textContent('#arxiv-go'), 'Search');

    await page.press('#arxiv-input', 'Enter');
    await page.waitForSelector('#arxiv-results .preprint-open');
    assert.deepEqual(searches, ['lecture notes language:TeX']);
    assert.match(await page.textContent('#arxiv-results .preprint-title'), /ada\/notes/);
    assert.match(await page.textContent('#arxiv-results .arxiv-result-meta'), /★ 12 · updated 2026 · GitHub/);
    assert.match(await page.textContent('#arxiv-message'), /1 LaTeX repository on GitHub/);

    await page.click('#arxiv-results .preprint-open');
    await page.waitForFunction(() => /From GitHub/.test(document.getElementById('preview').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('arxiv-dialog').open), false);

    // "github" alone asks for words.
    await page.click('#open');
    await page.fill('#arxiv-input', 'github');
    await page.press('#arxiv-input', 'Enter');
    assert.match(await page.textContent('#arxiv-message'), /after github/);
    await page.keyboard.press('Escape');
  } finally {
    await browser.close();
  }
});

test('Save, Export and Print sit in the "…" menu', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    for (const id of ['save', 'export', 'print']) assert.equal(await page.isVisible('#' + id), false, id + ' is hidden until the menu opens');

    await page.click('#more');
    assert.equal(await page.getAttribute('#more', 'aria-expanded'), 'true');
    for (const id of ['save', 'export', 'print']) assert.equal(await page.isVisible('#' + id), true, id + ' shows in the menu');

    // Escape closes it and gives focus back; ArrowDown opens it on the first item.
    await page.keyboard.press('Escape');
    // (focus is on the button after a click, so Escape from the menu needs focus inside it)
    await page.focus('#more');
    await page.keyboard.press('ArrowDown');
    // (the menu starts with Papers: OAI preprints, then Saved papers)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'preprints');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'library-open');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#more-menu'), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'more');

    // A click outside closes it (below and right of the menu, which reaches about y=540).
    await page.click('#more');
    await page.mouse.click(900, 700);
    assert.equal(await page.isVisible('#more-menu'), false);

    // Choosing Export closes the menu and downloads the page.
    await page.click('#more');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    assert.match(download.suggestedFilename(), /\.html$/);
    assert.equal(await page.isVisible('#more-menu'), false);
  } finally {
    await browser.close();
  }
});
