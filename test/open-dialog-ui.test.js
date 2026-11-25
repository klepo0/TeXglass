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

test('browse a private repository and open an included chapter from a pinned commit', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await serve(page);
    const token = 'github_pat_mock_private_browse';
    const headers = { ...CORS, 'access-control-allow-headers': 'authorization' };
    const files = [];
    let publicRaw = 0;
    await page.route('https://raw.githubusercontent.com/**', (route) => {
      publicRaw++;
      return route.abort();
    });
    await page.route('https://api.github.com/**', (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const json = (data) => route.fulfill({ json: data, headers });
      const bytes = (body, contentType = 'text/plain') => route.fulfill({ body, contentType, headers });
      if (req.headers().authorization !== 'Bearer ' + token) return route.fulfill({ status: 401, headers });
      if (url.pathname === '/user/repos') return json([{ full_name: 'ada/private-notes', private: true, default_branch: 'main' }]);
      const endpoint = url.pathname.replace('/repos/ada/private-notes', '');
      if (endpoint === '/branches') return json([{ name: 'main', commit: { sha: 'main-commit' } }, { name: 'draft/review', commit: { sha: 'review-commit' } }]);
      if (endpoint === '/git/commits/main-commit') return json({ tree: { sha: 'main-tree' } });
      if (endpoint === '/git/commits/review-commit') return json({ tree: { sha: 'review-tree' } });
      if (endpoint === '/git/trees/main-tree') return json({ tree: [] });
      if (endpoint === '/git/trees/review-tree') {
        return json({ tree: [{ type: 'tree', path: 'drafts', sha: 'draft-folder' }] });
      }
      if (endpoint === '/git/trees/draft-folder') return json({ tree: [{ type: 'blob', path: 'chapter 1.tex' }, { type: 'blob', path: 'paper.tex' }, { type: 'blob', path: 'notes.md' }] });
      if (endpoint.startsWith('/contents/')) {
        const path = decodeURIComponent(endpoint.slice('/contents/'.length));
        files.push([path, url.searchParams.get('ref'), req.headers().accept]);
        if (path === 'drafts/chapter 1.tex') return bytes('% !TEX root = paper.tex\n\\section{Private Chapter}A private paragraph.');
        if (path === 'drafts/paper.tex') return bytes('\\documentclass{article}\\begin{document}\n\\input{chapter 1}\\includegraphics{figure.png}\\bibliography{paper}\\end{document}');
        if (path === 'drafts/paper.bbl') return bytes('\\begin{thebibliography}{9}\\bibitem{private}Private citation.\\end{thebibliography}');
        if (path === 'drafts/figure.png') return bytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+rNioAAAAASUVORK5CYII=', 'base64'), 'image/png');
      }
      return route.fulfill({ status: 404, headers });
    });
    await page.goto('http://texglass.test/index.html');
    await page.click('#open');
    await page.getByRole('button', { name: 'Browse my GitHub repositories' }).click();
    await page.locator('#github-repo-token').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.selectOption('#github-repo-select', { label: 'ada/private-notes (private)' });
    await page.getByText('No TeX files or subfolders in this folder.').waitFor();
    await page.selectOption('#github-branch-select', { label: 'draft/review' });
    await page.getByRole('button', { name: 'drafts/', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'notes.md' }).count(), 0);
    await page.getByRole('button', { name: 'Up a folder' }).click();
    await page.getByRole('button', { name: 'drafts/', exact: true }).click();
    await page.getByRole('button', { name: 'chapter 1.tex', exact: true }).click();
    await page.locator('#preview').getByText('A private paragraph.').waitFor();
    await page.locator('#preview').getByText('Private citation.').waitFor();
    assert.equal(await page.locator('#preview img[src^="blob:"]').count(), 1);
    assert.equal(await page.locator('#github-browser-dialog').evaluate((dialog) => dialog.open), false);
    assert.equal(publicRaw, 0);
    assert.deepEqual(files.map(([path]) => path).sort(), ['drafts/chapter 1.tex', 'drafts/figure.png', 'drafts/paper.bbl', 'drafts/paper.tex']);
    assert.ok(files.every(([, commit, accept]) => commit === 'review-commit' && accept === 'application/vnd.github.raw+json'));
    const persisted = await page.evaluate(() => JSON.stringify(localStorage));
    for (const secret of [token, 'private-notes', 'A private paragraph.']) assert.ok(!persisted.includes(secret));
    await page.click('#open');
    await page.getByRole('button', { name: 'Browse my GitHub repositories' }).click();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.locator('#github-connect-form').waitFor();
    assert.equal(await page.locator('#github-repo-token').inputValue(), '');
    await page.locator('#preview').getByText('Welcome to TeXglass').waitFor({ state: 'attached' });
  } finally {
    await browser.close();
  }
});

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
    assert.equal(await page.isVisible('#original-pdf'), false);

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

