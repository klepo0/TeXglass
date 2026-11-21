'use strict';
// The margin's fold button and the note arrows under it stand still on screen
// while the text scrolls (src/margin.js: a sticky box on a rail as tall as the
// text), with no lag behind the scroll, open or folded. Runs in a real browser
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
\begin{document}
First words.\marginpar{Note one.}

${filler(80)}

Last place.\marginpar{Note two.}
\end{document}`;

test('the fold button and note arrows stay put while the text scrolls', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { sourceMap: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<main class="panes"><section class="pane" id="pane" style="height:600px;overflow:auto;position:relative"><article id="preview" class="document">${r.blocks.join('\n')}</article></section></main>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/scroll.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/margin.js') });
    await page.evaluate(() => {
      window.margin = TeXglassMargin.attach({ pane: document.getElementById('pane'), doc: document.getElementById('preview') });
      window.margin.refresh();
    });
    await page.waitForSelector('.tg-margin-nav');
    // Where the controls are on screen after each scroll step, read in the same
    // frame as the scroll (no waiting for a scroll handler to catch up).
    const tops = () => page.evaluate(() => {
      const pane = document.getElementById('pane');
      const out = [];
      for (const y of [0, 37, 400, 1234, 2500]) {
        pane.scrollTop = y;
        const p = pane.getBoundingClientRect().top;
        out.push([
          Math.round(document.querySelector('.tg-margin-toggle').getBoundingClientRect().top - p),
          Math.round(document.querySelector('.tg-margin-nav').getBoundingClientRect().top - p),
        ]);
      }
      return out;
    });
    for (const folded of [false, true]) {
      await page.evaluate((f) => window.margin.setCollapsed(f), folded);
      const seen = await tops();
      for (const s of seen) assert.deepEqual(s, seen[0], (folded ? 'folded: ' : 'open: ') + JSON.stringify(seen));
      assert.equal(seen[0][0], 10);
      assert.equal(seen[0][1], 34);
      // They are still buttons you can press there.
      await page.evaluate(() => { document.getElementById('pane').scrollTop = 1500; });
      const box = await page.locator('.tg-mnav-next').boundingBox();
      const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest('.tg-mnav-next'), [box.x + box.width / 2, box.y + box.height / 2]);
      assert.equal(hit, true);
    }
    // At the very end they stop with the text rather than hang below it (once the
    // text has its real height: blocks off screen only estimate theirs).
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { const pane = document.getElementById('pane'); pane.scrollTop = pane.scrollHeight; });
      await page.waitForTimeout(150);
    }
    const end = await page.evaluate(() => {
      const doc = document.getElementById('preview').getBoundingClientRect();
      return document.querySelector('.tg-margin-nav').getBoundingClientRect().bottom <= doc.bottom + 1;
    });
    assert.equal(end, true);
  } finally {
    await browser.close();
  }
});
