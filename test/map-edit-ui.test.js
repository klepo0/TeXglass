'use strict';
// The dependency map can be edited (src/insight.js): drag a result to move it
// (remembered per paper), pin results (with what they use or are used in) and
// numbered equations, show only what is pinned (src/pick.js), save pins under a
// name, hide results, draw your own links or take the paper's away, and lock the
// map. All of it is kept with the paper's notes (record.map). Skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const DOC = `\\documentclass{article}\n\\title{Map editing}\n\\newtheorem{lemma}{Lemma}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\maketitle\n\\section{Start}\n` +
  'Opening words.\n\\begin{equation}\\label{eq:a} a = b \\end{equation}\n' +
  '\\begin{lemma}\\label{first} First, by \\eqref{eq:a}.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  '\\begin{lemma}\\label{second} Second.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  '\\begin{lemma}\\label{third} Third.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  'Middle words.\n\\begin{equation}\\label{eq:b} c = d \\end{equation}\n' +
  '\\begin{theorem}\\label{main} Last.\\end{theorem}\\begin{proof} By Lemmas~\\ref{first} and~\\ref{second}.\\end{proof}\n\\end{document}';

test('the dependency map can be edited, pinned and locked', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    // opened as a file, so that the paper has notes to keep the map's changes with
    await page.setInputFiles('#file-input', { name: 'map-editing.tex', mimeType: 'text/x-tex', buffer: Buffer.from(DOC) });
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 4);
    await page.keyboard.press('m');
    await page.waitForSelector('.insight-dialog[open] .dep-map');
    const node = (label) => page.locator('.insight-dialog .dep-node', { hasText: label }).first();
    // a click on a node, then the pointer moves off it (so that its preview does not cover the buttons)
    const pickNode = async (label) => { await node(label).click(); await page.mouse.move(5, 5); };
    const box = async (label) => { const r = await node(label).locator('rect').boundingBox(); return r; };

    // Drag Lemma 1 down by 120px: it stays there when the map is drawn again.
    const b0 = await box('Lemma 1');
    await page.mouse.move(b0.x + 10, b0.y + 10);
    await page.mouse.down();
    await page.mouse.move(b0.x + 30, b0.y + 70, { steps: 4 });
    await page.mouse.move(b0.x + 40, b0.y + 130, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const b1 = await box('Lemma 1');
    assert.ok(b1.y - b0.y > 100, `moved down (${b0.y} → ${b1.y})`);
    assert.equal(await page.locator('.insight-dialog .dep-detail').innerText().then((s) => /No result picked/.test(s)), true, 'a drag picks nothing');
    assert.ok(await page.locator('.insight-dialog [data-reset-layout]').count(), 'Reset layout is offered');

    // Pick Theorem 1 and pin it with what it uses.
    await pickNode('Theorem 1');
    await page.click('.insight-dialog [data-mpin="uses"]');
    assert.ok(await node('Theorem 1').evaluate((g) => g.classList.contains('dep-pinned')));
    assert.ok(await node('Lemma 2').evaluate((g) => g.classList.contains('dep-pinned-sub')), 'what it uses is brought along');
    assert.match(await page.locator('.insight-dialog .dep-pins').innerText(), /1 pinned/);

    // Draw a link of my own: Theorem 1 uses Lemma 3.
    await page.click('.insight-dialog [data-link="uses"]');
    await pickNode('Lemma 3');
    assert.ok(await page.locator('.insight-dialog .dep-edge.dep-mine').count(), 'my arrow is drawn');
    assert.ok(await node('Lemma 3').evaluate((g) => g.classList.contains('dep-pinned-sub')), 'and the pin follows it');
    // Take the paper's link to Lemma 2 away, then bring it back.
    await pickNode('Theorem 1');
    await page.click('.insight-dialog [data-link-edit]');
    await page.locator('.insight-dialog .dep-unlink').first().click();
    assert.match(await page.locator('.insight-dialog .dep-detail').innerText(), /Taken away/i);
    await page.click('.insight-dialog .dep-relink');
    assert.doesNotMatch(await page.locator('.insight-dialog .dep-detail').innerText(), /Taken away/i);

    // Save the pins as a map.
    await page.click('.insight-dialog [data-save-view]');
    await page.fill('.insight-dialog .dep-view-name', 'Main proof');
    await page.keyboard.press('Enter');
    assert.ok(await page.locator('.insight-dialog [data-view="Main proof"]').count());

    // Lock: no Hide or link buttons, and dragging does nothing.
    await page.click('.insight-dialog [data-lock]');
    await pickNode('Lemma 2');
    assert.equal(await page.locator('.insight-dialog [data-mhide], .insight-dialog [data-link]').count(), 0);
    const c0 = await box('Lemma 2');
    await page.mouse.move(c0.x + 10, c0.y + 10);
    await page.mouse.down();
    await page.mouse.move(c0.x + 20, c0.y + 140, { steps: 6 });
    await page.mouse.up();
    const c1 = await box('Lemma 2');
    assert.ok(Math.abs(c1.y - c0.y) < 3, 'locked: it does not move');
    await page.click('.insight-dialog [data-lock]');
    // Hide Lemma 2 from the map, and bring it back.
    await pickNode('Lemma 2');
    await page.click('.insight-dialog [data-mhide="1"]');
    assert.equal(await page.locator('.insight-dialog .dep-node', { hasText: 'Lemma 2' }).count(), 0);
    await page.click('.insight-dialog input[data-opt="showHidden"]');
    await pickNode('Lemma 2');
    await page.click('.insight-dialog [data-mhide="0"]');
    assert.equal(await node('Lemma 2').evaluate((g) => g.classList.contains('dep-hidden')), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.insight-dialog').open);

    // Pin equation (2) by the pin at its number.
    const eq = page.locator('#preview .math-display', { hasText: '(2)' }).first();
    await eq.hover();
    await eq.locator('.tg-pin-btn').click();
    assert.ok(await eq.evaluate((el) => el.classList.contains('tg-pinned')));

    // Show pinned: Theorem 1, the lemmas it uses (mine too), (1) through Lemma 1's statement, and (2).
    await page.click('#more-menu-btn, #more').catch(() => {});
    await page.evaluate(() => document.getElementById('pick-results').click());
    await page.waitForSelector('#preview.pick-view, .pick-view');
    const shown = await page.evaluate(() => {
      const vis = (el) => el.getClientRects().length > 0;
      return {
        thms: Array.from(document.querySelectorAll('#preview .theorem')).filter(vis).map((el) => el.querySelector('.thm-name').textContent),
        eqs: Array.from(document.querySelectorAll('#preview .math-display')).filter(vis).map((el) => (el.querySelector('.tag') || {}).textContent),
        words: /Opening words|Middle words/.test(Array.from(document.querySelectorAll('#preview p')).filter(vis).map((x) => x.textContent).join(' ')),
      };
    });
    assert.deepEqual(shown.thms, ['Lemma 1', 'Lemma 2', 'Lemma 3', 'Theorem 1']);
    assert.deepEqual(shown.eqs, ['(1)', '(2)']);
    assert.equal(shown.words, false);
    await page.keyboard.press('Escape');

    // Everything is kept with the paper's notes, and comes back after a reload.
    const saved = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => /notes/.test(x) && localStorage.getItem(x).includes('"map"'));
      return k ? JSON.parse(localStorage.getItem(k)).map : null;
    });
    assert.ok(saved && saved.pos && saved.pin && saved.link && saved.view && saved.view['Main proof'], 'kept in the record: ' + JSON.stringify(saved));
    assert.equal(saved.pin['eq:(2)'].d, 'self');
    assert.equal(saved.pin['label:main'].d, 'uses');
    assert.equal(saved.link['label:third > label:main'].s, 'add');

    // Unpin all, then bring the saved map back.
    await page.keyboard.press('m');
    await page.waitForSelector('.insight-dialog[open] .dep-map');
    assert.ok(await page.locator('.insight-dialog .dep-node.dep-eqnode', { hasText: '(2)' }).count(), 'the pinned equation is on the map');
    await page.click('.insight-dialog [data-unpin-all]');
    assert.equal(await page.locator('.insight-dialog .dep-pinned').count(), 0);
    await page.click('.insight-dialog [data-view="Main proof"]');
    assert.ok(await node('Theorem 1').evaluate((g) => g.classList.contains('dep-pinned')));

    // After a reload, opening the paper again brings it all back.
    await page.reload();
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.setInputFiles('#file-input', { name: 'map-editing.tex', mimeType: 'text/x-tex', buffer: Buffer.from(DOC) });
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 4 && /Last/.test(document.getElementById('preview').textContent));
    await page.keyboard.press('m');
    await page.waitForSelector('.insight-dialog[open] .dep-map');
    assert.ok(await node('Theorem 1').evaluate((g) => g.classList.contains('dep-pinned')));
    assert.ok(await page.locator('.insight-dialog .dep-edge.dep-mine').count());
    assert.ok(await page.locator('.insight-dialog [data-view="Main proof"]').count());
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