test('render warnings jump to the affected content and arXiv imports keep a PDF link', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await serve(page);
    const tex = String.raw`\documentclass{article}
\begin{document}
\section{Broken examples}
See \ref{missing-result}.

$\frac{a}$ and $\unknowncommand$ and $\eqref{missing-equation}$.

\includegraphics{missing.png}
\end{document}`;
    await page.route('https://arxiv.org/src/**', (route) => {
      const pdfOnly = route.request().url().endsWith('2401.00001v3');
      return route.fulfill({ headers: CORS, contentType: pdfOnly ? 'application/pdf' : 'text/plain', body: pdfOnly ? '%PDF-' : tex });
    });
    await page.goto('http://texglass.test/index.html?arxiv=math/0601001v2');
    await page.waitForSelector('#more[data-render-warnings="5"]');
    await page.click('#preview .section .fold-toggle');
    assert.equal(await page.isVisible('.graphic-placeholder'), false);
    await page.click('#more');
    assert.equal(await page.textContent('#render-warnings'), '5 render warnings');
    assert.equal(await page.getAttribute('#original-pdf', 'href'), 'https://arxiv.org/pdf/math/0601001v2');
    const pdfBounds = await page.locator('#original-pdf').boundingBox();
    assert.ok(pdfBounds.x >= 0 && pdfBounds.x + pdfBounds.width <= 390, 'the PDF link fits on a phone');

    await page.click('#render-warnings');
    const dialog = page.getByRole('dialog', { name: 'Rendering warnings' });
    assert.equal(await dialog.getByRole('button', { name: 'Undefined reference "missing-result".' }).count(), 1);
    assert.equal(await dialog.getByRole('button', { name: 'Undefined math command \\unknowncommand' }).count(), 1);
    assert.equal(await dialog.getByRole('button', { name: 'Undefined reference "missing-equation".' }).count(), 1);
    assert.equal(await dialog.getByRole('button', { name: /^Math could not be rendered/ }).count(), 1);
    await dialog.getByRole('button', { name: 'Missing figure: missing.png' }).click();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator('.graphic-placeholder').evaluate((el) => el === document.activeElement), true);
    assert.equal(await page.isVisible('.graphic-placeholder'), true);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForSelector('.toolbar > #render-actions #original-pdf');
    assert.equal(await page.getByRole('button', { name: '5 render warnings' }).isVisible(), true);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForSelector('#more-compact #render-actions', { state: 'attached' });

    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#original-pdf:not([hidden])', { state: 'attached' });
    assert.equal(await page.getAttribute('#original-pdf', 'href'), 'https://arxiv.org/pdf/math/0601001v2');
    await page.evaluate(() => localStorage.removeItem('texglass:last-arxiv'));
    await page.reload();
    await page.waitForSelector('#original-pdf:not([hidden])', { state: 'attached' });
    assert.equal(await page.getAttribute('#original-pdf', 'href'), 'https://arxiv.org/pdf/math/0601001v2');

    await page.click('#more'); // on a phone, Open is in the … menu (the gear has its place)
    await page.click('#more-compact #open');
    await page.fill('#arxiv-input', '2401.00001v3');
    await page.press('#arxiv-input', 'Enter');
    await page.waitForSelector('#arxiv-original-pdf:not([hidden])');
    assert.match(await page.textContent('#arxiv-message'), /only a PDF/);
    assert.equal(await page.getAttribute('#arxiv-original-pdf', 'href'), 'https://arxiv.org/pdf/2401.00001v3');
    await page.fill('#arxiv-input', '2401.00002');
    assert.equal(await page.isVisible('#arxiv-original-pdf'), false);
    await page.click('#arxiv-cancel');
    await page.waitForSelector('#arxiv-dialog', { state: 'hidden' });
    await page.setInputFiles('#file-input', [
      { name: 'local.tex', mimeType: 'text/plain', buffer: Buffer.from(String.raw`\documentclass{article}\begin{document}\includegraphics{broken.svg}\end{document}`) },
      { name: 'broken.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('broken image') },
    ]);
    await page.waitForSelector('#preview img.graphic');
    await page.waitForSelector('#more[data-render-warnings="1"]');
    await page.click('#more');
    assert.equal(await page.isVisible('#original-pdf'), false);
    await page.click('#render-warnings');
    await dialog.getByRole('button', { name: 'Figure could not load: broken.svg' }).click();
    assert.equal(await page.locator('img.graphic').evaluate((el) => el === document.activeElement), true);
  } finally {
    await browser.close();
  }
});

test('edits that leave every warning as it was do not rebuild the warning list', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview .src-block');
    const doc = (clean, broken) => String.raw`\documentclass{article}
\begin{document}
${clean}

${broken}
\end{document}`;
    const shows = (text) => page.waitForFunction((t) => document.getElementById('preview').textContent.includes(t), text);
    await page.evaluate((text) => window.TeXglassViewer.reshow(text),
      doc('Clean text.', String.raw`Broken $\unknowncommand$.`));
    await page.click('#mode-edit');
    const edit = async (before, after) => {
      await page.locator('#preview .src-block > p', { hasText: before }).click();
      await page.fill('#inline-source', after);
      await page.press('#inline-source', 'Escape');
    };
    await page.waitForSelector('#render-warnings:has-text("1 render warning")');
    // The list's text node is kept as long as the list is not built again.
    await page.evaluate(() => { window.listedText = document.getElementById('render-warnings').firstChild; });
    const rebuilt = () => page.evaluate(() => document.getElementById('render-warnings').firstChild !== window.listedText);

    // An edit away from the warning: nothing to build.
    await edit('Clean text.', 'Clean text, edited.');
    await shows('Clean text, edited.');
    assert.equal(await rebuilt(), false);

    // An edit to the block with the warning: built again.
    await edit('Broken', String.raw`Broken again $\unknowncommand$.`);
    await shows('Broken again');
    assert.equal(await rebuilt(), true);
    assert.equal(await page.textContent('#render-warnings'), '1 render warning');

    // An edit that makes a new warning elsewhere: built again.
    await page.evaluate(() => { window.listedText = document.getElementById('render-warnings').firstChild; });
    await edit('Clean text, edited.', String.raw`Clean text, $\alsounknown$.`);
    await page.waitForSelector('#render-warnings:has-text("2 render warnings")');
    assert.equal(await rebuilt(), true);

    // Fixing both: no warnings left.
    await edit('Clean text,', 'Clean text.');
    await edit('Broken again', 'Fixed.');
    await page.waitForSelector('#render-warnings', { state: 'hidden' });
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
