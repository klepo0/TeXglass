'use strict';
// With the margin folded (src/margin.js), each line with a note gets a dot at
// the right edge of the text; notes on one line share a dot, and clicking a dot
// brings the margin back and lights up that note's card. Runs in a real browser
// and is skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TeXglass = require('../src/texglass.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const filler = (n) => Array.from({ length: n }, (_, i) => `Filler paragraph ${i} with some words to take up room on the page.`).join('\n\n');

const DOC = String.raw`\documentclass{article}
\usepackage{todonotes}
\begin{document}
First words.\marginpar{Note one.}

${filler(6)}

Second place.\todo{Todo two.}\marginpar{Same line.}

${filler(6)}

Here is the reader target sentence.

${filler(30)}
\end{document}`;

test('folded margin: a dot beside each noted line, and a click opens the margin on that note', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { sourceMap: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<main class="panes"><section class="pane" id="pane" style="height:700px;overflow:auto;position:relative"><article id="preview" class="document">${r.blocks.join('\n')}</article></section></main>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/scroll.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/margin.js') });
    await page.evaluate(() => {
      window.folds = [];
      window.margin = TeXglassMargin.attach({
        pane: document.getElementById('pane'),
        doc: document.getElementById('preview'),
        study: true,
        files: () => ['paper.tex'],
        blocks: () => [],
        collapsed: true,
        onCollapse: (on) => window.folds.push(on),
      });
      window.margin.setAnnotations([{ id: 'mine1', note: 'My own note.', anchor: { quote: 'reader target sentence', prefix: 'Here is the ', suffix: '.' } }]);
    });

    // Four notes on three lines: three dots, the shared one marked as several.
    const dots = page.locator('.tg-mdot');
    await assert.doesNotReject(dots.first().waitFor({ state: 'visible' }));
    assert.equal(await dots.count(), 3);
    assert.deepEqual(await dots.evaluateAll((ds) => ds.map((d) => d.className.replace('tg-mdot ', ''))),
      ['tg-mdot-par', 'tg-mdot-todo tg-mdot-more', 'tg-mdot-mine']);

    // Each dot is level with its line and just right of the text.
    const geo = await page.evaluate(() => {
      const doc = document.getElementById('preview');
      const cs = getComputedStyle(doc);
      const edge = doc.getBoundingClientRect().left + doc.offsetWidth - parseFloat(cs.paddingRight);
      const find = (s) => {
        const w = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const i = n.data.indexOf(s);
          if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + s.length); return r.getBoundingClientRect(); }
        }
        return null;
      };
      return ['First words', 'Second place', 'reader target'].map((s, i) => {
        const line = find(s);
        const d = document.querySelectorAll('.tg-mdot')[i].getBoundingClientRect();
        return { dy: Math.abs((d.top + d.height / 2) - (line.top + line.height / 2)), dx: d.left + d.width / 2 - edge };
      });
    });
    for (const g of geo) {
      assert.ok(g.dy < 10, 'dot level with its line: ' + JSON.stringify(g));
      assert.ok(g.dx > -4 && g.dx < 16, 'dot at the edge of the text: ' + JSON.stringify(g));
    }

    // No dots while the margin is open.
    await page.evaluate(() => window.margin.setCollapsed(false));
    assert.equal(await page.locator('.tg-mdot:visible').count(), 0);
    await page.evaluate(() => window.margin.setCollapsed(true));

    // Clicking the reader's dot opens the margin and lights up that card.
    await dots.nth(2).click();
    assert.equal(await page.evaluate(() => window.margin.collapsed()), false);
    assert.deepEqual(await page.evaluate(() => window.folds), [false]);
    const lit = await page.locator('.tg-mcard-pulse').textContent();
    assert.match(lit, /My own note/);
    assert.equal(await page.locator('.tg-mdot:visible').count(), 0);
  } finally {
    await browser.close();
  }
});
