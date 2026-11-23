'use strict';
// The Notation tab arranged for easy access (src/insight.js): a search by
// symbol or meaning, a switch between Section, Kind and A–Z (remembered),
// the symbols of the section being read at the top, and rows pinned there. A made-up paper.
// The browser part is skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { kindOfSymbol, alphaOf, greekQuery } = require('../src/insight.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');

/** The pin opens the side panel's Pins tab; a second click would close it again. */
async function openPins(page) {
  if (!(await page.isVisible('.side-pins'))) await page.click('#pins');
  await page.waitForSelector('.side-pins', { state: 'visible' });
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

test('kinds, A–Z places and Greek searches', () => {
  assert.equal(kindOfSymbol('\\cH', ['be a separable Hilbert space and write'], '\\mathcal{H}', 0, ''), 'spaces');
  assert.equal(kindOfSymbol('\\R', [], '\\mathbb{R}', 0, ''), 'spaces');
  assert.equal(kindOfSymbol('\\E', [], '\\mathbb{E}', 0, ''), 'maps');
  assert.equal(kindOfSymbol('\\norm', [], '\\lVert #1\\rVert', 1, ''), 'maps');
  assert.equal(kindOfSymbol('P_t', [' denote the heat semigroup', ''], '', 0, ''), 'maps');
  assert.equal(kindOfSymbol('\\tr', [], '\\operatorname{tr}', 0, ''), 'names');
  assert.equal(kindOfSymbol('\\Gamma', [' denote the gamma function.', 'Let '], '', 0, ''), 'names');
  assert.equal(kindOfSymbol('\\alpha', ['>0 be a fixed constant.', ''], '', 0, ''), 'constants');
  assert.equal(kindOfSymbol('C_0', [], '', 0, 'C_0 := 2\\pi'), 'constants');
  assert.equal(kindOfSymbol('\\beta', [], '', 0, '\\beta := \\alpha/2'), 'other');

  assert.equal(alphaOf('\\mathbb{R}').group, 'R');
  assert.equal(alphaOf('\\hat{u}_t').group, 'U');
  assert.equal(alphaOf('\\varphi').group, 'Greek');
  assert.ok(alphaOf('\\alpha').key < alphaOf('\\beta').key && alphaOf('\\beta').key < alphaOf('\\Omega').key);
  assert.equal(alphaOf('\\norm').group, 'N');
  assert.equal(alphaOf('\\lVert #1\\rVert').group, 'Other');
  assert.equal(greekQuery('α-stable Γ'), 'alpha-stable gamma');
});

const DOC = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\newcommand{\\R}{\\mathbb{R}}
\\newcommand{\\cH}{\\mathcal{H}}
\\newcommand{\\norm}[1]{\\lVert #1\\rVert}
\\DeclareMathOperator{\\Var}{Var}
\\begin{document}
\\section{Introduction}
Let $\\cH$ be a separable Hilbert space. We denote by $\\mu$ the Gaussian measure on $\\cH$.
Let $\\alpha>0$ be a fixed constant.
${Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i}, long enough to need scrolling between the sections of this paper.\n\n`).join('')}
\\section{Setting}
Let $\\Gamma$ denote the gamma function. The constant $C_0 := 2\\pi$ appears often.
\\begin{theorem} For all $x\\in\\cH$, $\\norm{x} \\le C_0$ and $\\Var(x) \\in \\R$. \\end{theorem}
${Array.from({ length: 30 }, (_, i) => `More filler ${i}, long enough to need scrolling to the end of this paper.\n\n`).join('')}
\\end{document}`;

test('the Notation tab: search, Section / Kind / A–Z, and Used in …', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    const load = async () => {
      await page.goto('http://texglass.test/index.html');
      await page.waitForSelector('#preview h1, #preview h2, #preview .section');
      await page.click('#mode-split');
      await page.fill('#source', DOC);
      await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 1 && document.querySelectorAll('#preview h2').length >= 2);
      await page.click('#mode-preview');
      await page.click('[data-side-tab="notation"]');
      await page.waitForSelector('.side-insight .insight-group');
    };
    await load();
    const groups = () => page.locator('.side-insight .insight-group:not(.insight-group-used):not([hidden]) > summary').allTextContents();
    const visible = (sel) => page.locator(`.side-insight .insight-group:not(.insight-group-used) ${sel}`).evaluateAll((els) => els.filter((e) => e.offsetParent).length);

    // By section, the default: under the section where each symbol first appears.
    const bySection = await groups();
    assert.match(bySection[0], /^§1 Introduction/);
    assert.match(bySection[1], /^§2 Setting/);

    // By kind.
    await page.click('.side-insight [data-order="kind"]');
    const byKind = (await groups()).map((g) => g.replace(/\s*\d+$/, ''));
    assert.deepEqual(byKind, ['Spaces and sets', 'Maps and operators', 'Named functions', 'Constants and parameters']);
    const spaces = await page.locator('.side-insight [data-group="kind-spaces"]').textContent();
    assert.match(spaces, /\\cH/);
    assert.match(spaces, /\\R/);

    // A–Z, Greek letters together at the end; remembered.
    await page.click('.side-insight [data-order="az"]');
    const az = (await groups()).map((g) => g.replace(/\s*\d+$/, ''));
    assert.equal(az[az.length - 1], 'Greek');
    assert.deepEqual(az.slice(0, -1), az.slice(0, -1).slice().sort());
    assert.equal(await page.evaluate(() => localStorage.getItem('texglass:notation-order')), 'az');

    // Search by meaning, and by a Greek letter typed as such.
    await page.fill('.side-insight .insight-filter', 'measure');
    assert.equal(await visible('.insight-symbols li') + await visible('.insight-table tr'), 1);
    await page.fill('.side-insight .insight-filter', 'γ');
    assert.equal(await visible('.insight-symbols li') + await visible('.insight-table tr'), 1);
    await page.fill('.side-insight .insight-filter', 'nothing like this');
    assert.ok(await page.locator('.side-insight .insight-nomatch').isVisible());
    await page.fill('.side-insight .insight-filter', '');
    assert.ok(await visible('.insight-symbols li') > 3);

    // Used in …: follows the reader into §2; a chip finds its entry in the list.
    const usedTitle = () => page.locator('.side-insight .insight-group-used > summary').textContent();
    await page.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
    await page.waitForFunction(() => /§1/.test((document.querySelector('.side-insight .insight-group-used > summary') || {}).textContent || ''));
    assert.match(await usedTitle(), /Used in §1 Introduction/);
    await page.evaluate(() => { const h = document.querySelectorAll('#preview h2')[1]; h.scrollIntoView(); });
    await page.waitForFunction(() => /§2/.test((document.querySelector('.side-insight .insight-group-used > summary') || {}).textContent || ''));
    const chips = await page.locator('.side-insight .insight-chip').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    assert.ok(chips.includes('\\Var') && chips.includes('\\cH') && chips.includes('\\Gamma'), chips.join(' '));
    assert.ok(!chips.includes('\\alpha'), 'α is not used in §2');
    assert.equal(chips.filter((c) => /norm/.test(c)).length, 1, '\\norm and \\norm{x} once');
    await page.click('.side-insight .insight-chip[aria-label="\\\\Var"]');
    await page.waitForSelector('.side-insight .insight-flash');

    // A folded group stays folded when the list is drawn again.
    await page.click('.side-insight [data-order="section"]');
    await page.click('.side-insight [data-group="sec-1"] > summary');
    await page.click('.side-insight [data-order="kind"]');
    await page.click('.side-insight [data-order="section"]');
    assert.equal(await page.locator('.side-insight [data-group="sec-1"]').evaluate((d) => d.open), false);

    // Pins: a pinned row shows at the top and stays in view while the list scrolls.
    assert.equal(await page.locator('.side-insight .insight-pinned').count(), 0);
    await page.click('.side-insight .insight-group:not(.insight-group-pinned) [data-pin="m:Var"]');
    await page.waitForSelector('.side-insight .insight-stuck .insight-group-pinned');
    assert.match(await page.locator('.side-insight .insight-group-pinned').textContent(), /\\Var/);
    assert.equal(await page.locator('.side-insight .insight-group:not(.insight-group-pinned) [data-pin="m:Var"]').getAttribute('aria-pressed'), 'true');
    const stuckTop = () => page.evaluate(() => {
      const pane = document.getElementById('toc-pane');
      return Math.round(document.querySelector('.side-insight .insight-stuck').getBoundingClientRect().top - pane.getBoundingClientRect().top);
    });
    await page.evaluate(() => { document.getElementById('toc-pane').scrollTop = 0; });
    const before = await stuckTop();
    await page.evaluate(() => { document.getElementById('toc-pane').scrollTop = 400; });
    const after = await stuckTop();
    assert.ok(after > 0 && after < before, `the pinned rows stick under the tabs (${before} → ${after})`);
    // the search leaves pinned rows alone
    await page.fill('.side-insight .insight-filter', 'measure');
    assert.ok(await page.locator('.side-insight .insight-group-pinned tr').isVisible());
    await page.fill('.side-insight .insight-filter', '');
    // Pinned rows reorder: drag a handle, or press ↑ ↓ on it; the order is kept.
    await page.click('.side-insight .insight-group:not(.insight-group-pinned) [data-pin="s:\\\\Gamma"]');
    await page.waitForSelector('.side-insight .insight-pin-item:nth-child(2)');
    const pinOrder = () => page.locator('.side-insight .insight-pin-item').evaluateAll((els) => els.map((e) => e.dataset.pinItem));
    // before any reordering, pins come in the paper's order (Γ is used before \\Var)
    assert.deepEqual(await pinOrder(), ['s:\\Gamma', 'm:Var']);
    const handle = page.locator('.side-insight .insight-pin-item[data-pin-item="m:Var"] .insight-drag');
    const hb = await handle.boundingBox();
    const first = await page.locator('.side-insight .insight-pin-item').first().boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, first.y + 4, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.side-insight .insight-pin-item').dataset.pinItem === 'm:Var');
    // pins of the Notation tab are pins like the others now: the order is the reading order of the Pinned list
    await openPins(page);
    assert.deepEqual(await page.$$eval('.side-pins [data-pins-view="order"]', (b) => b.map((x) => x.getAttribute('aria-pressed'))), ['true'], 'an order shows the list in order');
    assert.deepEqual(await page.$$eval('.side-pins .tg-pins-row', (rows) => rows.map((r) => r.dataset.key)), ['m:Var', 's:\\Gamma']);
    await page.click('[data-side-tab="notation"]'); // back from the Pins tab
    await page.locator('.side-insight .insight-pin-item').first().locator('.insight-drag').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.side-insight .insight-pin-item').dataset.pinItem === 's:\\Gamma');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.insight-pin-item').dataset.pinItem), 'm:Var', 'the moved row keeps the focus');
    await page.click('.side-insight .insight-group-pinned [data-pin="s:\\\\Gamma"]');
    await page.waitForFunction(() => document.querySelectorAll('.side-insight .insight-pin-item').length === 1);

    // "Used in …" can be pinned too
    assert.equal(await page.locator('.side-insight .insight-stuck .insight-used').count(), 0);
    await page.click('.side-insight [data-pin-used]');
    await page.waitForSelector('.side-insight .insight-stuck .insight-used .insight-chip');

    // The order and the pins are kept for the next visit.
    await page.click('.side-insight [data-order="kind"]');
    await load();
    assert.equal(await page.locator('.side-insight [data-order="kind"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('.side-insight .insight-group-pinned [data-pin="m:Var"]').count(), 1);
    assert.equal(await page.locator('.side-insight .insight-stuck .insight-used').count(), 1);
    // unpinning takes the row out of the pinned block
    await page.click('.side-insight .insight-group-pinned [data-pin="m:Var"]');
    await page.waitForFunction(() => !document.querySelector('.side-insight .insight-group-pinned'));
  } finally {
    await browser.close();
  }
});
